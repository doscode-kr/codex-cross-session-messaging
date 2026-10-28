import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chaining } from '../plugins/cross-session/src/chaining.mjs';
import { WorkState } from '../plugins/cross-session/src/work-state.mjs';
import { temporary } from './helpers.mjs';

const a = '01234567-0000-4000-8000-000000000001', b = '01234567-0000-4000-8000-000000000002';
const c = '01234567-0000-4000-8000-000000000003';
const automatic = text => ({ messages: [{ role: 'user', text }], git: null });
const save = (chaining, owner, text = 'Saved text', event = 'Stop') => chaining.checkpoint(owner, { event, automatic: automatic(text) });
async function confirm(chaining, owner) {
  const restored = await chaining.restore(owner);
  return chaining.confirmRestore(owner, { expected_binding_id: restored.binding.id, expected_checkpoint_id: restored.checkpoint.id });
}
function state(work, owner, objective) {
  work.set(owner, { action: 'start', expected_revision: 0, objective, scope: 'Current user request', completion_criteria: 'Tests pass', next_action: 'Run tests',
    checklist: [{ title: 'Tests', expected_result: 'Tests pass', verification_method: 'Run tests' }] });
}

test('full UUID source selection and immutable snapshots preserve the selected owner', async t => {
  const root = temporary(t), chaining = new Chaining(root), work = new WorkState(root);
  state(work, a, 'Owner A marker'); state(work, b, 'Owner B marker');
  await chaining.bind(a, { chain_id: 'work' }); await chaining.bind(b, { chain_id: 'work' });
  const first = await save(chaining, a, 'A text'); await save(chaining, b, 'B text');
  const original = readFileSync(first.path);
  await chaining.bind(c, { chain_id: 'work', source_session_id: a });
  work.set(a, { action: 'update', expected_revision: 1, next_action: 'Changed after binding' });
  await save(chaining, a, 'A later text');
  const restored = await chaining.restore(c);
  assert.equal(restored.checkpoint.id, first.checkpoint_id);
  assert.equal(restored.checkpoint.structured.objective, 'Owner A marker');
  assert.equal(restored.checkpoint.structured.next_action, 'Run tests');
  assert.equal(restored.checkpoint.automatic.messages[0].text, 'A text');
  assert.deepEqual(readFileSync(first.path), original);
  assert.equal((await chaining.restore(randomUUID())).status, 'unbound');
  for (const id of ['01234567', a.slice(0, -1), '../state']) await assert.rejects(chaining.status(id), { code: 'CHAINING_INVALID_ARGUMENT' });
});

test('reads do not create chaining storage and an unbound session does not save', async t => {
  const root = temporary(t), chaining = new Chaining(root);
  assert.equal((await chaining.status(a)).status, 'unbound');
  assert.equal((await chaining.restore(a)).checkpoint, null);
  assert.equal((await chaining.usage()).bytes, 0);
  assert.deepEqual(readdirSync(root), []);
  assert.equal((await save(chaining, a)).status, 'unbound');
  assert.equal(readdirSync(chaining.store.checkpoints).length, 0);
});

test('handoff reasons and provenance distinguish the pinned source from current progress', async t => {
  const chaining = new Chaining(temporary(t));
  assert.equal((await chaining.status(a)).reason, 'NO_BINDING');
  assert.equal((await chaining.bind(a, { chain_id: 'work' })).reason, 'NO_CHECKPOINT');
  const source = await save(chaining, a);
  const linked = await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  const first = await chaining.restore(b);
  assert.equal(first.reason, 'CHECKPOINT_LOADED');
  assert.deepEqual(first.relationship, { receiving_session_id: b, source_session_id: a,
    binding_id: linked.binding.id, chain_id: 'work', checkpoint_id: source.checkpoint_id,
    checkpoint_session_id: a, selected_from: 'pinned_source' });
  await confirm(chaining, b);
  const own = await save(chaining, b);
  const resumed = await chaining.restore(b);
  assert.equal(resumed.relationship.source_session_id, a);
  assert.equal(resumed.relationship.checkpoint_session_id, b);
  assert.equal(resumed.relationship.checkpoint_id, own.checkpoint_id);
  assert.equal(resumed.relationship.selected_from, 'own_latest');
  const unlinked = await chaining.unlink(b, { expected_chain_id: 'work', expected_checkpoint_id: own.checkpoint_id });
  assert.equal(unlinked.reason, 'EXPLICITLY_UNLINKED');
});

test('source links require a saved checkpoint and cannot move a live binding', async t => {
  const chaining = new Chaining(temporary(t));
  await chaining.bind(a, { chain_id: 'one' });
  await assert.rejects(chaining.bind(b, { chain_id: 'one', source_session_id: a }), { code: 'CHAINING_NO_CHECKPOINT' });
  await assert.rejects(chaining.createTicket({ chain_id: 'one', source_session_id: a }), { code: 'CHAINING_NO_CHECKPOINT' });
  await assert.rejects(chaining.bind(a, { chain_id: 'two' }), { code: 'CHAINING_ALREADY_BOUND' });
  await save(chaining, a);
  await assert.rejects(chaining.bind(b, { chain_id: 'two', source_session_id: a }), { code: 'CHAINING_SOURCE_MISMATCH' });
  assert.equal((await chaining.status(b)).status, 'unbound');
});

test('tickets pin creation time snapshots, consume once, and allow owner resume after expiry', async t => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const root = temporary(t), chaining = new Chaining(root, { now: () => time });
  await chaining.bind(a, { chain_id: 'work' }); const first = await save(chaining, a, 'First');
  const ticket = await chaining.createTicket({ chain_id: 'work', source_session_id: a });
  assert.match(ticket.ticket, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(chaining.store.path, 'utf8').includes(ticket.ticket), false);
  assert.equal(readFileSync(chaining.store.path, 'utf8').includes(createHash('sha256').update(ticket.ticket).digest('hex')), true);
  await save(chaining, a, 'Second');
  assert.equal((await chaining.claimTicket(b, ticket.ticket)).status, 'claimed');
  assert.equal((await chaining.status(b)).binding.restore_pending, true);
  assert.equal((await save(chaining, b)).status, 'awaiting_restore');
  assert.equal((await chaining.restore(b)).checkpoint.id, first.checkpoint_id);
  assert.equal((await chaining.claimTicket(c, ticket.ticket)).status, 'consumed');
  assert.equal((await chaining.restore(c)).status, 'unbound');
  time += 3600000;
  assert.equal((await chaining.claimTicket(b, ticket.ticket)).status, 'owner_resume');
  await confirm(chaining, b);
  const own = await save(chaining, b, 'Owner progress', 'PreCompact');
  assert.equal((await chaining.restore(b)).checkpoint.id, own.checkpoint_id);
  assert.equal((await chaining.status(b)).binding.pinned_checkpoint_id, first.checkpoint_id);
  const reopened = new Chaining(root, { now: () => time });
  assert.equal((await reopened.claimTicket(b, ticket.ticket)).status, 'owner_resume');
});

test('ticket rejection distinguishes missing, malformed, expired, and mismatched owners', async t => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const chaining = new Chaining(temporary(t), { now: () => time });
  await chaining.bind(a, { chain_id: 'work' }); await save(chaining, a);
  const expired = await chaining.createTicket({ chain_id: 'work', source_session_id: a });
  time += 600000;
  assert.equal((await chaining.claimTicket(b, expired.ticket)).status, 'expired');
  assert.equal((await chaining.claimTicket(b, undefined)).status, 'missing_ticket');
  assert.equal((await chaining.claimTicket(b, 'bad')).status, 'invalid_ticket');
  assert.equal((await chaining.claimTicket(b, 'a'.repeat(64))).status, 'missing_ticket');
  const mismatch = await chaining.createTicket({ chain_id: 'work', source_session_id: a });
  assert.equal((await chaining.claimTicket(a, mismatch.ticket)).status, 'mismatch');
  await chaining.bind(b, { chain_id: 'other' });
  assert.equal((await chaining.claimTicket(b, mismatch.ticket)).status, 'mismatch');
});

test('unlink CAS and tombstones stop automatic rebind, save, and old owner tickets', async t => {
  const chaining = new Chaining(temporary(t));
  await chaining.bind(a, { chain_id: 'work' }); const source = await save(chaining, a);
  const ticket = await chaining.createTicket({ chain_id: 'work', source_session_id: a });
  await chaining.claimTicket(b, ticket.ticket);
  await assert.rejects(chaining.unlink(b, { expected_chain_id: 'wrong', expected_checkpoint_id: source.checkpoint_id }), { code: 'CHAINING_CONFLICT' });
  await assert.rejects(chaining.unlink(b, { expected_chain_id: 'work', expected_checkpoint_id: null }), { code: 'CHAINING_CONFLICT' });
  const result = await chaining.unlink(b, { expected_chain_id: 'work', expected_checkpoint_id: source.checkpoint_id });
  assert.equal(result.status, 'unlinked');
  assert.equal((await save(chaining, b)).status, 'unlinked');
  assert.equal((await chaining.claimTicket(b, ticket.ticket)).status, 'mismatch');
  await assert.rejects(chaining.bind(b, { chain_id: 'work' }), { code: 'CHAINING_UNLINKED' });
  await assert.rejects(chaining.relink(b, { tombstone_id: randomUUID(), chain_id: 'work' }), { code: 'CHAINING_CONFLICT' });
  const relinked = await chaining.relink(b, { tombstone_id: result.tombstone.id, chain_id: 'work', source_session_id: a });
  assert.equal(relinked.status, 'bound');
  assert.equal(relinked.binding.restore_pending, true);
  assert.equal((await save(chaining, b)).status, 'awaiting_restore');
  assert.equal((await chaining.claimTicket(b, ticket.ticket)).status, 'mismatch');
  assert.equal((await chaining.restore(b)).checkpoint.id, source.checkpoint_id);
});

test('Stop, PreCompact, and SessionEnd each save immutable snapshots', async t => {
  const chaining = new Chaining(temporary(t));
  await chaining.bind(a, { chain_id: 'work' });
  for (const event of ['Stop', 'PreCompact', 'SessionEnd']) {
    const result = await save(chaining, a, event, event);
    assert.equal(JSON.parse(readFileSync(result.path)).event, event);
  }
  assert.equal(readdirSync(chaining.store.checkpoints).length, 3);
});

test('invalid automatic data and corrupted work-state cannot enter a checkpoint', async t => {
  const root = temporary(t), chaining = new Chaining(root);
  await chaining.bind(a, { chain_id: 'work' });
  await assert.rejects(chaining.checkpoint(a, { event: 'Stop', automatic: { messages: [{ role: 'tool', text: 'Do not copy' }], git: null } }), { code: 'CHAINING_INVALID_ARGUMENT' });
  writeFileSync(join(root, 'work-state-v1.json'), '{invalid');
  await assert.rejects(save(chaining, a), { code: 'CHAINING_UNAVAILABLE' });
  assert.equal(readdirSync(chaining.store.checkpoints).length, 0);
});

test('snapshot corruption and missing pinned data fail closed without touching messages', async t => {
  const root = temporary(t), chaining = new Chaining(root);
  const journal = join(root, 'events.jsonl'); writeFileSync(journal, 'Message journal marker');
  await chaining.bind(a, { chain_id: 'work' }); const saved = await save(chaining, a);
  await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  writeFileSync(saved.path, '{broken');
  await assert.rejects(chaining.restore(a), { code: 'CHAINING_UNAVAILABLE' });
  await assert.rejects(chaining.restore(b), { code: 'CHAINING_UNAVAILABLE' });
  await assert.rejects(save(chaining, a), { code: 'CHAINING_UNAVAILABLE' });
  assert.equal(readFileSync(journal, 'utf8'), 'Message journal marker');
});

test('a snapshot with an invalid embedded work state is rejected on read', async t => {
  const root = temporary(t), chaining = new Chaining(root), work = new WorkState(root);
  state(work, a, 'Owner A marker'); await chaining.bind(a, { chain_id: 'work' });
  const saved = await save(chaining, a), value = JSON.parse(readFileSync(saved.path));
  value.structured.revision = -1; writeFileSync(saved.path, JSON.stringify(value));
  await assert.rejects(chaining.restore(a), { code: 'CHAINING_UNAVAILABLE' });
});

test('retention keeps pinned sources and claimed tickets, and only cleans the saving owner', async t => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const chaining = new Chaining(temporary(t), { now: () => time, limits: { keep_per_session: 1, retention_ms: 1000 } });
  await chaining.bind(a, { chain_id: 'work' }); const first = await save(chaining, a);
  await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  const ticket = await chaining.createTicket({ chain_id: 'work', source_session_id: a }); await chaining.claimTicket(c, ticket.ticket);
  time += 1; const second = await save(chaining, a);
  await confirm(chaining, b);
  time += 1; const other = await save(chaining, b);
  time += 3600000;
  const third = await save(chaining, a);
  assert.equal(existsSync(first.path), true); assert.equal(existsSync(second.path), false);
  assert.equal(existsSync(other.path), true); assert.equal(existsSync(third.path), true);
  assert.equal((await chaining.claimTicket(c, ticket.ticket)).status, 'owner_resume');
});

test('SessionEnd skips retention and cleanup failure does not reverse a save', async t => {
  const chaining = new Chaining(temporary(t), { limits: { keep_per_session: 1 } });
  await chaining.bind(a, { chain_id: 'work' });
  const first = await save(chaining, a);
  await save(chaining, a, 'End', 'SessionEnd');
  assert.equal(existsSync(first.path), true);
  chaining.store.cleanup = () => { throw new Error('Injected cleanup error'); };
  const result = await save(chaining, a);
  assert.equal(result.status, 'saved'); assert.match(result.warnings[0], /cleanup failed/u);
  assert.equal((await chaining.restore(a)).checkpoint.id, result.checkpoint_id);
});

test('automatic saves cannot replace a source before restore is confirmed', async t => {
  const root = temporary(t), chaining = new Chaining(root);
  const source = await chaining.bind(a, { chain_id: 'work' });
  assert.equal(source.binding.restore_pending, false);
  const saved = await save(chaining, a, 'Source marker');
  const bound = await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  assert.equal(bound.binding.restore_pending, true);
  const before = readFileSync(chaining.store.path), files = readdirSync(chaining.store.checkpoints);
  for (const event of ['Stop', 'SessionEnd', 'PreCompact']) {
    assert.deepEqual(await save(chaining, b, 'Before first restore', event), { status: 'awaiting_restore' });
    const restored = await new Chaining(root).restore(b);
    assert.equal(restored.checkpoint.id, saved.checkpoint_id);
    assert.equal(restored.checkpoint.automatic.messages[0].text, 'Source marker');
    assert.equal(restored.binding.restore_pending, true);
  }
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.deepEqual(readdirSync(chaining.store.checkpoints), files);
  assert.equal((await confirm(chaining, b)).status, 'confirmed');
  assert.equal((await new Chaining(root).status(b)).binding.restore_pending, false);
  const own = await save(chaining, b, 'Restored owner progress');
  assert.equal(own.status, 'saved');
  assert.equal((await chaining.restore(b)).checkpoint.id, own.checkpoint_id);
  assert.equal((await chaining.status(b)).binding.pinned_checkpoint_id, saved.checkpoint_id);
});

test('restore confirmation checks both binding and checkpoint and rejects stale relinks', async t => {
  const chaining = new Chaining(temporary(t));
  await chaining.bind(a, { chain_id: 'work' }); const source = await save(chaining, a);
  const bound = await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  const expected = { expected_binding_id: bound.binding.id, expected_checkpoint_id: source.checkpoint_id };
  await assert.rejects(chaining.confirmRestore(b, { ...expected, expected_binding_id: randomUUID() }), { code: 'CHAINING_CONFLICT' });
  await assert.rejects(chaining.confirmRestore(b, { ...expected, expected_checkpoint_id: randomUUID() }), { code: 'CHAINING_CONFLICT' });
  assert.equal((await chaining.status(b)).binding.restore_pending, true);
  const unlinked = await chaining.unlink(b, { expected_chain_id: 'work', expected_checkpoint_id: source.checkpoint_id });
  await assert.rejects(chaining.confirmRestore(b, expected), { code: 'CHAINING_CONFLICT' });
  await chaining.relink(b, { tombstone_id: unlinked.tombstone.id, chain_id: 'work', source_session_id: a });
  await assert.rejects(chaining.confirmRestore(b, expected), { code: 'CHAINING_CONFLICT' });
  assert.equal((await chaining.status(b)).binding.restore_pending, true);
  assert.equal((await confirm(chaining, b)).status, 'confirmed');
  assert.equal((await confirm(chaining, b)).status, 'already_confirmed');
  const current = await chaining.restore(b);
  await save(chaining, b);
  await assert.rejects(chaining.confirmRestore(b, { expected_binding_id: current.binding.id, expected_checkpoint_id: current.checkpoint.id }), { code: 'CHAINING_CONFLICT' });
});

test('legacy binding reads infer pending restore without changing the saved index', async t => {
  const chaining = new Chaining(temporary(t));
  await chaining.bind(a, { chain_id: 'work' }); await save(chaining, a);
  await chaining.bind(b, { chain_id: 'work', source_session_id: a });
  await chaining.bind(c, { chain_id: 'work', source_session_id: a }); await confirm(chaining, c); await save(chaining, c);
  const legacy = JSON.parse(readFileSync(chaining.store.path));
  for (const binding of Object.values(legacy.bindings)) delete binding.restore_pending;
  writeFileSync(chaining.store.path, JSON.stringify(legacy));
  const before = readFileSync(chaining.store.path);
  assert.equal((await chaining.status(a)).binding.restore_pending, false);
  assert.equal((await chaining.restore(b)).binding.restore_pending, true);
  assert.equal((await chaining.status(c)).binding.restore_pending, false);
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.equal((await save(chaining, b)).status, 'awaiting_restore');
});
