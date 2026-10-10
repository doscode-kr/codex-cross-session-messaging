import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { WorkState, validateWorkStateFile, workStateFile } from '../plugins/cross-session/src/work-state.mjs';
import { dirname } from 'node:path';
import { temporary } from './helpers.mjs';
import { validateTool, summarizeResult } from '../plugins/cross-session/src/mcp.mjs';
import { parseCliArgs } from '../plugins/cross-session/src/cli-args.mjs';

const checklist = [{ title: 'Review', expected_result: 'No open defects', verification_method: 'Independent review' }, { title: 'Tests', expected_result: 'All required checks pass', verification_method: 'Run tests' }];
const start = { action: 'start', expected_revision: 0, objective: 'Approved work', scope: 'Approved files', completion_criteria: 'Review and tests', next_action: 'Run review', checklist };
const stop = { hook_event_name: 'Stop', turn_id: 'turn', stop_hook_active: false, continuation_enabled: true };
function setup(t) {
  const work = new WorkState(temporary(t), { enabled: true });
  work.set('a', start);
  const ids = work.get('a').state.checklist.map(item => item.item_id);
  const set = args => work.set('a', { expected_revision: work.get('a').revision, ...args });
  return { work, ids, set };
}
function failure(set, item_id, attempt_number) {
  set({ action: 'attempt_start', item_id, ...(attempt_number > 1 ? { correction: `Changed approach ${attempt_number}` } : {}) });
  return set({ action: 'attempt_result', item_id, attempt_number, outcome: 'failure', failure_cause: `Check failed ${attempt_number}` });
}

test('four recorded attempts exhaust one item while other work remains available', t => {
  const { work, ids, set } = setup(t);
  for (let n = 1; n <= 4; n++) failure(set, ids[0], n);
  const report = work.get('a');
  assert.equal(report.state.status, 'active');
  assert.equal(report.state.checklist[0].status, 'blocked');
  assert.equal(report.checklist_summary.user_decision_required, true);
  assert.equal(report.checklist_summary.pending, 1);
  assert.match(summarizeResult('get_work_state', report), /Ask the user for a decision/u);
  const before = readFileSync(work.path);
  assert.throws(() => set({ action: 'attempt_start', item_id: ids[0], correction: 'Fifth attempt' }), { code: 'ATTEMPT_LIMIT' });
  assert.deepEqual(readFileSync(work.path), before);
  assert.equal(work.hook('a', stop).decision, 'continue_work');
  set({ action: 'attempt_start', item_id: ids[1] });
  set({ action: 'attempt_result', item_id: ids[1], attempt_number: 1, outcome: 'success', evidence: 'Test output' });
  assert.equal(work.get('a').state.status, 'blocked');
  assert.equal(work.get('a').checklist_summary.can_complete, false);
  assert.equal(work.hook('a', stop).decision, 'allow_stop');
});

test('all exhausted items stop without consuming continuation and cannot reset through status or task changes', t => {
  const { work, ids, set } = setup(t);
  for (const id of ids) for (let n = 1; n <= 4; n++) failure(set, id, n);
  assert.equal(work.get('a').state.status, 'blocked');
  assert.equal(work.hook('a', stop).decision, 'allow_stop');
  assert.equal(work.get('a').continuation.used, 0);
  for (const status of ['paused', 'canceled', 'active']) {
    set({ action: 'update', status });
    assert.throws(() => work.set('a', { ...start, expected_revision: work.get('a').revision, objective: 'Renamed work' }), { code: 'WORK_STATE_INCOMPLETE' });
  }
  assert.throws(() => set({ action: 'set_checklist', checklist }), { code: 'CHECKLIST_LOCKED' });
  assert.throws(() => set({ action: 'attempt_start', item_id: ids[0], correction: 'Reset' }), { code: 'ATTEMPT_LIMIT' });
  const restored = new WorkState(dirname(work.path), { enabled: true });
  assert.equal(restored.get('a').state.checklist[0].attempts.length, 4);
  assert.equal(restored.get('a').continuation.armed, false);
});

test('pending reservation, exact result number, evidence, and retry correction cannot be bypassed', t => {
  const { work, ids, set } = setup(t);
  set({ action: 'attempt_start', item_id: ids[0] });
  const before = readFileSync(work.path);
  const reject = (args, code) => { assert.throws(() => set(args), { code }); assert.deepEqual(readFileSync(work.path), before); };
  reject({ action: 'attempt_start', item_id: ids[0] }, 'ATTEMPT_PENDING');
  reject({ action: 'attempt_result', item_id: ids[0], attempt_number: 2, outcome: 'success', evidence: 'Wrong attempt' }, 'ATTEMPT_NOT_RUNNING');
  reject({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'success', evidence: ' ' }, 'INVALID_ARGUMENT');
  reject({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'failure', failure_cause: 'Failure', correction: 'Unused' }, 'INVALID_ARGUMENT');
  reject({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'failure', failure_cause: 'Failure', evidence: 'Unused' }, 'INVALID_ARGUMENT');
  set({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'failure', failure_cause: 'Actual cause' });
  assert.throws(() => set({ action: 'attempt_start', item_id: ids[0] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => set({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'failure', failure_cause: 'Duplicate' }), { code: 'ATTEMPT_NOT_RUNNING' });
});

test('item evidence gates global completion and new work does not restore continuation', t => {
  const { work, ids, set } = setup(t);
  assert.throws(() => set({ action: 'update', status: 'completed', completion_evidence: 'Only a claim' }), { code: 'WORK_STATE_INCOMPLETE' });
  for (const id of ids) {
    set({ action: 'attempt_start', item_id: id });
    set({ action: 'attempt_result', item_id: id, attempt_number: 1, outcome: 'success', evidence: 'Inspect the result' });
    assert.throws(() => set({ action: 'attempt_start', item_id: id }), { code: 'ITEM_COMPLETED' });
  }
  assert.equal(work.get('a').checklist_summary.can_complete, true);
  assert.equal(work.hook('a', stop).reasonCode, 'NO_NEXT_ACTION');
  assert.equal(work.get('a').continuation.used, 0);
  assert.throws(() => set({ action: 'update', status: 'completed' }), { code: 'INVALID_ARGUMENT' });
  set({ action: 'update', status: 'completed', completion_evidence: 'Independent result and checks' });
  const next = work.set('a', { ...start, expected_revision: work.get('a').revision });
  assert.notEqual(next.state.checklist[0].item_id, ids[0]);
  assert.equal(next.continuation.armed, false);
  assert.equal(next.completion_verified, false);
});

test('returned nested reports and failed attempt writes cannot mutate stored memory', t => {
  const { work, ids, set } = setup(t);
  const report = work.get('a');
  report.state.checklist[0].attempts.push({ result: { outcome: 'success' } });
  report.state.checklist[0].title = 'Changed';
  assert.equal(work.get('a').state.checklist[0].title, checklist[0].title);
  assert.equal(work.get('a').state.checklist[0].attempts.length, 0);
  const save = work.save;
  work.save = () => { throw new Error('Injected write failure'); };
  assert.throws(() => set({ action: 'attempt_start', item_id: ids[0] }), /Injected write failure/u);
  work.save = save;
  assert.equal(work.get('a').revision, 1);
  assert.equal(work.get('a').state.checklist[0].attempts.length, 0);
});

test('legacy reads do not write and migration preserves other owner reports', t => {
  const { work } = setup(t);
  const legacy = JSON.parse(readFileSync(work.path));
  legacy.version = 1;
  delete legacy.states[0].checklist;
  writeFileSync(work.path, JSON.stringify(legacy));
  const before = readFileSync(work.path);
  const restored = new WorkState(dirname(work.path), { enabled: true });
  assert.equal(restored.get('a').state.checklist, null);
  assert.deepEqual(readFileSync(work.path), before);
  assert.throws(() => restored.set('a', { action: 'update', expected_revision: 1, status: 'completed', completion_evidence: 'Old shortcut' }), { code: 'WORK_STATE_INCOMPLETE' });
  restored.set('b', start);
  assert.equal(JSON.parse(readFileSync(work.path)).version, 2);
  assert.equal(restored.get('a').state.checklist, null);
  restored.set('a', { action: 'set_checklist', expected_revision: 1, checklist });
  assert.equal(restored.get('a').continuation.armed, false);
  assert.equal(validateWorkStateFile(work.path).length, 2);
});

test('new work requires bounded checklist definitions and accepts no client item IDs', t => {
  const work = new WorkState(temporary(t), { enabled: true });
  const { checklist: ignored, ...withoutChecklist } = start;
  assert.throws(() => work.set('a', withoutChecklist), { code: 'CHECKLIST_REQUIRED' });
  for (const value of [null, [], Array(21).fill(checklist[0]), [{ ...checklist[0], item_id: 'client-id' }], [{ ...checklist[0], expected_result: ' ' }], [{ ...checklist[0], title: 'x'.repeat(201) }], [{ ...checklist[0], verification_method: 'x'.repeat(501) }]]) {
    assert.throws(() => work.set('a', { ...start, checklist: value }), { code: 'INVALID_ARGUMENT' });
    assert.equal(work.get('a').revision, 0);
  }
  const accepted = work.set('a', { ...start, checklist: Array(20).fill(checklist[0]) });
  assert.equal(new Set(accepted.state.checklist.map(item => item.item_id)).size, 20);
});

test('Interrupt permits late active results without rearming; paused and canceled reports reject attempt changes', t => {
  const { work, ids, set } = setup(t);
  set({ action: 'attempt_start', item_id: ids[0] });
  work.hook('a', { hook_event_name: 'Interrupt' });
  for (const status of ['paused', 'canceled', 'blocked']) {
    set({ action: 'update', status });
    assert.throws(() => set({ action: 'attempt_start', item_id: ids[1] }), { code: 'WORK_STATE_NOT_ACTIVE' });
    assert.throws(() => set({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'success', evidence: 'Late result' }), { code: 'WORK_STATE_NOT_ACTIVE' });
    assert.equal(work.get('a').state.checklist[0].status, 'running');
  }
  set({ action: 'update', status: 'active' });
  set({ action: 'attempt_result', item_id: ids[0], attempt_number: 1, outcome: 'success', evidence: 'Late result' });
  assert.equal(work.get('a').state.checklist[0].status, 'completed');
  assert.equal(work.hook('a', stop).reasonCode, 'REVOKED');
  assert.equal(work.get('a').continuation.used, 0);
});

test('legacy checklist installation is active-only and permitted once', t => {
  const { work } = setup(t);
  const legacy = JSON.parse(readFileSync(work.path));
  legacy.version = 1; delete legacy.states[0].checklist;
  for (const status of ['paused', 'canceled', 'blocked', 'completed']) {
    legacy.states[0].status = status;
    legacy.states[0].completion_evidence = status === 'completed' ? 'Old completed report' : '';
    writeFileSync(work.path, JSON.stringify(legacy));
    const restored = new WorkState(dirname(work.path), { enabled: true });
    assert.equal(restored.get('a').state.status, status);
    assert.throws(() => restored.set('a', { action: 'set_checklist', expected_revision: 1, checklist }), { code: 'WORK_STATE_NOT_ACTIVE' });
  }
  legacy.states[0].status = 'active'; legacy.states[0].completion_evidence = '';
  writeFileSync(work.path, JSON.stringify(legacy));
  const restored = new WorkState(dirname(work.path), { enabled: true });
  restored.set('a', { action: 'set_checklist', expected_revision: 1, checklist });
  assert.throws(() => restored.set('a', { action: 'set_checklist', expected_revision: 2, checklist }), { code: 'CHECKLIST_LOCKED' });
  assert.equal(restored.path.endsWith(workStateFile), true);
});

test('strict version 2 reader rejects impossible attempt histories and extra keys', t => {
  const { work, ids, set } = setup(t);
  failure(set, ids[0], 1);
  const original = JSON.parse(readFileSync(work.path));
  for (const corrupt of [
    value => { value.states[0].checklist[0].attempts[0].attempt_number = 2; },
    value => { value.states[0].checklist[0].status = 'completed'; },
    value => { value.states[0].checklist[0].attempts[0].result.evidence = 'Extra'; },
    value => { value.states[0].checklist[0].attempts[0].correction = 'Initial correction'; },
    value => { value.states[0].checklist.push(structuredClone(value.states[0].checklist[0])); }
  ]) {
    const raw = structuredClone(original); corrupt(raw); writeFileSync(work.path, JSON.stringify(raw));
    assert.throws(() => validateWorkStateFile(work.path), { code: 'WORK_STATE_UNAVAILABLE' });
  }
});

test('CLI and recursive MCP schema reject malformed checklist values before transport', () => {
  const parsed = parseCliArgs(['--checklist', JSON.stringify(checklist), '--attempt-number', '2'], 'a');
  assert.deepEqual(parsed.args.checklist, checklist);
  assert.equal(parsed.args.attempt_number, 2);
  for (const raw of ['invalid', '{}', 'null']) assert.throws(() => parseCliArgs(['--checklist', raw], 'a'), { code: 'INVALID_ARGUMENT' });
  validateTool('set_work_state', start);
  for (const value of [[], Array(21).fill(checklist[0]), [{ ...checklist[0], item_id: 'supplied' }], [{ ...checklist[0], title: 3 }], [{ title: 'Missing' }]]) {
    assert.throws(() => validateTool('set_work_state', { ...start, checklist: value }), { code: 'INVALID_ARGUMENT' });
  }
});
