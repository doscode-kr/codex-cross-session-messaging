import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkStateFile, workStateFile } from './work-state.mjs';
import {
  ChainingStore, chainingError, plainObject, releaseTerminatedChainingLock,
  releaseTerminatedContinuityLock, uuidPattern, validProject, validateCheckpoint
} from './chaining-store.mjs';

export { releaseTerminatedChainingLock, releaseTerminatedContinuityLock };
export const chainingTicketEnv = 'CROSS_SESSION_CHAIN_TICKET';
const invalid = () => chainingError('INVALID_ARGUMENT', 'Session continuity arguments are invalid.');
const localOnly = () => { throw chainingError('SESSION_LOCAL_ONLY', 'Session continuity cannot link or launch another session.'); };
const at = now => new Date(now()).toISOString();

function session(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid();
  return value;
}
function project(value) {
  if (!validProject(value)) throw invalid();
  return value;
}
function argsOnly(args, keys) {
  if (!plainObject(args) || Object.keys(args).some(key => !keys.includes(key))) throw invalid();
}
function sameProject(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sessionView(value) { return structuredClone(value); }

export class SessionContinuity {
  constructor(root, options = {}) {
    this.store = new ChainingStore(root, options);
    this.now = options.now ?? (() => Date.now());
  }
  verifyProject(entry, expected) {
    if (!sameProject(entry.project, expected)) throw chainingError('PROJECT_MISMATCH', 'This session belongs to another project.');
  }
  verifyLatest(entry) {
    if (entry.latest_checkpoint_id === null) return null;
    const checkpoint = this.store.readCheckpoint(entry.latest_checkpoint_id);
    if (checkpoint.owner !== entry.owner || !sameProject(checkpoint.project, entry.project)) {
      throw chainingError('UNAVAILABLE', 'The latest checkpoint does not match its session.');
    }
    return checkpoint;
  }
  report(entry) {
    if (!entry) return { status: 'absent', reason: 'NO_SESSION', session: null };
    this.verifyLatest(entry);
    return { status: entry.state, reason: entry.state === 'active' ? 'SESSION_ACTIVE' : 'SESSION_CLOSED', session: sessionView(entry) };
  }
  async ensureOwnSession(owner, args) {
    session(owner); argsOnly(args, ['project']); project(args.project);
    return this.store.transaction(state => {
      this.store.pruneClosed(state, owner);
      const current = state.sessions[owner];
      const timestamp = at(this.now);
      let status, reason;
      if (current) {
        this.verifyProject(current, args.project);
        this.verifyLatest(current);
        if (current.state === 'closed') {
          current.state = 'active'; current.closed_at = null; current.updated_at = timestamp;
          status = 'reopened'; reason = 'SESSION_REOPENED';
        } else {
          status = 'active'; reason = 'SESSION_ACTIVE';
        }
      } else {
        if (Object.keys(state.sessions).length >= this.store.limits.sessions) throw chainingError('LIMIT', 'The session limit was reached.');
        state.sessions[owner] = {
          owner, project: args.project, state: 'active', latest_checkpoint_id: null,
          created_at: timestamp, updated_at: timestamp, closed_at: null, reset_at: null
        };
        status = 'created'; reason = 'SESSION_CREATED';
      }
      this.store.writeState(state);
      try { this.store.cleanup(state); } catch { /* Cleanup is optional after the durable session write. */ }
      return { status, reason, session: sessionView(state.sessions[owner]) };
    });
  }
  async status(owner, args = {}) {
    session(owner); argsOnly(args, ['project']);
    if (args.project !== undefined) project(args.project);
    const entry = this.store.read().sessions[owner] ?? null;
    if (entry && args.project !== undefined) this.verifyProject(entry, args.project);
    return this.report(entry);
  }
  async restore(owner, args) {
    session(owner); argsOnly(args, ['project']); project(args.project);
    const entry = this.store.read().sessions[owner] ?? null;
    if (!entry) return {
      status: 'empty', reason: 'NO_SESSION', relationship: { receiving_session_id: owner, project: args.project }, checkpoint: null, path: null
    };
    this.verifyProject(entry, args.project);
    const checkpoint = this.verifyLatest(entry);
    if (!checkpoint) return {
      status: 'empty', reason: 'NO_CHECKPOINT', relationship: { receiving_session_id: owner, project: entry.project }, checkpoint: null, path: null
    };
    return {
      status: 'restored', reason: 'CHECKPOINT_LOADED',
      relationship: { receiving_session_id: owner, project: entry.project, checkpoint_id: checkpoint.id },
      checkpoint, path: this.store.checkpointPath(checkpoint.id)
    };
  }
  async reset(owner, args) {
    session(owner); argsOnly(args, ['project']); project(args.project);
    return this.store.transaction(state => {
      const entry = state.sessions[owner];
      if (!entry) throw chainingError('SESSION_NOT_FOUND', 'The session must be registered before reset.');
      this.verifyProject(entry, args.project);
      const timestamp = at(this.now);
      entry.state = 'active'; entry.latest_checkpoint_id = null; entry.updated_at = timestamp;
      entry.closed_at = null; entry.reset_at = timestamp;
      this.store.writeState(state);
      return { status: 'reset', reason: 'SESSION_RESET', session: sessionView(entry) };
    });
  }
  structured(owner, resetAt) {
    const path = join(this.store.root, workStateFile);
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const value = validateWorkStateFile(path).find(entry => entry.owner === owner) ?? null;
    if (value && resetAt !== null && (Date.parse(value.created_at) <= Date.parse(resetAt)
      || Date.parse(value.updated_at) <= Date.parse(resetAt))) return null;
    return value;
  }
  normalizeAutomatic(value, resetAt) {
    argsOnly(value, ['original_request', 'original_request_reason', 'recent_messages', 'git']);
    let original = value.original_request === null ? null : structuredClone(value.original_request);
    let reason = value.original_request_reason;
    let recent = Array.isArray(value.recent_messages) ? structuredClone(value.recent_messages) : value.recent_messages;
    if (resetAt !== null) {
      const afterReset = record => typeof record?.observed_at === 'string' && Date.parse(record.observed_at) > Date.parse(resetAt);
      if (!afterReset(original)) { original = null; reason = 'RESET_BOUNDARY'; }
      if (Array.isArray(recent)) recent = recent.filter(afterReset);
    }
    return { original_request: original, original_request_reason: reason, recent_messages: recent, git: structuredClone(value.git) };
  }
  async checkpoint(owner, args) {
    session(owner); argsOnly(args, ['project', 'event', 'automatic']); project(args.project);
    if (!['Stop', 'PreCompact', 'SessionEnd'].includes(args.event)) throw invalid();
    const preliminary = this.normalizeAutomatic(args.automatic, null);
    const prepared = {
      version: 1, id: randomUUID(), owner, project: args.project, event: args.event, created_at: at(this.now),
      ...preliminary, structured: null
    };
    try { validateCheckpoint(prepared); } catch { throw invalid(); }
    return this.store.transaction(state => {
      this.store.pruneClosed(state, owner);
      const entry = state.sessions[owner];
      if (!entry) throw chainingError('SESSION_NOT_FOUND', 'The session must be registered before checkpointing.');
      this.verifyProject(entry, args.project);
      if (entry.state === 'closed') {
        if (args.event === 'SessionEnd') return {
          status: 'closed', reason: 'SESSION_ALREADY_CLOSED', checkpoint_id: entry.latest_checkpoint_id,
          path: entry.latest_checkpoint_id ? this.store.checkpointPath(entry.latest_checkpoint_id) : null, warnings: []
        };
        throw chainingError('SESSION_CLOSED', 'The session is closed.');
      }
      const automatic = this.normalizeAutomatic(args.automatic, entry.reset_at);
      const value = { ...prepared, ...automatic, structured: this.structured(owner, entry.reset_at) };
      try { validateCheckpoint(value); } catch { throw invalid(); }
      entry.latest_checkpoint_id = value.id; entry.updated_at = value.created_at;
      if (args.event === 'SessionEnd') { entry.state = 'closed'; entry.closed_at = value.created_at; }
      let warnings = this.store.commitCheckpoint(value, state);
      if (args.event !== 'SessionEnd') {
        try { warnings.push(...this.store.cleanup(state)); } catch { warnings.push('Checkpoint saved. Retention cleanup failed.'); }
      }
      return {
        status: args.event === 'SessionEnd' ? 'closed' : 'saved',
        reason: args.event === 'SessionEnd' ? 'SESSION_CLOSED' : 'CHECKPOINT_SAVED',
        checkpoint_id: value.id, path: this.store.checkpointPath(value.id), warnings: [...new Set(warnings)]
      };
    });
  }
  async usage() {
    const state = this.store.read();
    let inventory;
    try { lstatSync(this.store.directory); inventory = this.store.inventory(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; inventory = { bytes: 0, count: 0 }; }
    let lockPresent = false;
    try { lstatSync(this.store.lockPath); lockPresent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sessions = Object.values(state.sessions);
    return {
      bytes: inventory.bytes, checkpoints: inventory.count, sessions: sessions.length,
      active: sessions.filter(value => value.state === 'active').length,
      closed: sessions.filter(value => value.state === 'closed').length,
      limits: { ...this.store.limits }, lock_present: lockPresent,
      warnings: [
        'Only the latest checkpoint of each retained session is protected from cleanup.',
        ...(lockPresent ? ['A writer lock is present. Continuity writes fail while it is held. No lock is removed on a timer.'] : [])
      ]
    };
  }
  async bind() { localOnly(); }
  async unlink() { localOnly(); }
  async relink() { localOnly(); }
  async createTicket() { localOnly(); }
  async claimTicket() { localOnly(); }
  async confirmRestore() { localOnly(); }
}

export { SessionContinuity as Chaining };
