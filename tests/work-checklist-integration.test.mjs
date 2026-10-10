import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, FakeNative } from './helpers.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { BrokerClient, settings } from '../plugins/cross-session/src/client.mjs';
import { WorkState, workStateFile } from '../plugins/cross-session/src/work-state.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../plugins/cross-session/src/cli.mjs', import.meta.url));
const checklist = [
  { title: 'Implement the owned change', expected_result: 'The requested behavior works', verification_method: 'Run the targeted behavior test' },
  { title: 'Verify the completed change', expected_result: 'The independent check passes', verification_method: 'Run the regression command' }
];
const begin = { action: 'start', objective: 'Complete the approved change', scope: 'Only the assigned files', completion_criteria: 'Complete both checklist items with evidence', next_action: 'Start the first checklist item', checklist };

async function setup(t, legacy) {
  let broker;
  const root = temporary(t, () => broker?.close());
  if (legacy) await writeFile(join(root, workStateFile), JSON.stringify({ version: 1, states: [legacy] }));
  const native = new FakeNative();
  const config = settings({ CROSS_SESSION_HOME: root });
  const restart = async () => {
    await broker?.close();
    broker = await startBroker({ config, native, intervalMs: 0 });
    broker.service.workState = new WorkState(root, { enabled: true });
  };
  await restart();
  const client = new BrokerClient({ config, autoStart: false });
  const get = (owner = 'session-a') => client.call('get_work_state', {}, owner);
  const update = async (args, owner = 'session-a') => client.call('set_work_state', { expected_revision: (await get(owner)).revision, ...args }, owner);
  const mcp = (name, args, owner = 'session-a') => handleMcp({ method: 'tools/call', params: { name, arguments: args, _meta: { sessionId: owner } } }, client);
  const cliCall = (name, args = {}, owner = 'session-a') => execute(process.execPath, [cli, name, ...Object.entries(args).flatMap(([key, value]) => [`--${key.replaceAll('_', '-')}`, typeof value === 'object' ? JSON.stringify(value) : String(value)])], {
    windowsHide: true, timeout: 10000, env: { ...process.env, CROSS_SESSION_HOME: root, CODEX_HOME: join(root, 'isolated-codex'), CODEX_THREAD_ID: owner }
  });
  const persisted = () => readFile(join(root, workStateFile), 'utf8');
  const rejectUnchanged = async (args, code, owner = 'session-a') => {
    const before = await persisted();
    const state = await get(owner);
    await assert.rejects(update(args, owner), error => error.code === code);
    assert.equal(await persisted(), before, 'A rejected mutation must not rewrite the state file');
    assert.deepEqual(await get(owner), state, 'A rejected mutation must not change the report or continuation budget');
  };
  return { root, native, client, get, update, mcp, cliCall, persisted, rejectUnchanged, restart };
}

function legacyState(status = 'active') {
  return { owner: 'session-a', revision: 3, task_id: '00000000-0000-4000-8000-000000000001', status,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    objective: 'Existing approved work', scope: 'Existing assigned files', completion_criteria: 'Existing review and checks', next_action: 'Run the remaining check',
    progress_evidence: 'Existing progress report', completion_evidence: status === 'completed' ? 'Existing final report' : '' };
}

test('CLI, HTTP, and MCP share fixed item IDs and require every item before completion', async t => {
  const f = await setup(t);
  const response = JSON.parse((await f.cliCall('set_work_state', { ...begin, expected_revision: 0 })).stdout);
  const ids = response.state.checklist.map(item => item.item_id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const report = await f.mcp('get_work_state', {});
  assert.equal(report.isError, false);
  assert.deepEqual(report.structuredContent.state.checklist.map(item => item.item_id), ids);
  assert.equal(report.structuredContent.completion_verified, false);
  await f.update({ action: 'attempt_start', item_id: ids[0] });
  await f.rejectUnchanged({ action: 'attempt_result', item_id: ids[1], attempt_number: 1, outcome: 'success', evidence: 'An unrelated item report' }, 'ATTEMPT_NOT_RUNNING');
  await f.update({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'success', evidence: 'The first behavior test passed' });
  await f.rejectUnchanged({ action: 'update', status: 'completed', completion_evidence: 'The first item was completed' }, 'WORK_STATE_INCOMPLETE');
  await f.rejectUnchanged({ action: 'attempt_start', item_id: ids[0], correction: 'Repeat a successful item' }, 'ITEM_COMPLETED');
  const snapshot = await f.get();
  const started = await f.mcp('set_work_state', { action: 'attempt_start', expected_revision: snapshot.revision, item_id: ids[1] });
  assert.equal(started.isError, false);
  const recorded = JSON.parse((await f.cliCall('set_work_state', { action: 'attempt_result', expected_revision: started.structuredContent.revision, item_id: ids[1], attempt_number: 1, outcome: 'success', evidence: 'The independent regression command passed' })).stdout);
  assert.equal(recorded.checklist_summary.can_complete, true);
  assert.equal(recorded.state.status, 'active', 'The final item report must not declare the whole goal complete');
  const completed = await f.update({ action: 'update', status: 'completed', completion_evidence: 'Both item reports were inspected' });
  assert.equal(completed.state.status, 'completed');
  assert.equal(completed.completion_verified, false, 'Structural completion must not claim independent evidence verification');
  assert.equal(f.native.sent.length, 0, 'Checklist changes must not deliver native messages');
});

test('four recorded attempts survive restart and exhaustion cannot be reset by replacing the goal', async t => {
  const f = await setup(t);
  const initial = await f.update(begin);
  const itemId = initial.state.checklist[0].item_id;
  for (let number = 1; number <= 4; number++) {
    const correction = number === 1 ? {} : { correction: `Change the implementation before attempt ${number}` };
    await f.update({ action: 'attempt_start', item_id: itemId, ...correction });
    let item = (await f.get()).state.checklist[0];
    assert.equal(item.status, 'running');
    assert.equal(item.attempts.length, number, 'Attempt consumption must be saved before any result');
    assert.equal(item.attempts.at(-1).attempt_number, number);
    assert.equal(item.attempts.at(-1).correction, correction.correction ?? '');
    if (number === 3) {
      const before = await f.persisted();
      await f.restart();
      const restored = (await f.get()).state.checklist[0];
      assert.equal(await f.persisted(), before);
      assert.equal(restored.status, 'running');
      assert.equal(restored.attempts.length, number);
      assert.equal(restored.attempts.at(-1).attempt_number, number);
      assert.equal(restored.attempts.at(-1).result, null, 'A restart must not invent a result for a consumed attempt');
    }
    await f.rejectUnchanged({ action: 'attempt_start', item_id: itemId, correction: 'Skip a pending result' }, 'ATTEMPT_PENDING');
    await f.rejectUnchanged({ action: 'attempt_result', item_id: itemId, attempt_number: number === 4 ? 1 : number + 1, outcome: 'failure', failure_cause: 'Wrong attempt report' }, 'ATTEMPT_NOT_RUNNING');
    await f.update({ action: 'attempt_result', item_id: itemId, attempt_number: number, outcome: 'failure', failure_cause: `Observed failure ${number}` });
    item = (await f.get()).state.checklist[0];
    assert.equal(item.attempts.at(-1).result.failure_cause, `Observed failure ${number}`);
    assert.equal(item.attempts.at(-1).correction, correction.correction ?? '', 'Recording a failure must preserve its prior correction');
    if (number === 2) {
      const before = await f.persisted();
      await f.restart();
      assert.equal(await f.persisted(), before);
      assert.equal((await f.get()).state.checklist[0].attempts.length, 2);
    }
  }
  const exhausted = await f.get();
  assert.equal(exhausted.state.checklist[0].status, 'blocked');
  assert.equal(exhausted.state.checklist[0].user_decision_required, true);
  assert.equal(exhausted.checklist_summary.user_decision_required, true);
  const visible = await f.mcp('get_work_state', {});
  assert.equal(visible.isError, false);
  assert.equal(visible.structuredContent.checklist_summary.user_decision_required, true);
  assert.match(visible.content[0].text, /Ask the user for a decision/i, 'The default MCP text must expose the exhausted item decision request');
  assert.equal(exhausted.state.status, 'active', 'Another pending item can still progress');
  await f.rejectUnchanged({ action: 'attempt_start', item_id: itemId, correction: 'A fifth attempt' }, 'ATTEMPT_LIMIT');
  await f.rejectUnchanged({ action: 'set_checklist', checklist: [...checklist].reverse() }, 'CHECKLIST_LOCKED');
  for (const status of ['active', 'paused', 'blocked', 'canceled']) {
    await f.update({ action: 'update', status });
    await f.rejectUnchanged({ ...begin, objective: 'A renamed goal', checklist: [checklist[1]] }, 'WORK_STATE_INCOMPLETE');
    assert.equal((await f.get()).state.checklist[0].attempts.length, 4);
  }
  await f.update({ action: 'update', status: 'active' });
  const secondId = (await f.get()).state.checklist[1].item_id;
  await f.update({ action: 'attempt_start', item_id: secondId });
  await f.update({ action: 'attempt_result', item_id: secondId, attempt_number: 1, outcome: 'success', evidence: 'The other item passed' });
  await f.rejectUnchanged({ action: 'update', status: 'completed', completion_evidence: 'Only the other item passed' }, 'WORK_STATE_INCOMPLETE');
});

test('concurrent starts consume one attempt and duplicate or stale results do not mutate reports', async t => {
  const f = await setup(t);
  const started = await f.update(begin), itemId = started.state.checklist[0].item_id;
  const args = { action: 'attempt_start', expected_revision: started.revision, item_id: itemId };
  const results = await Promise.allSettled([f.client.call('set_work_state', args, 'session-a'), f.client.call('set_work_state', args, 'session-a')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORK_STATE_CONFLICT');
  assert.equal((await f.get()).state.checklist[0].attempts.length, 1);
  await f.rejectUnchanged({ action: 'attempt_result', expected_revision: started.revision, item_id: itemId, attempt_number: 1, outcome: 'success', evidence: 'A stale report' }, 'WORK_STATE_CONFLICT');
  await f.update({ action: 'attempt_result', item_id: itemId, attempt_number: 1, outcome: 'failure', failure_cause: 'A current failed check' });
  await f.rejectUnchanged({ action: 'attempt_result', item_id: itemId, attempt_number: 1, outcome: 'success', evidence: 'Overwrite the failed result' }, 'ATTEMPT_NOT_RUNNING');
  await f.rejectUnchanged({ action: 'attempt_start', item_id: itemId }, 'INVALID_ARGUMENT');
  const retry = await f.update({ action: 'attempt_start', item_id: itemId, correction: 'Use a different implementation' });
  assert.equal(retry.state.checklist[0].attempts[0].result.failure_cause, 'A current failed check');
  assert.equal(retry.state.checklist[0].attempts[1].correction, 'Use a different implementation');
});

test('legacy state reads without mutation and upgrades once with its original report intact', async t => {
  const legacy = legacyState();
  const f = await setup(t, legacy), before = await f.persisted();
  const report = await f.get();
  assert.equal(report.state.task_id, legacy.task_id);
  assert.equal(report.state.progress_evidence, legacy.progress_evidence);
  assert.equal(await f.persisted(), before, 'Reading a legacy report must not migrate the file');
  await f.rejectUnchanged({ action: 'update', status: 'completed', completion_evidence: 'An unsupported shortcut' }, 'WORK_STATE_INCOMPLETE');
  const migrated = await f.update({ action: 'set_checklist', checklist });
  assert.equal(migrated.state.task_id, legacy.task_id);
  assert.equal(migrated.state.progress_evidence, legacy.progress_evidence);
  assert.equal(JSON.parse(await f.persisted()).version, 2);
  const ids = migrated.state.checklist.map(item => item.item_id);
  await f.restart();
  assert.deepEqual((await f.get()).state.checklist.map(item => item.item_id), ids);
  await f.rejectUnchanged({ action: 'set_checklist', checklist }, 'CHECKLIST_LOCKED');
});

test('completed legacy reports remain readable and malformed CLI checklist cannot overwrite them', async t => {
  const legacy = legacyState('completed'), f = await setup(t, legacy), before = await f.persisted();
  assert.equal((await f.get()).state.status, 'completed');
  assert.equal((await f.get()).state.completion_evidence, legacy.completion_evidence);
  await f.rejectUnchanged({ action: 'set_checklist', checklist }, 'WORK_STATE_NOT_ACTIVE');
  await assert.rejects(f.cliCall('set_work_state', { action: 'set_checklist', expected_revision: legacy.revision, checklist: 'not-json' }), error => error.code === 1);
  assert.equal(await f.persisted(), before);
  await f.update(begin, 'session-b');
  assert.equal(JSON.parse(await f.persisted()).version, 2);
  await f.restart();
  const preserved = (await f.get()).state;
  assert.equal(preserved.task_id, legacy.task_id);
  assert.equal(preserved.status, 'completed');
  assert.equal(preserved.completion_evidence, legacy.completion_evidence, 'Migrating a different owner must preserve the completed legacy report');
});

test('item IDs remain scoped to their owner and malformed MCP evidence cannot finish an attempt', async t => {
  const f = await setup(t);
  const a = await f.update(begin), b = await f.update(begin, 'session-b');
  const itemId = a.state.checklist[0].item_id;
  await f.rejectUnchanged({ action: 'attempt_start', item_id: b.state.checklist[0].item_id }, 'CHECKLIST_ITEM_NOT_FOUND');
  await f.rejectUnchanged({ action: 'attempt_start', item_id: itemId, owner: 'session-b' }, 'INVALID_ARGUMENT');
  const running = await f.update({ action: 'attempt_start', item_id: itemId });
  const before = await f.persisted();
  const bad = await f.mcp('set_work_state', { action: 'attempt_result', expected_revision: running.revision, item_id: itemId, attempt_number: 1, outcome: 'success', evidence: '   ' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, 'INVALID_ARGUMENT');
  assert.equal(await f.persisted(), before);
  assert.equal((await f.get()).state.checklist[0].status, 'running');
  assert.deepEqual((await f.get('session-b')).state, b.state);
});

test('Interrupt permits a late report but never restores Stop eligibility across restart', async t => {
  const f = await setup(t);
  const initial = await f.update(begin), itemId = initial.state.checklist[0].item_id;
  await f.update({ action: 'attempt_start', item_id: itemId });
  await f.client.hook({ session_id: 'session-a', hook_event_name: 'Interrupt' });
  await f.update({ action: 'attempt_result', item_id: itemId, attempt_number: 1, outcome: 'success', evidence: 'A check finished after the user interrupt' });
  assert.equal((await f.get()).continuation.revoked, true);
  const stop = { session_id: 'session-a', hook_event_name: 'Stop', turn_id: 'late-checklist-turn', stop_hook_active: false, continuation_enabled: true };
  assert.equal((await f.client.hook(stop)).stopPolicy.decision, 'allow_stop');
  assert.equal((await f.get()).continuation.used, 0);
  await f.restart();
  assert.equal((await f.client.hook(stop)).stopPolicy.decision, 'allow_stop');
  await f.rejectUnchanged({ action: 'update', status: 'completed', completion_evidence: 'A late partial result' }, 'WORK_STATE_INCOMPLETE');
  assert.equal(f.native.sent.length, 0);
});

test('all exhausted items block the report and optional file corruption does not break message delivery', async t => {
  const f = await setup(t), initial = await f.update({ ...begin, checklist: [checklist[0]] });
  const itemId = initial.state.checklist[0].item_id;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await f.update({ action: 'attempt_start', item_id: itemId, ...(attempt > 1 ? { correction: `Change ${attempt}` } : {}) });
    await f.update({ action: 'attempt_result', item_id: itemId, attempt_number: attempt, outcome: 'failure', failure_cause: `Failure ${attempt}` });
  }
  assert.equal((await f.get()).state.status, 'blocked');
  assert.equal((await f.get()).checklist_summary.user_decision_required, true);
  const stop = { session_id: 'session-a', hook_event_name: 'Stop', turn_id: 'exhausted-turn', stop_hook_active: false, continuation_enabled: true };
  assert.equal((await f.client.hook(stop)).stopPolicy.decision, 'allow_stop');
  assert.equal((await f.get()).continuation.used, 0);
  await writeFile(join(f.root, workStateFile), '{malformed optional report');
  await f.restart();
  await assert.rejects(f.get(), error => error.code === 'WORK_STATE_UNAVAILABLE');
  const delivered = await f.client.call('send_message', { to: 'session-b', message: 'An optional checklist failure must preserve messaging' }, 'session-a');
  assert.equal(delivered.accepted ?? delivered.delivery?.accepted, true);
  assert.equal(f.native.sent.length, 1);
});
