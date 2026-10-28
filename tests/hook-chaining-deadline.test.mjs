import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';

test('slow native checkpoint I/O stays inside the five-second hook budget', { timeout: 15000 }, async t => {
  const root = temporary(t), owner = '12345678-0000-4000-8000-000000000001';
  const preload = join(root, 'slow-fsync.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
if (process.argv[2] === '--chaining-child') {
 const original = fs.fsyncSync;
 fs.fsyncSync = (...args) => {
  execFileSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600)'], { windowsHide: true });
  return original(...args);
 };
 syncBuiltinESMExports();
}
`);
  const source = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  for (const event of ['SessionEnd', 'Stop']) {
    const state = join(root, event); mkdirSync(state);
    await new SessionContinuity(state).ensureOwnSession(owner, { project: state });
    const transcript = join(state, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: owner, cwd: state } }) + '\n');
    const fixture = join(state, 'fixture.mjs');
    writeFileSync(fixture, `import { runHook } from ${JSON.stringify(source)};
const input = ${JSON.stringify({ session_id: owner, transcript_path: transcript, cwd: state, hook_event_name: event, turn_id: 'turn', stop_hook_active: false })};
const started = Date.now();
const result = await runHook(input, { hook: async () => ({stopPolicy:{version:1,decision:'continue_work',reasonCode:'WORK_REMAINING',generation:${JSON.stringify(owner)},turnId:'turn'}}) });
console.log(JSON.stringify({elapsed:Date.now()-started,result}));
`);
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fixture], { windowsHide: true, env: { ...process.env, CROSS_SESSION_HOME: state, CROSS_SESSION_CONTINUATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '', error = '';
    child.stdout.on('data', chunk => { raw += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, error);
    assert.ok(Date.now() - started < 5000, `${event} process exceeded five seconds under test-runner load`);
    const result = JSON.parse(raw);
    assert.ok(result.elapsed < 2600);
    assert.equal(existsSync(join(state, 'session-continuity-v1', 'write.lock')), false, 'A terminated child must not leave its own continuity lock behind.');
    if (event === 'Stop') assert.equal(result.result.decision, 'block');
    else assert.deepEqual(result.result, {});
  }
});
