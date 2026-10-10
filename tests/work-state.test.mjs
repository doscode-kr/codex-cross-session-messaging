import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkState, validateWorkStateFile, workStateFile } from '../plugins/cross-session/src/work-state.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { temporary, fixture } from './helpers.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';
import { parseCliArgs } from '../plugins/cross-session/src/cli-args.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const start = (expected_revision = 0) => ({ action: 'start', expected_revision, objective: 'Finish the approved change', scope: 'Only the approved module', completion_criteria: 'Independent review and passing tests', next_action: 'Run the targeted tests' });
const stop = (turn_id = 'turn-1', stop_hook_active = false) => ({ hook_event_name: 'Stop', turn_id, stop_hook_active, continuation_enabled: true });
function enabled(t, options = {}) { return new WorkState(temporary(t), { enabled: true, ...options }); }

test('work reports are owner-only, bounded, revision checked, and not verified completion', t => {
  const work = enabled(t);
  assert.equal(work.get('a').revision, 0);
  assert.equal(work.set('a', start()).revision, 1);
  assert.equal(work.get('b').state, null);
  const before = readFileSync(work.path, 'utf8');
  assert.throws(() => work.set('a', { action: 'update', expected_revision: 0, next_action: 'bad' }), { code: 'WORK_STATE_CONFLICT' });
  assert.throws(() => work.set('a', { action: 'update', expected_revision: 1, scope: 'expanded' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => work.set('a', { action: 'update', expected_revision: 1, status: 'completed' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(readFileSync(work.path, 'utf8'), before);
  const completed = work.set('a', { action: 'update', expected_revision: 1, status: 'completed', completion_evidence: 'Test command and independent review record' });
  assert.equal(completed.completion_verified, false);
  assert.equal(completed.continuation.revoked, true);
  assert.equal(work.hook('a', stop()).reasonCode, 'REVOKED');
});

test('continuation requires both opt-ins and valid host fields', t => {
  const work = enabled(t);
  work.set('a', start());
  assert.equal(work.hook('a', { ...stop(), continuation_enabled: false }).reasonCode, 'DISABLED');
  assert.equal(work.hook('a', { ...stop(), continuation_enabled: 'true' }).reasonCode, 'DISABLED');
  for (const input of [{ ...stop(), turn_id: '' }, { ...stop(), turn_id: 1 }, { ...stop(), stop_hook_active: 'false' }, { ...stop(), turn_id: 'x'.repeat(201) }]) assert.equal(work.hook('a', input), undefined);
  const off = new WorkState(temporary(t), { enabled: false });
  off.set('a', start());
  assert.equal(off.hook('a', stop()).reasonCode, 'DISABLED');
  assert.equal(off.get('a').continuation.armed, false);
  assert.throws(() => work.set('a', { ...start(1), continuation_enabled: true }), { code: 'INVALID_ARGUMENT' });
});

test('one continuation cannot be reset by duplicate Stop, updates, or a new task', t => {
  const work = enabled(t);
  work.set('a', start());
  const first = work.hook('a', stop());
  assert.deepEqual(Object.keys(first).sort(), ['decision', 'generation', 'reasonCode', 'turnId', 'version']);
  assert.equal(first.decision, 'continue_work');
  assert.equal(first.reasonCode, 'WORK_REMAINING');
  assert.deepEqual(work.hook('a', stop()), first);
  assert.equal(work.hook('a', stop('turn-1', true)).reasonCode, 'ALREADY_CONTINUED');
  assert.equal(work.get('a').continuation.used, 1);
  work.set('a', { action: 'update', expected_revision: 1, progress_evidence: 'new report', next_action: 'Do the next check' });
  assert.equal(work.hook('a', stop('turn-2')).reasonCode, 'CONTINUATION_LIMIT');
  work.set('a', start(2));
  assert.equal(work.hook('a', stop('turn-3')).reasonCode, 'CONTINUATION_LIMIT');
  assert.equal(work.get('a').continuation.used, 1);
});

for (const event of ['Interrupt', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']) test(`${event} revokes before replay and tool calls cannot rearm`, t => {
  const work = enabled(t);
  work.set('a', start());
  work.hook('a', stop());
  work.hook('a', { hook_event_name: event });
  assert.equal(work.hook('a', stop()).reasonCode, 'REVOKED');
  work.set('a', start(1));
  work.set('a', { action: 'update', expected_revision: 2, status: 'active' });
  assert.equal(work.hook('a', stop('turn-2')).reasonCode, 'REVOKED');
  assert.equal(work.get('a').continuation.revoke_reason, event);
});

test('initial prompt does not block first activation; restart restores only a report', t => {
  const root = temporary(t);
  const work = new WorkState(root, { enabled: true });
  work.hook('a', { hook_event_name: 'SessionStart' });
  work.hook('a', { hook_event_name: 'UserPromptSubmit' });
  assert.equal(work.set('a', start()).continuation.armed, true);
  const restored = new WorkState(root, { enabled: true });
  assert.equal(restored.get('a').state.objective, start().objective);
  assert.equal(restored.get('a').continuation.revoke_reason, 'restart');
  assert.equal(restored.hook('a', stop()).reasonCode, 'REVOKED');
  restored.set('a', start(1));
  assert.equal(restored.hook('a', stop()).reasonCode, 'REVOKED');
});

for (const event of ['Interrupt', 'SessionEnd']) test(`${event} before the first report prevents a later activation`, t => {
  const work = enabled(t);
  work.hook('a', { hook_event_name: event });
  assert.equal(work.set('a', start()).continuation.armed, false);
  assert.equal(work.hook('a', stop()).reasonCode, 'REVOKED');
});

test('file loading preserves an Interrupt latch made before restore', t => {
  const root = temporary(t);
  new WorkState(root, { enabled: true }).set('a', start());
  const restored = new WorkState(root, { enabled: true });
  restored.revoke('a', 'Interrupt');
  assert.equal(restored.get('a').continuation.revoke_reason, 'Interrupt');
  restored.set('a', start(1));
  assert.equal(restored.hook('a', stop()).reasonCode, 'REVOKED');
});

test('ten-minute activation deadline cannot be moved by updates or start', t => {
  let now = 1000000;
  const work = enabled(t, { now: () => now });
  work.set('a', start());
  now += 599999;
  work.set('a', start(1));
  now++;
  assert.equal(work.hook('a', stop()).reasonCode, 'REVOKED');
  assert.equal(work.get('a').continuation.revoke_reason, 'expired');
});

test('next action removal prevents a duplicate block and state transitions revoke', t => {
  const work = enabled(t);
  work.set('a', start());
  work.hook('a', stop());
  work.set('a', { action: 'update', expected_revision: 1, next_action: '  ' });
  assert.equal(work.hook('a', stop()).reasonCode, 'NO_NEXT_ACTION');
  work.set('a', { action: 'update', expected_revision: 2, status: 'paused' });
  work.set('a', { action: 'update', expected_revision: 3, status: 'active', next_action: 'Do the check' });
  assert.equal(work.hook('a', stop()).reasonCode, 'REVOKED');
});

test('invalid state files are kept, fail open, and expose no file content', t => {
  for (const raw of ['private secret invalid JSON', JSON.stringify({ version: 99, states: [] }), JSON.stringify({ version: 1, states: [], extra: true }), Buffer.from([0xff]), 'x'.repeat(1048577)]) {
    const root = temporary(t);
    const path = join(root, workStateFile);
    writeFileSync(path, raw);
    const work = new WorkState(root, { enabled: true });
    assert.throws(() => work.get('a'), error => error.code === 'WORK_STATE_UNAVAILABLE' && !error.message.includes('private secret'));
    assert.equal(work.hook('a', stop()).reasonCode, 'STATE_UNAVAILABLE');
    assert.deepEqual(readFileSync(path), Buffer.from(raw));
    assert.throws(() => validateWorkStateFile(path), { code: 'WORK_STATE_UNAVAILABLE' });
  }
});

test('a failed optional write does not arm and removes its temporary file', t => {
  const work = enabled(t);
  work.get('a');
  mkdirSync(work.path);
  assert.throws(() => work.set('a', start()), { code: 'WORK_STATE_UNAVAILABLE' });
  assert.equal(work.runtime.get('a').armed, false);
  assert.equal(work.hook('a', stop()).reasonCode, 'STATE_UNAVAILABLE');
  assert.deepEqual(readdirSync(join(work.path, '..')), [workStateFile]);
});

for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) test(`${method} failure keeps the prior file and revokes continuation`, t => {
  const work = enabled(t);
  work.set('a', start());
  const before = readFileSync(work.path);
  const original = fs[method];
  fs[method] = () => { throw Object.assign(new Error('private device information'), { code: 'EIO' }); };
  syncBuiltinESMExports();
  try { assert.throws(() => work.set('a', { action: 'update', expected_revision: 1, next_action: 'New action' }), error => error.code === 'WORK_STATE_UNAVAILABLE' && !error.message.includes('private device')); }
  finally { fs[method] = original; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(work.path), before);
  assert.equal(work.runtime.get('a').armed, false);
  assert.equal(work.hook('a', stop()).reasonCode, 'STATE_UNAVAILABLE');
  assert.deepEqual(readdirSync(join(work.path, '..')), [workStateFile]);
});

test('owner cap never removes another owner and oversized updates keep the file', t => {
  const work = enabled(t);
  for (let i = 0; i < 128; i++) work.set(`owner-${i}`, start());
  const before = readFileSync(work.path);
  assert.throws(() => work.set('owner-129', start()), { code: 'WORK_STATE_LIMIT' });
  assert.throws(() => work.set('owner-0', { action: 'update', expected_revision: 1, next_action: 'x'.repeat(1001) }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(readFileSync(work.path), before);
  assert.equal(validateWorkStateFile(work.path).length, 128);
});

test('service serializes concurrent CAS and Stop, ignores subagents, and preserves messaging on optional failure', async t => {
  const { root, store, native } = fixture(t);
  const work = new WorkState(root, { enabled: true });
  const service = new MessagingService(store, native, work);
  const attempts = await Promise.allSettled([service.call('set_work_state', start(), 'session-a'), service.call('set_work_state', start(), 'session-a')]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.code, 'WORK_STATE_CONFLICT');
  assert.equal((await service.call('get_work_state', {}, 'session-b')).state, null);
  await assert.rejects(service.call('set_work_state', { ...start(), session_id: 'session-a' }, 'session-b'), { code: 'INVALID_ARGUMENT' });
  const inputs = Array.from({ length: 5 }, () => service.hook({ ...stop(), session_id: 'session-a' }));
  const policies = (await Promise.all(inputs)).map(value => value.stopPolicy);
  assert.ok(policies.every(value => value.decision === 'continue_work'));
  assert.equal(work.get('session-a').continuation.used, 1);
  assert.deepEqual(await service.hook({ ...stop(), session_id: 'session-a', agent_id: 'child' }), {});
  await service.hook({ hook_event_name: 'Interrupt', session_id: 'session-a' });
  assert.equal((await service.hook({ ...stop(), session_id: 'session-a' })).stopPolicy.reasonCode, 'REVOKED');
  work.fail();
  const sent = await service.call('send_message', { to: 'session-b', message: 'Message delivery remains available' }, 'session-a');
  assert.equal(sent.status, 'accepted');
  assert.equal(native.sent.length, 1);
  assert.ok(readFileSync(join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).every(line => !JSON.parse(line).type.startsWith('work')));
});

test('an Interrupt revokes an in-flight Stop before native refresh completes', async t => {
  const { root, store, native } = fixture(t);
  const work = new WorkState(root, { enabled: true });
  const service = new MessagingService(store, native, work);
  await service.call('set_work_state', start(), 'session-a');
  let release;
  native.list = () => new Promise(resolve => { release = () => resolve(native.threads); });
  const pendingStop = service.hook({ ...stop(), session_id: 'session-a' });
  const interrupt = service.hook({ hook_event_name: 'Interrupt', session_id: 'session-a' });
  release();
  assert.equal((await pendingStop).stopPolicy.reasonCode, 'REVOKED');
  await interrupt;
});

test('journal failure disables the Stop guard even with a healthy optional state', async t => {
  const { root, store, native } = fixture(t);
  const service = new MessagingService(store, native, new WorkState(root, { enabled: true }));
  await service.call('set_work_state', start(), 'session-a');
  store.failure = new Error('private storage detail');
  const result = await service.hook({ ...stop(), session_id: 'session-a' });
  assert.equal(result.stopPolicy.reasonCode, 'STATE_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('private storage detail'));
});

test('work report reads and writes do not change the message journal or leader', async t => {
  const { root, store, native } = fixture(t);
  store.record('leader', 'gone-session');
  const before = readFileSync(store.path);
  const service = new MessagingService(store, native, new WorkState(root, { enabled: true }));
  await service.call('get_work_state', {}, 'session-a');
  await service.call('set_work_state', start(), 'session-a');
  assert.deepEqual(readFileSync(store.path), before);
  assert.equal(store.leader, 'gone-session');
});

test('MCP and CLI expose reports without accepting identities or opt-in arguments', async t => {
  const { root, store, native } = fixture(t);
  const service = new MessagingService(store, native, new WorkState(root, { enabled: true }));
  const client = { call: (name, args, id) => service.call(name, args, id) };
  const request = args => ({ method: 'tools/call', params: { name: 'set_work_state', arguments: args, _meta: { sessionId: 'session-a' } } });
  assert.equal((await handleMcp(request({ ...start(), session_id: 'session-b' }), client)).isError, true);
  assert.equal((await handleMcp(request({ ...start(), continuation_enabled: true }), client)).isError, true);
  const saved = await handleMcp(request(start()), client);
  assert.equal(saved.isError, false);
  assert.match(saved.content[0].text, /Completion is not verified/u);
  assert.equal(saved.structuredContent.state.owner, 'session-a');
  const parsed = parseCliArgs(['--action', 'update', '--expected-revision', '1', '--next-action', 'Run the check'], 'session-a');
  assert.equal(parsed.args.expected_revision, 1);
  assert.equal((await service.call('set_work_state', parsed.args, parsed.sessionId)).revision, 2);
});
