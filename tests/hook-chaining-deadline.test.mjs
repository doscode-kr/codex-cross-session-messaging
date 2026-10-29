import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { authToken } from '../plugins/cross-session/src/client.mjs';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';

const owner = '12345678-0000-4000-8000-000000000001';
const hookPath = resolve('plugins/cross-session/src/hooks.mjs');

function writePreload(root) {
  const path = join(root, 'hook-deadline-preload.mjs');
  writeFileSync(path, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const delay = Number(process.env.CROSS_SESSION_TEST_FSYNC_DELAY_MS || 0);
if (process.argv[2] === '--chaining-child' && delay > 0) {
  const trace = process.env.CROSS_SESSION_TEST_TRACE;
  if (trace) fs.appendFileSync(trace, 'child\\n');
  const original = fs.fsyncSync;
  fs.fsyncSync = (...args) => {
    if (trace) fs.appendFileSync(trace, 'fsync\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    return original(...args);
  };
  syncBuiltinESMExports();
}
const fetchMode = process.env.CROSS_SESSION_TEST_FETCH_MODE;
if (process.argv[2] !== '--chaining-child' && fetchMode) {
  globalThis.fetch = async (url, init = {}) => {
    const fetchDelay = Number(process.env.CROSS_SESSION_TEST_FETCH_DELAY_MS || 0);
    if (fetchDelay > 0) await new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(resolveWait, fetchDelay);
      const abort = () => { clearTimeout(timer); rejectWait(init.signal?.reason || Error('aborted')); };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
    });
    const request = JSON.parse(init.body);
    const body = String(url).endsWith('/health') ? { instance: request.instance }
      : fetchMode === 'policy' ? { stopPolicy: { version: 1, decision: 'continue_work', reasonCode: 'WORK_REMAINING',
          generation: process.env.CROSS_SESSION_TEST_OWNER, turnId: request.input.turn_id } } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
`);
  return path;
}

async function sessionFixture(root, event) {
  const state = join(root, event.toLowerCase());
  mkdirSync(state);
  await new SessionContinuity(state).ensureOwnSession(owner, { project: state });
  const transcript = join(state, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: owner, cwd: state } }) + '\n');
  authToken(state);
  return {
    state,
    input: { session_id: owner, transcript_path: transcript, cwd: state, hook_event_name: event,
      ...(event === 'Stop' ? { turn_id: 'turn', stop_hook_active: false } : {}) }
  };
}

async function runHookProcess(t, preload, fixture, extraEnv = {}, killAfterMs = 6000) {
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, hookPath], {
    windowsHide: true,
    env: { ...process.env, CROSS_SESSION_HOME: fixture.state, CROSS_SESSION_CONTINUATION: '1',
      CROSS_SESSION_TEST_OWNER: owner, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '', killed = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterMs);
  child.stdin.end(JSON.stringify(fixture.input));
  const code = await new Promise((resolveClose, rejectClose) => {
    child.once('close', resolveClose);
    child.once('error', rejectClose);
  }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr, killed, elapsed: Date.now() - started };
}

function assertProcessBudget(result, event, timeoutMs) {
  assert.equal(result.killed, false, `${event} hook process did not close on its own.`);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.elapsed < timeoutMs, `${event} hook process took ${result.elapsed} ms; limit is ${timeoutMs} ms.`);
  const output = JSON.parse(result.stdout);
  if (event === 'Stop') {
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /get_work_state/);
  } else assert.deepEqual(output, {});
}

test('normal SessionEnd saves and closes inside the three-second process budget', { timeout: 10000 }, async t => {
  const root = temporary(t), preload = writePreload(root);
  const fixture = await sessionFixture(root, 'SessionEnd');
  const result = await runHookProcess(t, preload, fixture, { CROSS_SESSION_TEST_FETCH_MODE: 'success' });
  t.diagnostic(`SessionEnd normal process elapsed: ${result.elapsed} ms`);
  assertProcessBudget(result, 'SessionEnd', 3000);
  assert.equal(result.stderr, '');
  const status = await new SessionContinuity(fixture.state).status(owner, { project: fixture.state });
  assert.equal(status.status, 'closed');
  assert.ok(status.session.latest_checkpoint_id, 'SessionEnd must publish its checkpoint before the process closes.');
});

test('slow checkpoint I/O fails safely and releases its lock inside the SessionEnd budget', { timeout: 10000 }, async t => {
  const root = temporary(t), preload = writePreload(root);
  const fixture = await sessionFixture(root, 'SessionEnd');
  const trace = join(root, 'slow-fsync-trace.txt');
  const result = await runHookProcess(t, preload, fixture, {
    CROSS_SESSION_TEST_FETCH_MODE: 'success', CROSS_SESSION_TEST_FSYNC_DELAY_MS: '2500',
    CROSS_SESSION_TEST_TRACE: trace
  });
  t.diagnostic(`SessionEnd slow checkpoint process elapsed: ${result.elapsed} ms`);
  assertProcessBudget(result, 'SessionEnd', 3000);
  assert.match(result.stderr, /cross-session continuity: CHAINING_TIMEOUT\./);
  const continuity = join(fixture.state, 'session-continuity-v1');
  assert.equal(existsSync(join(continuity, 'write.lock')), false,
    'The terminated checkpoint child must not leave its continuity lock behind.');
  const checkpointNames = readdirSync(join(continuity, 'checkpoints'));
  assert.ok(checkpointNames.every(name => name.endsWith('.tmp')),
    'A timed-out checkpoint must not publish a final checkpoint file.');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['child', 'fsync'],
    'A timed-out checkpoint must not spawn or attempt the write again.');
  const status = await new SessionContinuity(fixture.state).status(owner, { project: fixture.state });
  assert.equal(status.status, 'active');
  assert.equal(status.session.latest_checkpoint_id, null);
});

test('SessionEnd and Interrupt close inside three seconds when the broker stalls', { timeout: 15000 }, async t => {
  const root = temporary(t), preload = writePreload(root);
  for (const event of ['SessionEnd', 'Interrupt']) {
    const fixture = await sessionFixture(root, event);
    const result = await runHookProcess(t, preload, fixture, {
      CROSS_SESSION_TEST_FETCH_MODE: 'success', CROSS_SESSION_TEST_FETCH_DELAY_MS: '5000',
      ...(event === 'SessionEnd' ? { CROSS_SESSION_TEST_FSYNC_DELAY_MS: '500' } : {})
    });
    t.diagnostic(`${event} stalled broker process elapsed: ${result.elapsed} ms`);
    assertProcessBudget(result, event, 3000);
    assert.match(result.stderr, /cross-session hook: unavailable/);
    if (event === 'SessionEnd') {
      const status = await new SessionContinuity(fixture.state).status(owner, { project: fixture.state });
      assert.equal(status.status, 'closed', 'The checkpoint child and stalled broker must run concurrently.');
    }
  }
});

test('Stop keeps its five-second process budget and saves through slow checkpoint I/O', { timeout: 10000 }, async t => {
  const root = temporary(t), preload = writePreload(root);
  const fixture = await sessionFixture(root, 'Stop');
  const result = await runHookProcess(t, preload, fixture, {
    CROSS_SESSION_TEST_FETCH_MODE: 'policy', CROSS_SESSION_TEST_FSYNC_DELAY_MS: '500'
  });
  t.diagnostic(`Stop slow checkpoint process elapsed: ${result.elapsed} ms`);
  assertProcessBudget(result, 'Stop', 5000);
  assert.equal(result.stderr, '');
  const status = await new SessionContinuity(fixture.state).status(owner, { project: fixture.state });
  assert.equal(status.status, 'active');
  assert.ok(status.session.latest_checkpoint_id, 'Stop must publish its checkpoint before the process closes.');
});
