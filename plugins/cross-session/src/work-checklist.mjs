import { randomUUID } from 'node:crypto';
import { CrossSessionError } from './errors.mjs';

const invalid = () => new CrossSessionError('INVALID_ARGUMENT', 'Checklist arguments are invalid.');
const fail = (code, message) => { throw new CrossSessionError(code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function text(value, limit, required = true) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid();
  return value.trim();
}
function date(value) { if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw invalid(); }
const limits = { title: 200, expected_result: 500, verification_method: 500 };
export function createChecklist(value) {
  if (value === undefined) fail('CHECKLIST_REQUIRED', 'Start requires a checklist.');
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw invalid();
  return value.map(item => {
    exact(item, Object.keys(limits));
    return { item_id: randomUUID(), ...Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, text(item[key], limit)])), attempts: [] };
  });
}
export function validateChecklist(value) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw invalid();
  const ids = new Set();
  for (const item of value) {
    exact(item, ['item_id', ...Object.keys(limits), 'attempts']);
    if (typeof item.item_id !== 'string' || !uuid.test(item.item_id) || ids.has(item.item_id)) throw invalid();
    ids.add(item.item_id);
    for (const [key, limit] of Object.entries(limits)) text(item[key], limit);
    if (!Array.isArray(item.attempts) || item.attempts.length > 4) throw invalid();
    for (let i = 0; i < item.attempts.length; i++) {
      const attempt = item.attempts[i];
      exact(attempt, ['attempt_number', 'started_at', 'correction', 'result']);
      if (attempt.attempt_number !== i + 1) throw invalid();
      date(attempt.started_at); text(attempt.correction, 1000, i > 0);
      if (i === 0 && attempt.correction !== '') throw invalid();
      if (attempt.result === null) { if (i !== item.attempts.length - 1) throw invalid(); continue; }
      const result = attempt.result;
      if (!['success', 'failure'].includes(result?.outcome)) throw invalid();
      const key = result.outcome === 'success' ? 'evidence' : 'failure_cause';
      exact(result, ['outcome', 'recorded_at', key]); date(result.recorded_at); text(result[key], 1000);
      if (result.outcome === 'success' && i !== item.attempts.length - 1) throw invalid();
    }
  }
}
export function itemStatus(item) {
  const last = item.attempts.at(-1);
  if (!last) return 'pending';
  if (!last.result) return 'running';
  if (last.result.outcome === 'success') return 'completed';
  return item.attempts.length === 4 ? 'blocked' : 'retry_ready';
}
export function checklistSummary(value) {
  const result = { total: value?.length ?? 0, completed: 0, blocked: 0, running: 0, retry_ready: 0, pending: 0, can_complete: false, user_decision_required: false };
  for (const item of value ?? []) result[itemStatus(item)]++;
  result.can_complete = result.total > 0 && result.completed === result.total;
  result.user_decision_required = result.blocked > 0;
  return result;
}
export function reportChecklist(value) {
  return value?.map(item => ({ ...structuredClone(item), status: itemStatus(item), user_decision_required: itemStatus(item) === 'blocked' })) ?? null;
}
export function applyAttempt(entry, args, at) {
  if (entry.status !== 'active') fail('WORK_STATE_NOT_ACTIVE', 'Attempt changes require active work.');
  if (typeof args.item_id !== 'string') throw invalid();
  const item = entry.checklist?.find(item => item.item_id === args.item_id);
  if (!item) fail('CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found in your work state.');
  const last = item.attempts.at(-1);
  if (args.action === 'attempt_start') {
    if (last?.result === null) fail('ATTEMPT_PENDING', 'Record the running attempt result first.');
    if (itemStatus(item) === 'completed') fail('ITEM_COMPLETED', 'The checklist item is already complete.');
    if (item.attempts.length >= 4) fail('ATTEMPT_LIMIT', 'The item has no attempts left. A user decision is required.');
    if (!last && args.correction !== undefined) throw invalid();
    const correction = last ? text(args.correction, 1000) : '';
    item.attempts.push({ attempt_number: item.attempts.length + 1, started_at: at, correction, result: null });
  } else {
    if (!Number.isSafeInteger(args.attempt_number) || args.attempt_number < 1 || args.attempt_number > 4 || !['success', 'failure'].includes(args.outcome)) throw invalid();
    if (!last || last.result !== null || last.attempt_number !== args.attempt_number) fail('ATTEMPT_NOT_RUNNING', 'The result must match your running attempt.');
    const key = args.outcome === 'success' ? 'evidence' : 'failure_cause';
    const unused = args.outcome === 'success' ? 'failure_cause' : 'evidence';
    if (Object.hasOwn(args, unused)) throw invalid();
    last.result = { outcome: args.outcome, recorded_at: at, [key]: text(args[key], 1000) };
    const summary = checklistSummary(entry.checklist);
    if (summary.blocked > 0 && summary.completed + summary.blocked === summary.total) entry.status = 'blocked';
  }
}
