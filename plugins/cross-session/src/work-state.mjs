import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { CrossSessionError } from './errors.mjs';
import { createChecklist, validateChecklist, checklistSummary, reportChecklist, applyAttempt } from './work-checklist.mjs';

export const workStateFile = 'work-state-v1.json';
const maxBytes = 1048576, maxEntries = 128;
const statuses = ['active', 'paused', 'completed', 'blocked', 'canceled'];
const fields = { objective: 500, scope: 1000, completion_criteria: 1000, next_action: 1000, progress_evidence: 1000, completion_evidence: 1000 };
const invalid = () => new CrossSessionError('INVALID_ARGUMENT', 'Work state arguments are invalid.');
const unavailable = () => new CrossSessionError('WORK_STATE_UNAVAILABLE', 'The optional work state file is not available. Message tools remain available.');
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid();
  return value.trim();
}
export function validateWorkStateEntry(value, version = 2) {
  const keys = ['owner', 'revision', 'task_id', 'status', 'created_at', 'updated_at', ...Object.keys(fields), ...(version === 2 ? ['checklist'] : [])];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  text(value.owner, 200, true);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.task_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.task_id) || !statuses.includes(value.status)) throw invalid();
  for (const key of ['created_at', 'updated_at']) if (typeof value[key] !== 'string' || new Date(value[key]).toISOString() !== value[key]) throw invalid();
  for (const [key, limit] of Object.entries(fields)) text(value[key], limit, ['objective', 'scope', 'completion_criteria'].includes(key));
  if (value.status === 'completed' && !value.completion_evidence.trim()) throw invalid();
  if (version === 2) {
    validateChecklist(value.checklist);
    if (value.status === 'completed' && value.checklist !== null && !checklistSummary(value.checklist).can_complete) throw invalid();
  }
}
export function validateWorkStateFile(path) {
  let fd;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw invalid();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) throw invalid();
    const raw = readFileSync(fd);
    if (raw.length > maxBytes) throw invalid();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    if (!object(value) || Object.keys(value).length !== 2 || ![1, 2].includes(value.version) || !Array.isArray(value.states) || value.states.length > maxEntries) throw invalid();
    const seen = new Set();
    for (const entry of value.states) { validateWorkStateEntry(entry, value.version); if (seen.has(entry.owner)) throw invalid(); seen.add(entry.owner); }
    return value.states.map(entry => value.version === 1 ? { ...entry, checklist: null } : entry);
  } catch { throw unavailable(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

// This file stores reports. Runtime continuation eligibility is never restored.
export class WorkState {
  constructor(root, { enabled = process.env.CROSS_SESSION_CONTINUATION === '1', now = () => Date.now() } = {}) {
    this.path = join(root, workStateFile);
    this.enabled = enabled;
    this.now = now;
    this.states = new Map();
    this.runtime = new Map();
    this.loaded = false;
    this.failure = false;
  }
  load() {
    if (this.failure) throw unavailable();
    if (this.loaded) return;
    try {
      try { lstatSync(this.path); }
      catch (error) { if (error.code === 'ENOENT') { this.loaded = true; return; } throw error; }
      for (const entry of validateWorkStateFile(this.path)) {
        this.states.set(entry.owner, entry);
        if (!this.runtime.has(entry.owner)) this.runtime.set(entry.owner, this.newRuntime('restart'));
      }
      this.loaded = true;
    } catch { this.fail(); throw unavailable(); }
  }
  newRuntime(reason = null) {
    return { generation: randomUUID(), attempted: Boolean(reason), armed: false, revoked: Boolean(reason), revokeReason: reason, used: 0, startedAt: null, turnId: null };
  }
  runtimeFor(owner, create = false) {
    let runtime = this.runtime.get(owner);
    if (!runtime) { runtime = this.newRuntime(); if (create || this.states.has(owner)) this.runtime.set(owner, runtime); }
    if (runtime.armed && this.now() - runtime.startedAt >= 600000) this.revoke(owner, 'expired');
    return runtime;
  }
  revoke(owner, reason) {
    let runtime = this.runtime.get(owner);
    if (!runtime && ['Interrupt', 'SessionEnd'].includes(reason)) { runtime = this.newRuntime(reason); this.runtime.set(owner, runtime); }
    if (!runtime?.attempted) return;
    runtime.armed = false; runtime.revoked = true; runtime.revokeReason = reason;
  }
  fail() {
    this.failure = true;
    for (const owner of this.runtime.keys()) this.revoke(owner, 'storage_failure');
  }
  get(owner) {
    this.load();
    const runtime = this.runtimeFor(owner);
    const state = this.states.get(owner);
    return { revision: state?.revision ?? 0, state: state ? { ...structuredClone(state), checklist: reportChecklist(state.checklist) } : null, checklist_summary: checklistSummary(state?.checklist), completion_verified: false,
      continuation: { enabled: this.enabled, armed: runtime.armed, revoked: runtime.revoked, revoke_reason: runtime.revokeReason, used: runtime.used, limit: 1 } };
  }
  save(states) {
    const raw = JSON.stringify({ version: 2, states: [...states.values()] });
    if (Buffer.byteLength(raw) > maxBytes) throw new CrossSessionError('WORK_STATE_LIMIT', 'The work state file size limit was reached. No state was removed.');
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd;
    try {
      try { const stat = lstatSync(this.path); if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
    } catch { this.fail(); throw unavailable(); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* The temporary file can already be renamed. */ }
    }
  }
  set(owner, args) {
    this.load();
    const actionFields = {
      start: ['objective', 'scope', 'completion_criteria', 'next_action', 'checklist'],
      update: ['status', 'next_action', 'progress_evidence', 'completion_evidence'],
      set_checklist: ['checklist'], attempt_start: ['item_id', 'correction'],
      attempt_result: ['item_id', 'attempt_number', 'outcome', 'evidence', 'failure_cause']
    };
    if (!object(args) || !Object.hasOwn(actionFields, args.action) || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) throw invalid();
    const allowed = ['action', 'expected_revision', ...actionFields[args.action]];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw invalid();
    const previous = this.states.get(owner);
    if (args.expected_revision !== (previous?.revision ?? 0)) throw new CrossSessionError('WORK_STATE_CONFLICT', 'Read your current work state before an update.', { revision: previous?.revision ?? 0 });
    if (!previous && this.states.size >= maxEntries) throw new CrossSessionError('WORK_STATE_LIMIT', 'The work state owner limit was reached. No state was removed.');
    if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new CrossSessionError('WORK_STATE_LIMIT', 'The work state revision limit was reached.');
    const at = new Date(this.now()).toISOString();
    let entry;
    if (args.action === 'start') {
      if (previous && (previous.status !== 'completed' || (previous.checklist !== null && !checklistSummary(previous.checklist).can_complete))) throw new CrossSessionError('WORK_STATE_INCOMPLETE', 'Complete your current checklist before you start another work state.');
      entry = { owner, revision: (previous?.revision ?? 0) + 1, task_id: randomUUID(), status: 'active', created_at: at, updated_at: at, progress_evidence: '', completion_evidence: '' };
      for (const key of ['objective', 'scope', 'completion_criteria', 'next_action']) entry[key] = text(args[key], fields[key], true);
      entry.checklist = createChecklist(args.checklist);
    } else {
      if (!previous) throw new CrossSessionError('WORK_STATE_NOT_FOUND', 'Start your work state before an update.');
      entry = { ...structuredClone(previous), revision: previous.revision + 1, updated_at: at };
      if (args.action === 'update') {
        if (args.status !== undefined) { if (!statuses.includes(args.status)) throw invalid(); entry.status = args.status; }
        for (const key of ['next_action', 'progress_evidence', 'completion_evidence']) if (args[key] !== undefined) entry[key] = text(args[key], fields[key]);
        if (args.status === 'completed' && !checklistSummary(entry.checklist).can_complete) throw new CrossSessionError('WORK_STATE_INCOMPLETE', 'Completion requires evidence for every checklist item.');
      } else if (args.action === 'set_checklist') {
        if (entry.checklist !== null) throw new CrossSessionError('CHECKLIST_LOCKED', 'The checklist cannot be replaced.');
        if (entry.status !== 'active') throw new CrossSessionError('WORK_STATE_NOT_ACTIVE', 'A legacy checklist requires active work.');
        entry.checklist = createChecklist(args.checklist);
      } else applyAttempt(entry, args, at);
    }
    validateWorkStateEntry(entry);
    const runtime = this.runtimeFor(owner, true);
    const states = new Map(this.states); states.set(owner, entry);
    this.save(states); this.states = states;
    if (!runtime.attempted) {
      runtime.attempted = true;
      if (this.enabled) { runtime.armed = true; runtime.startedAt = this.now(); }
    }
    if (entry.status !== 'active') this.revoke(owner, 'state_changed');
    return this.get(owner);
  }
  hook(owner, input, journalAvailable = true) {
    const event = input.hook_event_name;
    // Revoke memory first. A failed file read cannot preserve runtime eligibility.
    if (['Interrupt', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'].includes(event)) this.revoke(owner, event);
    try { this.load(); } catch { /* Optional storage must not stop message tools. */ }
    if (['Interrupt', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'].includes(event)) this.revoke(owner, event);
    if (event !== 'Stop') return undefined;
    const runtime = this.runtimeFor(owner);
    const policy = reasonCode => ({ version: 1, decision: reasonCode === 'WORK_REMAINING' ? 'continue_work' : 'allow_stop', reasonCode, generation: runtime.generation, turnId: input.turn_id });
    if (typeof input.turn_id !== 'string' || !input.turn_id.trim() || input.turn_id.length > 200 || typeof input.stop_hook_active !== 'boolean') return undefined;
    if (!this.enabled || input.continuation_enabled !== true) return policy('DISABLED');
    if (this.failure || !journalAvailable) { this.revoke(owner, 'storage_failure'); return policy('STATE_UNAVAILABLE'); }
    if (runtime.revoked) return policy('REVOKED');
    const state = this.states.get(owner);
    if (!state || state.status !== 'active') return policy('NO_ACTIVE_WORK');
    if (!runtime.armed) return policy('NOT_ARMED');
    if (input.stop_hook_active) return policy('ALREADY_CONTINUED');
    const summary = checklistSummary(state.checklist);
    if (!state.next_action.trim() || !(summary.pending + summary.running + summary.retry_ready)) return policy('NO_NEXT_ACTION');
    if (runtime.turnId === input.turn_id) return policy('WORK_REMAINING');
    if (runtime.used >= 1) return policy('CONTINUATION_LIMIT');
    runtime.used++; runtime.turnId = input.turn_id;
    return policy('WORK_REMAINING');
  }
}
