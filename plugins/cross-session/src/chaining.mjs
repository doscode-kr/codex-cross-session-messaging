import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkStateFile, workStateFile } from './work-state.mjs';
import { ChainingStore, chainingError, chainPattern, plainObject, uuidPattern, validateCheckpoint } from './chaining-store.mjs';
export { releaseTerminatedChainingLock } from './chaining-store.mjs';

export const chainingTicketEnv = 'CROSS_SESSION_CHAIN_TICKET';
const invalid = () => chainingError('INVALID_ARGUMENT', 'Chaining arguments are invalid. Use complete session UUIDs.');
function session(value) { if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(); return value; }
function chain(value) { if (typeof value !== 'string' || !chainPattern.test(value)) throw invalid(); return value; }
function argsOnly(args, keys) { if (!plainObject(args) || Object.keys(args).some(key => !keys.includes(key))) throw invalid(); }
const digest = ticket => createHash('sha256').update(ticket).digest('hex');
const currentCheckpoint = binding => binding.latest_checkpoint_id ?? binding.pinned_checkpoint_id;
const at = now => new Date(now()).toISOString();

// Chaining reads work-state reports but never changes their owners or runtime policy.
export class Chaining {
  constructor(root, options = {}) {
    this.store = new ChainingStore(root, options);
    this.now = options.now ?? (() => Date.now());
  }
  verifyBinding(binding) {
    if (binding.latest_checkpoint_id !== null) {
      const checkpoint = this.store.readCheckpoint(binding.latest_checkpoint_id);
      if (checkpoint.session_id !== binding.session_id || checkpoint.chain_id !== binding.chain_id) throw chainingError('UNAVAILABLE', 'The current checkpoint does not match the binding.');
    }
    if (binding.pinned_checkpoint_id !== null) {
      const checkpoint = this.store.readCheckpoint(binding.pinned_checkpoint_id);
      if (checkpoint.session_id !== binding.source_session_id || checkpoint.chain_id !== binding.chain_id) throw chainingError('UNAVAILABLE', 'The source checkpoint does not match the binding.');
    }
  }
  verifyTicket(ticket) {
    if (ticket.pinned_checkpoint_id === null) throw chainingError('UNAVAILABLE', 'The launch ticket has no source checkpoint.');
    const checkpoint = this.store.readCheckpoint(ticket.pinned_checkpoint_id);
    if (checkpoint.session_id !== ticket.source_session_id || checkpoint.chain_id !== ticket.chain_id) throw chainingError('UNAVAILABLE', 'The launch checkpoint does not match the ticket.');
  }
  report(state, owner) {
    const binding = state.bindings[owner] ?? null, tombstone = state.tombstones[owner] ?? null;
    if (binding) this.verifyBinding(binding);
    return structuredClone({ status: tombstone ? 'unlinked' : !binding ? 'unbound' : currentCheckpoint(binding) ? 'bound' : 'bound_no_notes', binding, tombstone });
  }
  source(state, owner, chainId, sourceId) {
    if (sourceId === undefined || sourceId === null) return { source_session_id: null, pinned_checkpoint_id: null };
    session(sourceId);
    if (owner === sourceId) throw invalid();
    const source = state.bindings[sourceId];
    if (!source || source.chain_id !== chainId) throw chainingError('SOURCE_MISMATCH', 'The source session is not bound to the requested chain.');
    this.verifyBinding(source);
    if (!source.latest_checkpoint_id) throw chainingError('NO_CHECKPOINT', 'The source session has no saved checkpoint.');
    return { source_session_id: sourceId, pinned_checkpoint_id: source.latest_checkpoint_id };
  }
  newBinding(state, owner, args) {
    const chainId = chain(args.chain_id);
    const source = this.source(state, owner, chainId, args.source_session_id);
    if (Object.keys(state.bindings).length >= this.store.limits.bindings) throw chainingError('LIMIT', 'The binding limit was reached. No binding was removed.');
    return { id: randomUUID(), session_id: owner, chain_id: chainId, ...source, latest_checkpoint_id: null, created_at: at(this.now) };
  }
  async bind(owner, args) {
    session(owner); argsOnly(args, ['chain_id', 'source_session_id']); chain(args.chain_id);
    if (args.source_session_id !== undefined) session(args.source_session_id);
    return this.store.transaction(state => {
      if (state.tombstones[owner]) throw chainingError('UNLINKED', 'This session was unlinked. Use its tombstone ID to relink it.');
      if (state.bindings[owner]) throw chainingError('ALREADY_BOUND', 'This session already has a chain binding.');
      state.bindings[owner] = this.newBinding(state, owner, args);
      this.store.writeState(state);
      return this.report(state, owner);
    });
  }
  async status(owner) {
    session(owner);
    return this.report(this.store.read(), owner);
  }
  async unlink(owner, args) {
    session(owner); argsOnly(args, ['expected_chain_id', 'expected_checkpoint_id']); chain(args.expected_chain_id);
    if (args.expected_checkpoint_id !== null) session(args.expected_checkpoint_id);
    return this.store.transaction(state => {
      const binding = state.bindings[owner];
      if (!binding || binding.chain_id !== args.expected_chain_id || currentCheckpoint(binding) !== args.expected_checkpoint_id) {
        throw chainingError('CONFLICT', 'The binding changed. Read its current chain and checkpoint before unlinking.');
      }
      this.verifyBinding(binding);
      if (Object.keys(state.tombstones).length >= this.store.limits.tombstones) throw chainingError('LIMIT', 'The tombstone limit was reached. No binding was removed.');
      state.tombstones[owner] = { id: randomUUID(), session_id: owner, chain_id: binding.chain_id, checkpoint_id: currentCheckpoint(binding), unlinked_at: at(this.now) };
      delete state.bindings[owner];
      this.store.writeState(state);
      return this.report(state, owner);
    });
  }
  async relink(owner, args) {
    session(owner); argsOnly(args, ['tombstone_id', 'chain_id', 'source_session_id']); session(args.tombstone_id); chain(args.chain_id);
    if (args.source_session_id !== undefined) session(args.source_session_id);
    return this.store.transaction(state => {
      if (!state.tombstones[owner] || state.tombstones[owner].id !== args.tombstone_id || state.bindings[owner]) {
        throw chainingError('CONFLICT', 'The tombstone changed. Read its current ID before relinking.');
      }
      state.bindings[owner] = this.newBinding(state, owner, args);
      delete state.tombstones[owner];
      this.store.writeState(state);
      return this.report(state, owner);
    });
  }
  async createTicket(args) {
    argsOnly(args, ['chain_id', 'source_session_id']); chain(args.chain_id); session(args.source_session_id);
    return this.store.transaction(state => {
      const source = this.source(state, null, args.chain_id, args.source_session_id);
      if (Object.keys(state.tickets).length >= this.store.limits.tickets) throw chainingError('LIMIT', 'The launch ticket limit was reached. No ticket was removed.');
      const ticket = randomBytes(32).toString('hex');
      const entry = { chain_id: args.chain_id, ...source, created_at: at(this.now), expires_at: new Date(this.now() + 600000).toISOString(), owner: null, binding_id: null };
      state.tickets[digest(ticket)] = entry;
      this.store.writeState(state);
      return { ticket, expires_at: entry.expires_at, chain_id: entry.chain_id, ...source };
    });
  }
  async claimTicket(owner, ticket) {
    session(owner);
    if (ticket === undefined || ticket === null || ticket === '') return { status: 'missing_ticket' };
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/u.test(ticket)) return { status: 'invalid_ticket' };
    return this.store.transaction(state => {
      const entry = state.tickets[digest(ticket)];
      if (!entry) return { status: 'missing_ticket' };
      if (entry.owner !== null && entry.owner !== owner) return { status: 'consumed' };
      if (state.tombstones[owner]) return { status: 'mismatch' };
      if (entry.owner === owner) {
        const binding = state.bindings[owner];
        if (!binding || binding.id !== entry.binding_id || binding.chain_id !== entry.chain_id || binding.source_session_id !== entry.source_session_id
          || binding.pinned_checkpoint_id !== entry.pinned_checkpoint_id) return { status: 'mismatch' };
        this.verifyTicket(entry); this.verifyBinding(binding);
        return { status: 'owner_resume', binding: structuredClone(binding) };
      }
      if (Date.parse(entry.expires_at) <= this.now()) return { status: 'expired' };
      if (state.bindings[owner] || owner === entry.source_session_id) return { status: 'mismatch' };
      this.verifyTicket(entry);
      if (Object.keys(state.bindings).length >= this.store.limits.bindings) throw chainingError('LIMIT', 'The binding limit was reached. No binding was removed.');
      const binding = { id: randomUUID(), session_id: owner, chain_id: entry.chain_id, source_session_id: entry.source_session_id,
        pinned_checkpoint_id: entry.pinned_checkpoint_id, latest_checkpoint_id: null, created_at: at(this.now) };
      state.bindings[owner] = binding; entry.owner = owner; entry.binding_id = binding.id;
      this.store.writeState(state);
      return { status: 'claimed', binding: structuredClone(binding) };
    });
  }
  async restore(owner) {
    session(owner);
    const result = this.report(this.store.read(), owner);
    if (result.status !== 'bound') return { ...result, checkpoint: null, path: null };
    const id = currentCheckpoint(result.binding);
    return { ...result, status: 'restored', checkpoint: this.store.readCheckpoint(id), path: this.store.checkpointPath(id) };
  }
  structured(owner) {
    const path = join(this.store.root, workStateFile);
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return validateWorkStateFile(path).find(entry => entry.owner === owner) ?? null;
  }
  async checkpoint(owner, args) {
    session(owner); argsOnly(args, ['event', 'automatic', 'skip_cleanup']);
    if (!['Stop', 'PreCompact', 'SessionEnd'].includes(args.event) || (args.skip_cleanup !== undefined && typeof args.skip_cleanup !== 'boolean')) throw invalid();
    return this.store.transaction(state => {
      const binding = state.bindings[owner];
      if (state.tombstones[owner]) return { status: 'unlinked' };
      if (!binding) return { status: 'unbound' };
      this.verifyBinding(binding);
      const value = { version: 1, id: randomUUID(), session_id: owner, chain_id: binding.chain_id, event: args.event,
        created_at: at(this.now), structured: this.structured(owner), automatic: structuredClone(args.automatic ?? { messages: [], git: null }) };
      try { validateCheckpoint(value); } catch { throw invalid(); }
      binding.latest_checkpoint_id = value.id;
      let warnings = this.store.commitCheckpoint(value, state);
      if (args.event !== 'SessionEnd' && !args.skip_cleanup) {
        try { warnings.push(...this.store.cleanup(state, owner)); } catch { warnings.push('Checkpoint saved. Retention cleanup failed.'); }
      }
      return { status: 'saved', checkpoint_id: value.id, path: this.store.checkpointPath(value.id), warnings };
    });
  }
  async usage() {
    const state = this.store.read();
    let inventory;
    try { lstatSync(this.store.directory); inventory = this.store.inventory(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; inventory = { bytes: 0, count: 0 }; }
    let lockPresent = false;
    try { lstatSync(this.store.lockPath); lockPresent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { bytes: inventory.bytes, checkpoints: inventory.count, bindings: Object.keys(state.bindings).length,
      tombstones: Object.keys(state.tombstones).length, tickets: Object.keys(state.tickets).length, limits: { ...this.store.limits },
      lock_present: lockPresent,
      warnings: ['Protected checkpoints, claimed tickets, and tombstones are not removed to make space.',
        ...(lockPresent ? ['A writer lock is present. Chaining writes fail while it is held. No lock is removed on a timer.'] : [])] };
  }
}
