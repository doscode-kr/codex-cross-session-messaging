import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHook } from '../plugins/cross-session/src/hooks.mjs';
import { temporary } from './helpers.mjs';

const input = { hook_event_name: 'Stop', session_id: 'owner', turn_id: 'turn-1', stop_hook_active: false };
const enabled = { CROSS_SESSION_CONTINUATION: '1' };
const policy = { version: 1, decision: 'continue_work', reasonCode: 'WORK_REMAINING', generation: '10000000-0000-4000-8000-000000000001', turnId: 'turn-1' };
const client = stopPolicy => ({ async hook() { return { stopPolicy }; } });

test('Stop accepts only the opted-in current policy and sends no work text as a user prompt', async () => {
  let request;
  const output = await runHook(input, { async hook(value) { request = value; return { stopPolicy: policy, nextAction: 'UNTRUSTED_ACTION' }; } }, enabled);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /get_work_state/);
  assert.ok(!output.reason.includes('UNTRUSTED_ACTION'));
  assert.deepEqual(request, { session_id: 'owner', permission_mode: undefined, hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false, continuation_enabled: true });
});

test('Stop allows old, unknown, mismatched, and malformed policies', async () => {
  const variants = [undefined, null, [], {}, { ...policy, version: 2 }, { ...policy, turnId: 'old' },
    { ...policy, generation: 'invalid' }, { ...policy, decision: 'allow_stop' },
    { ...policy, reasonCode: 'UNKNOWN' }, { ...policy, reason: 'PEER_COMMAND' }];
  for (const value of variants) assert.deepEqual(await runHook(input, client(value), enabled), {});
  for (const value of [{}, { CROSS_SESSION_CONTINUATION: 'true' }, { CROSS_SESSION_CONTINUATION: '0' }]) {
    assert.deepEqual(await runHook(input, client(policy), value), {});
  }
  for (const patch of [{ stop_hook_active: true }, { stop_hook_active: undefined }, { stop_hook_active: 'false' }, { turn_id: '' }, { turn_id: null }]) {
    assert.deepEqual(await runHook({ ...input, ...patch }, client(policy), enabled), {});
  }
});

test('Interrupt and subagent hooks cannot request continuation', async () => {
  assert.deepEqual(await runHook({ ...input, hook_event_name: 'Interrupt' }, client(policy), enabled), {});
  assert.deepEqual(await runHook({ ...input, agent_id: 'child' }, { hook() { throw Error('must not call'); } }, enabled), {});
});

test('Stop and Interrupt do not create broker state and errors do not expose input text', async t => {
  const root = temporary(t);
  for (const event of ['Stop', 'Interrupt']) {
    const state = join(root, event, 'PRIVATE_PATH');
    const child = spawn(process.execPath, [resolve('plugins/cross-session/src/hooks.mjs')], {
      windowsHide: true, env: { ...process.env, CROSS_SESSION_HOME: state, CROSS_SESSION_CONTINUATION: '1' }
    });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ ...input, hook_event_name: event }));
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 0);
    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(stderr.trim(), 'cross-session hook: unavailable; no stop restriction was applied.');
    assert.equal(existsSync(state), false);
  }
});
