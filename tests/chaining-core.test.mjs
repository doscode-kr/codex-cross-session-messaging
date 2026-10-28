import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';
import { resolveSessionProject } from '../plugins/cross-session/src/session-project.mjs';
import { WorkState } from '../plugins/cross-session/src/work-state.mjs';
import { temporary } from './helpers.mjs';

const automatic = (at = '2026-10-28T08:00:00.000Z', text = 'Keep this work') => ({
  original_request: { role: 'user', text: 'Build the requested change', provenance: 'observed_user_record', observed_at: at },
  original_request_reason: 'OBSERVED',
  recent_messages: [
    { role: 'user', text, provenance: 'observed_transcript_record', observed_at: at },
    { role: 'assistant', text: 'Work remains', provenance: 'observed_transcript_record', observed_at: at }
  ],
  git: null
});
const checklist = [{ title: 'Finish the work', expected_result: 'The change works', verification_method: 'Run the focused test' }];

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test('a session creates, checkpoints, and restores only its own project state', async t => {
  const root = temporary(t), owner = randomUUID(), project = join(root, 'project');
  mkdirSync(project);
  const continuity = new SessionContinuity(root, { now: () => Date.parse('2026-10-28T08:00:00.000Z') });
  const created = await continuity.ensureOwnSession(owner, { project });
  assert.equal(created.status, 'created');
  assert.equal(created.session.owner, owner);
  assert.equal(created.session.project, project);
  assert.equal((await continuity.status(owner, {})).status, 'active');

  const saved = await continuity.checkpoint(owner, { project, event: 'PreCompact', automatic: automatic() });
  assert.equal(saved.status, 'saved');
  const restored = await continuity.restore(owner, { project });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.relationship.receiving_session_id, owner);
  assert.equal(restored.checkpoint.owner, owner);
  assert.equal(restored.checkpoint.project, project);
  assert.equal(restored.checkpoint.original_request.text, 'Build the requested change');
});

test('different session UUIDs never select each other checkpoints', async t => {
  const root = temporary(t), project = join(root, 'project'), first = randomUUID(), second = randomUUID();
  mkdirSync(project);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(first, { project });
  await continuity.ensureOwnSession(second, { project });
  const firstSaved = await continuity.checkpoint(first, { project, event: 'Stop', automatic: automatic(undefined, 'first') });
  assert.equal((await continuity.restore(second, { project })).reason, 'NO_CHECKPOINT');
  const secondSaved = await continuity.checkpoint(second, { project, event: 'Stop', automatic: automatic(undefined, 'second') });
  assert.equal((await continuity.restore(first, { project })).checkpoint.id, firstSaved.checkpoint_id);
  assert.equal((await continuity.restore(second, { project })).checkpoint.id, secondSaved.checkpoint_id);
});

test('one UUID cannot change projects and a rejected request does not change state', async t => {
  const root = temporary(t), first = join(root, 'first'), second = join(root, 'second'), owner = randomUUID();
  mkdirSync(first); mkdirSync(second);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(owner, { project: first });
  const before = readFileSync(continuity.store.path);
  await assert.rejects(continuity.ensureOwnSession(owner, { project: second }), { code: 'CHAINING_PROJECT_MISMATCH' });
  await assert.rejects(continuity.restore(owner, { project: second }), { code: 'CHAINING_PROJECT_MISMATCH' });
  await assert.rejects(continuity.checkpoint(owner, { project: second, event: 'Stop', automatic: automatic() }), { code: 'CHAINING_PROJECT_MISMATCH' });
  assert.deepEqual(readFileSync(continuity.store.path), before);
});

test('status without a project is read-only and cannot restore a checkpoint', async t => {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(owner, { project });
  await continuity.checkpoint(owner, { project, event: 'Stop', automatic: automatic() });
  const before = readFileSync(continuity.store.path);
  const status = await continuity.status(owner, {});
  assert.equal(status.session.latest_checkpoint_id !== null, true);
  assert.equal(Object.hasOwn(status, 'checkpoint'), false);
  assert.deepEqual(readFileSync(continuity.store.path), before);
  await assert.rejects(continuity.restore(owner, {}), { code: 'CHAINING_INVALID_ARGUMENT' });
});

test('reset omits old and undated transcript records and old structured work', async t => {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project);
  const before = Date.parse('2026-10-28T08:00:00.000Z');
  const resetAt = Date.parse('2026-10-28T08:01:00.000Z');
  const after = '2026-10-28T08:02:00.000Z';
  new WorkState(root, { enabled: false, now: () => before }).set(owner, {
    action: 'start', expected_revision: 0, objective: 'Old objective', scope: 'Old scope',
    completion_criteria: 'Old result', next_action: 'Old next action', checklist
  });
  const continuity = new SessionContinuity(root, { now: clock(before, resetAt, Date.parse(after)) });
  await continuity.ensureOwnSession(owner, { project });
  const reset = await continuity.reset(owner, { project });
  assert.equal(reset.session.reset_at, '2026-10-28T08:01:00.000Z');
  new WorkState(root, { enabled: false, now: () => Date.parse(after) }).set(owner, {
    action: 'update', expected_revision: 1, progress_evidence: 'OLD_OBJECTIVE_BEFORE_CLEAR was updated after clear'
  });
  const saved = await continuity.checkpoint(owner, {
    project, event: 'Stop', automatic: {
      original_request: { role: 'user', text: 'Old request', provenance: 'observed_user_record', observed_at: '2026-10-28T07:59:00.000Z' },
      original_request_reason: 'OBSERVED',
      recent_messages: [
        { role: 'user', text: 'Old message', provenance: 'observed_transcript_record', observed_at: '2026-10-28T08:00:00.000Z' },
        { role: 'assistant', text: 'No timestamp', provenance: 'observed_transcript_record' },
        { role: 'user', text: 'New message', provenance: 'observed_transcript_record', observed_at: after }
      ],
      git: null
    }
  });
  const checkpoint = (await continuity.restore(owner, { project })).checkpoint;
  assert.equal(saved.status, 'saved');
  assert.equal(checkpoint.original_request, null);
  assert.equal(checkpoint.original_request_reason, 'RESET_BOUNDARY');
  assert.deepEqual(checkpoint.recent_messages.map(value => value.text), ['New message']);
  assert.equal(checkpoint.structured, null);
});

test('structured work created after reset is stored only for the same UUID', async t => {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID(), other = randomUUID();
  mkdirSync(project);
  const resetAt = Date.parse('2026-10-28T08:00:00.000Z'), workAt = Date.parse('2026-10-28T08:01:00.000Z');
  const continuity = new SessionContinuity(root, { now: () => resetAt });
  await continuity.ensureOwnSession(owner, { project });
  await continuity.reset(owner, { project });
  const work = new WorkState(root, { enabled: false, now: () => workAt });
  work.set(other, { action: 'start', expected_revision: 0, objective: 'Other', scope: 'Other', completion_criteria: 'Other', next_action: 'Other', checklist });
  work.set(owner, { action: 'start', expected_revision: 0, objective: 'Current', scope: 'Current', completion_criteria: 'Current', next_action: 'Current', checklist });
  await continuity.checkpoint(owner, { project, event: 'Stop', automatic: automatic('2026-10-28T08:02:00.000Z') });
  const restored = await continuity.restore(owner, { project });
  assert.equal(restored.checkpoint.structured.owner, owner);
  assert.equal(restored.checkpoint.structured.objective, 'Current');
});

test('SessionEnd closes the session without retention cleanup and the same UUID can reopen it', async t => {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(owner, { project });
  continuity.store.cleanup = () => { throw new Error('SessionEnd must not run cleanup'); };
  const closed = await continuity.checkpoint(owner, { project, event: 'SessionEnd', automatic: automatic() });
  assert.equal(closed.status, 'closed');
  assert.equal((await continuity.status(owner, { project })).status, 'closed');
  assert.equal((await continuity.restore(owner, { project })).checkpoint.id, closed.checkpoint_id);
  continuity.store.cleanup = () => [];
  const reopened = await continuity.ensureOwnSession(owner, { project });
  assert.equal(reopened.status, 'reopened');
  assert.equal((await continuity.restore(owner, { project })).checkpoint.id, closed.checkpoint_id);
});

test('manual chaining methods reject before any store is created', async t => {
  const root = temporary(t), continuity = new SessionContinuity(root);
  for (const method of ['bind', 'unlink', 'relink', 'createTicket', 'claimTicket', 'confirmRestore']) {
    await assert.rejects(continuity[method](), { code: 'CHAINING_SESSION_LOCAL_ONLY' });
  }
  assert.equal(existsSync(continuity.store.directory), false);
});

test('the new store never reads, changes, or removes chaining-v1 data', async t => {
  const root = temporary(t), legacy = join(root, 'chaining-v1'), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(legacy); mkdirSync(project);
  const sentinel = Buffer.from('legacy chaining data must remain byte-for-byte');
  writeFileSync(join(legacy, 'sentinel.bin'), sentinel);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(owner, { project });
  await continuity.checkpoint(owner, { project, event: 'Stop', automatic: automatic() });
  assert.deepEqual(readFileSync(join(legacy, 'sentinel.bin')), sentinel);
  assert.equal(continuity.store.directory, join(root, 'session-continuity-v1'));
});

test('automatic checkpoint input must use observed provenance', async t => {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project);
  const continuity = new SessionContinuity(root);
  await continuity.ensureOwnSession(owner, { project });
  const invalid = automatic();
  invalid.recent_messages[0].provenance = 'claimed_by_peer';
  await assert.rejects(continuity.checkpoint(owner, { project, event: 'Stop', automatic: invalid }), { code: 'CHAINING_INVALID_ARGUMENT' });
  assert.equal((await continuity.restore(owner, { project })).reason, 'NO_CHECKPOINT');
});

test('project resolution accepts one Git worktree and rejects mismatched roots', async t => {
  const root = temporary(t), first = join(root, 'first'), nested = join(first, 'nested'), second = join(root, 'second');
  mkdirSync(first); mkdirSync(nested); mkdirSync(second);
  execFileSync('git', ['init', '-q', first], { windowsHide: true });
  execFileSync('git', ['init', '-q', second], { windowsHide: true });
  assert.equal(await resolveSessionProject(nested, first), await resolveSessionProject(first, nested));
  await assert.rejects(resolveSessionProject(first, second), { code: 'CHAINING_PROJECT_MISMATCH' });
});

test('project resolution accepts matching non-Git paths and ignores inherited Git routing variables', async t => {
  const root = temporary(t), gitRoot = join(root, 'git'), nested = join(gitRoot, 'nested'), plain = join(root, 'plain');
  mkdirSync(gitRoot); mkdirSync(nested); mkdirSync(plain);
  execFileSync('git', ['init', '-q', gitRoot], { windowsHide: true });
  assert.equal(await resolveSessionProject(plain, plain), plain);
  assert.equal(await resolveSessionProject(nested, nested, { ...process.env, GIT_DIR: join(root, 'missing'), GIT_WORK_TREE: plain }), gitRoot);
  await assert.rejects(resolveSessionProject(nested, plain), { code: 'CHAINING_PROJECT_MISMATCH' });
  await assert.rejects(resolveSessionProject('relative', plain), { code: 'CHAINING_PROJECT_UNAVAILABLE' });
});

test('project resolution rejects a Git worktree root redirected outside the session path', async t => {
  const root = temporary(t), repository = join(root, 'repository'), redirected = join(root, 'redirected');
  mkdirSync(repository); mkdirSync(redirected);
  execFileSync('git', ['init', '-q', repository], { windowsHide: true });
  execFileSync('git', ['-C', repository, 'config', 'core.worktree', redirected], { windowsHide: true });
  await assert.rejects(resolveSessionProject(redirected, repository), { code: 'CHAINING_PROJECT_UNAVAILABLE' });
});
