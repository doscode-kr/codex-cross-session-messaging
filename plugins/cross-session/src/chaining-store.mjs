import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';
import { CrossSessionError } from './errors.mjs';
import { validateWorkStateEntry } from './work-state.mjs';

export const chainingLimits = Object.freeze({
  index_bytes: 2 * 1024 * 1024, checkpoint_bytes: 256 * 1024, total_bytes: 64 * 1024 * 1024,
  checkpoints: 2048, sessions: 1024, keep_per_session: 20, retention_ms: 30 * 86400000
});
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const chainingError = (code, message) => new CrossSessionError(`CHAINING_${code}`, message);
const unavailable = () => chainingError('UNAVAILABLE', 'The session continuity store is not available. Message tools remain available.');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableDate = value => value === null || validDate(value);
const nullableUuid = value => value === null || (typeof value === 'string' && uuidPattern.test(value));
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const initialState = () => ({ version: 1, sessions: {} });

export function validProject(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && isAbsolute(value);
}

function validRecord(value, roles, provenance) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (!['provenance,role,text', 'observed_at,provenance,role,text'].includes(keys)) return false;
  return roles.includes(value.role) && typeof value.text === 'string' && value.text.length <= 65536
    && value.provenance === provenance && (value.observed_at === undefined || validDate(value.observed_at));
}

function validGit(value) {
  return value === null || (exactKeys(value, ['branch', 'head', 'dirty'])
    && typeof value.branch === 'string' && value.branch.length <= 1024 && typeof value.head === 'string'
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64}|)$/u.test(value.head) && typeof value.dirty === 'boolean');
}

export function validateCheckpoint(value) {
  const keys = ['version', 'id', 'owner', 'project', 'event', 'created_at', 'original_request', 'original_request_reason', 'recent_messages', 'structured', 'git'];
  if (!exactKeys(value, keys) || value.version !== 1 || !uuidPattern.test(value.id) || !uuidPattern.test(value.owner)
    || !validProject(value.project) || !['Stop', 'PreCompact', 'SessionEnd'].includes(value.event) || !validDate(value.created_at)
    || (value.original_request !== null && !validRecord(value.original_request, ['user'], 'observed_user_record'))
    || !['OBSERVED', 'NOT_AVAILABLE', 'RESET_BOUNDARY'].includes(value.original_request_reason)
    || (value.original_request === null) === (value.original_request_reason === 'OBSERVED')
    || !Array.isArray(value.recent_messages) || value.recent_messages.length > 100 || !validGit(value.git)) throw unavailable();
  for (const message of value.recent_messages) if (!validRecord(message, ['user', 'assistant'], 'observed_transcript_record')) throw unavailable();
  if (value.structured !== null) {
    if (!plainObject(value.structured) || value.structured.owner !== value.owner) throw unavailable();
    try { validateWorkStateEntry(value.structured); } catch { throw unavailable(); }
  }
  return value;
}

export function validateChainingState(value, limits = chainingLimits) {
  if (!exactKeys(value, ['version', 'sessions']) || value.version !== 1 || !plainObject(value.sessions)
    || Object.keys(value.sessions).length > limits.sessions) throw unavailable();
  for (const [owner, session] of Object.entries(value.sessions)) {
    const keys = ['owner', 'project', 'state', 'latest_checkpoint_id', 'created_at', 'updated_at', 'closed_at', 'reset_at'];
    if (!uuidPattern.test(owner) || !exactKeys(session, keys) || session.owner !== owner || !validProject(session.project)
      || !['active', 'closed'].includes(session.state) || !nullableUuid(session.latest_checkpoint_id)
      || !validDate(session.created_at) || !validDate(session.updated_at) || !nullableDate(session.closed_at) || !nullableDate(session.reset_at)
      || (session.state === 'active' && session.closed_at !== null) || (session.state === 'closed' && session.closed_at === null)) throw unavailable();
  }
  return value;
}

// Each writer uses its own lock descriptor. Locks are never removed on a timer.
export class ChainingStore {
  constructor(root, { limits = {}, now = () => Date.now(), lock_owner_id } = {}) {
    this.root = resolve(root);
    this.directory = join(this.root, 'session-continuity-v1');
    this.path = join(this.directory, 'state.json');
    this.checkpoints = join(this.directory, 'checkpoints');
    this.lockPath = join(this.directory, 'write.lock');
    this.markerPath = join(this.directory, 'format');
    if (lock_owner_id !== undefined && (typeof lock_owner_id !== 'string' || !uuidPattern.test(lock_owner_id))) {
      throw chainingError('INVALID_ARGUMENT', 'The lock owner ID must be a UUID.');
    }
    this.lockOwnerId = lock_owner_id;
    this.limits = { ...chainingLimits, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) {
      throw chainingError('INVALID_ARGUMENT', 'Session continuity limits must be positive integers.');
    }
    this.now = now;
  }
  directoryStat(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    return stat;
  }
  checkDirectories() { this.directoryStat(this.directory); this.directoryStat(this.checkpoints); }
  readJson(path, maxBytes) {
    let fd;
    try {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw unavailable();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const after = fstatSync(fd);
      if (!after.isFile() || after.size > maxBytes || before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
      const raw = readFileSync(fd);
      if (raw.length > maxBytes) throw unavailable();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    } catch { throw unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  read() {
    try {
      try { lstatSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return initialState(); throw error; }
      this.checkDirectories();
      return validateChainingState(this.readJson(this.path, this.limits.index_bytes), this.limits);
    } catch { throw unavailable(); }
  }
  checkpointPath(id) {
    if (typeof id !== 'string' || !uuidPattern.test(id)) throw unavailable();
    return join(this.checkpoints, `${id}.json`);
  }
  readCheckpoint(id) {
    try {
      this.checkDirectories();
      const value = validateCheckpoint(this.readJson(this.checkpointPath(id), this.limits.checkpoint_bytes));
      if (value.id !== id) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }
  inventory() {
    this.checkDirectories();
    let bytes = 0, count = 0;
    for (const name of readdirSync(this.directory)) {
      if (name === 'checkpoints') continue;
      let stat;
      try { stat = lstatSync(join(this.directory, name)); }
      catch (error) {
        if (error.code === 'ENOENT' && /^lock-\d+-\d+-[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
      bytes += stat.size;
    }
    for (const name of readdirSync(this.checkpoints)) {
      const stat = lstatSync(join(this.checkpoints, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
      bytes += stat.size; count++;
    }
    return { bytes, count };
  }
  writeAtomic(path, raw) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* A successful rename removes the temporary path. */ }
    }
  }
  writeState(state) {
    validateChainingState(state, this.limits);
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw) > this.limits.index_bytes) throw chainingError('LIMIT', 'The continuity index size limit was reached.');
    const { bytes } = this.inventory();
    const oldBytes = existsSync(this.path) ? lstatSync(this.path).size : 0;
    if (bytes - oldBytes + Buffer.byteLength(raw) > this.limits.total_bytes) throw chainingError('LIMIT', 'The continuity store size limit was reached.');
    this.writeAtomic(this.path, raw);
  }
  writeCheckpoint(value) {
    validateCheckpoint(value);
    const raw = JSON.stringify(value), size = Buffer.byteLength(raw);
    const { bytes, count } = this.inventory();
    if (size > this.limits.checkpoint_bytes || bytes + size > this.limits.total_bytes || count >= this.limits.checkpoints) {
      throw chainingError('LIMIT', 'The checkpoint limit was reached.');
    }
    const temporary = join(this.checkpoints, `${value.id}.${randomUUID()}.tmp`), warnings = [];
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
      linkSync(temporary, this.checkpointPath(value.id));
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') warnings.push('A checkpoint temporary file could not be removed.'); }
    }
    return warnings;
  }
  commitCheckpoint(value, state) {
    validateCheckpoint(value); validateChainingState(state, this.limits);
    const checkpointBytes = Buffer.byteLength(JSON.stringify(value)), indexBytes = Buffer.byteLength(JSON.stringify(state));
    const { bytes, count } = this.inventory();
    const oldBytes = lstatSync(this.path).size;
    if (checkpointBytes > this.limits.checkpoint_bytes || indexBytes > this.limits.index_bytes || count >= this.limits.checkpoints
      || bytes - oldBytes + indexBytes + checkpointBytes > this.limits.total_bytes) throw chainingError('LIMIT', 'The checkpoint limit was reached.');
    const warnings = this.writeCheckpoint(value);
    this.writeState(state);
    return warnings;
  }
  async transaction(change) {
    const ownerId = this.lockOwnerId ?? randomUUID();
    const temporary = join(this.directory, `lock-${process.pid}-${threadId}-${ownerId}.tmp`);
    let fd, identity, acquired = false, temporaryOwned = false;
    try {
      this.directoryStat(this.root);
      try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.directoryStat(this.directory);
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      temporaryOwned = true;
      writeFileSync(fd, JSON.stringify({ pid: process.pid, thread_id: threadId, id: ownerId }));
      identity = fstatSync(fd);
      closeSync(fd); fd = undefined;
      try { linkSync(temporary, this.lockPath); acquired = true; }
      catch (error) { if (error.code === 'EEXIST') throw chainingError('BUSY', 'Another continuity writer holds the lock.'); throw error; }
      unlinkSync(temporary);
      if (!existsSync(this.path)) {
        if (existsSync(this.markerPath)) throw unavailable();
        const names = readdirSync(this.directory);
        if (names.some(name => name !== 'write.lock' && name !== 'checkpoints' && !/^lock-\d+-\d+-[0-9a-f-]{36}\.tmp$/u.test(name))) throw unavailable();
        try { mkdirSync(this.checkpoints, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        this.directoryStat(this.checkpoints);
        if (readdirSync(this.checkpoints).length !== 0) throw unavailable();
        writeFileSync(this.markerPath, '1\n', { flag: 'wx', mode: 0o600 });
        this.writeState(initialState());
      }
      this.checkDirectories();
      return await change(this.read());
    } catch (error) {
      if (error instanceof CrossSessionError && error.code.startsWith('CHAINING_')) throw error;
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (acquired) {
        try {
          const current = lstatSync(this.lockPath);
          if (identity && current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink()) unlinkSync(this.lockPath);
        } catch { /* A failed lock release leaves the store closed to other writers. */ }
      }
      if (temporaryOwned) try { unlinkSync(temporary); } catch { /* A failed writer can leave its own temporary file. */ }
    }
  }
  pruneClosed(state, currentOwner = null) {
    const removed = [];
    for (const [owner, session] of Object.entries(state.sessions)) {
      if (owner === currentOwner || session.state !== 'closed' || this.now() - Date.parse(session.closed_at) <= this.limits.retention_ms) continue;
      removed.push(session.latest_checkpoint_id);
      delete state.sessions[owner];
    }
    return removed.filter(Boolean);
  }
  cleanup(state, owner = null) {
    const protectedIds = new Set(Object.values(state.sessions).map(session => session.latest_checkpoint_id).filter(Boolean));
    const byOwner = new Map(), warnings = [];
    for (const name of readdirSync(this.checkpoints)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) { warnings.push('Unknown checkpoint files were kept.'); continue; }
      try {
        const checkpoint = this.readCheckpoint(name.slice(0, -5));
        if (!byOwner.has(checkpoint.owner)) byOwner.set(checkpoint.owner, []);
        byOwner.get(checkpoint.owner).push(checkpoint);
      } catch { warnings.push('Unreadable checkpoint files were kept.'); }
    }
    for (const [entryOwner, entries] of byOwner) {
      if (owner !== null && entryOwner !== owner && Object.hasOwn(state.sessions, entryOwner)) continue;
      entries.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      for (let index = 0; index < entries.length; index++) {
        const checkpoint = entries[index];
        if (protectedIds.has(checkpoint.id)) continue;
        if (index < this.limits.keep_per_session && this.now() - Date.parse(checkpoint.created_at) <= this.limits.retention_ms) continue;
        try { unlinkSync(this.checkpointPath(checkpoint.id)); } catch { warnings.push('A checkpoint could not be removed.'); }
      }
    }
    return [...new Set(warnings)];
  }
}

// The caller must await the child or worker exit before it calls this function.
export function releaseTerminatedContinuityLock(root, { process_id = process.pid, thread_id, lock_owner_id } = {}) {
  if (!isMainThread || !Number.isSafeInteger(process_id) || process_id <= 0 || !Number.isSafeInteger(thread_id) || thread_id < 0
    || (process_id === process.pid && thread_id === 0) || typeof lock_owner_id !== 'string' || !uuidPattern.test(lock_owner_id)) {
    throw chainingError('INVALID_ARGUMENT', 'Lock release requires a stopped worker ID and its lock owner UUID.');
  }
  const store = new ChainingStore(root), temporary = join(store.directory, `lock-${process_id}-${thread_id}-${lock_owner_id}.tmp`);
  let released = false;
  try {
    store.directoryStat(store.directory);
    try {
      const identity = lstatSync(store.lockPath);
      const value = store.readJson(store.lockPath, 4096);
      if (value.pid === process_id && value.thread_id === thread_id && value.id === lock_owner_id) {
        const current = lstatSync(store.lockPath);
        if (identity.dev === current.dev && identity.ino === current.ino && current.isFile() && !current.isSymbolicLink()) {
          unlinkSync(store.lockPath); released = true;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') return { released: false, reason: 'unavailable' }; }
    try {
      const stat = lstatSync(temporary);
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') return { released, reason: 'temporary_file_kept' }; }
    return { released, reason: released ? 'released' : 'owner_mismatch_or_missing' };
  } catch { return { released: false, reason: 'unavailable' }; }
}

export const releaseTerminatedChainingLock = releaseTerminatedContinuityLock;
