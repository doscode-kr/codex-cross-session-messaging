import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionContinuity, releaseTerminatedContinuityLock } from '../plugins/cross-session/src/chaining.mjs';
import { temporary } from './helpers.mjs';

const observedAt = '2026-10-28T08:00:00.000Z';
const automatic = {
  original_request: { role: 'user', text: 'Request', provenance: 'observed_user_record', observed_at: observedAt },
  original_request_reason: 'OBSERVED',
  recent_messages: [{ role: 'assistant', text: 'Progress', provenance: 'observed_transcript_record', observed_at: observedAt }],
  git: null
};

async function setup(t, options = {}) {
  const root = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project);
  const continuity = new SessionContinuity(root, options);
  await continuity.ensureOwnSession(owner, { project });
  return { root, project, owner, continuity };
}

const save = (continuity, owner, project, event = 'Stop') => continuity.checkpoint(owner, { project, event, automatic });

test('an exclusive lock rejects a concurrent writer and never steals an existing lock', async t => {
  const { root, project, owner, continuity } = await setup(t);
  let release;
  const held = continuity.store.transaction(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(save(new SessionContinuity(root), owner, project), { code: 'CHAINING_BUSY' });
  release(); await held;
  assert.equal((await save(continuity, owner, project)).status, 'saved');
  writeFileSync(continuity.store.lockPath, 'An old writer may still be alive');
  await assert.rejects(save(continuity, owner, project), { code: 'CHAINING_BUSY' });
  assert.equal(readFileSync(continuity.store.lockPath, 'utf8'), 'An old writer may still be alive');
});

test('simultaneous checkpoint calls either save or report busy without corrupting state', async t => {
  const { root, project, owner, continuity } = await setup(t);
  const result = await Promise.allSettled([save(continuity, owner, project), save(new SessionContinuity(root), owner, project)]);
  assert.ok(result.some(item => item.status === 'fulfilled'));
  for (const item of result) if (item.status === 'rejected') assert.equal(item.reason.code, 'CHAINING_BUSY');
  const files = readdirSync(continuity.store.checkpoints);
  assert.equal(files.length, result.filter(item => item.status === 'fulfilled').length);
  for (const file of files) assert.equal(JSON.parse(readFileSync(join(continuity.store.checkpoints, file))).owner, owner);
  assert.equal((await continuity.restore(owner, { project })).status, 'restored');
});

test('a parent releases only the exact lock of its terminated child', async t => {
  const { root, project, owner, continuity } = await setup(t), nonce = randomUUID();
  const module = JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href);
  const script = `
    import { SessionContinuity } from ${module};
    const continuity = new SessionContinuity(process.argv[1], { lock_owner_id: process.argv[2] });
    await continuity.store.transaction(() => new Promise(resolve => { process.stdin.resume(); process.stdout.write('locked'); process.stdin.once('data', resolve); }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, nonce], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  const closed = once(child, 'close'); child.kill(); await closed;
  assert.equal(releaseTerminatedContinuityLock(root, { process_id: child.pid, thread_id: 0, lock_owner_id: randomUUID() }).released, false);
  assert.equal(existsSync(continuity.store.lockPath), true);
  assert.equal(releaseTerminatedContinuityLock(root, { process_id: child.pid, thread_id: 0, lock_owner_id: nonce }).released, true);
  assert.equal(existsSync(continuity.store.lockPath), false);
  assert.equal((await save(continuity, owner, project)).status, 'saved');
});

test('separate processes cannot corrupt concurrent checkpoint commits', async t => {
  const { root, project, owner, continuity } = await setup(t);
  const module = JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href);
  const payload = JSON.stringify(automatic);
  const script = `
    import { SessionContinuity } from ${module};
    try { process.stdout.write(JSON.stringify(await new SessionContinuity(process.argv[1]).checkpoint(process.argv[2], { project: process.argv[3], event: 'Stop', automatic: JSON.parse(process.argv[4]) }))); }
    catch (error) { if (error.code !== 'CHAINING_BUSY') throw error; process.stdout.write(JSON.stringify({ status: 'busy' })); }
  `;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner, project, payload], { windowsHide: true, timeout: 10000 });
  const values = (await Promise.all([run(), run()])).map(result => JSON.parse(result.stdout));
  assert.ok(values.some(value => value.status === 'saved'));
  assert.equal(readdirSync(continuity.store.checkpoints).length, values.filter(value => value.status === 'saved').length);
  assert.equal((await continuity.restore(owner, { project })).status, 'restored');
});

test('a checkpoint quota failure preserves the state and existing checkpoint', async t => {
  const { project, owner, continuity } = await setup(t, { limits: { checkpoints: 1 } });
  const first = await save(continuity, owner, project), before = readFileSync(continuity.store.path);
  await assert.rejects(save(continuity, owner, project), { code: 'CHAINING_LIMIT' });
  assert.deepEqual(readFileSync(continuity.store.path), before);
  assert.deepEqual(readdirSync(continuity.store.checkpoints), [`${first.checkpoint_id}.json`]);
  assert.equal((await continuity.restore(owner, { project })).checkpoint.id, first.checkpoint_id);
});

test('an index commit failure preserves the previous state and latest checkpoint', async t => {
  const { project, owner, continuity } = await setup(t);
  const first = await save(continuity, owner, project), before = readFileSync(continuity.store.path);
  const original = continuity.store.writeAtomic;
  continuity.store.writeAtomic = () => { throw new Error('Injected index failure'); };
  await assert.rejects(save(continuity, owner, project), { code: 'CHAINING_UNAVAILABLE' });
  continuity.store.writeAtomic = original;
  assert.deepEqual(readFileSync(continuity.store.path), before);
  assert.equal((await continuity.restore(owner, { project })).checkpoint.id, first.checkpoint_id);
  assert.equal(existsSync(continuity.store.lockPath), false);
});

test('a partial checkpoint write never publishes an incomplete final file', async t => {
  const { root, project, owner, continuity } = await setup(t);
  const first = await save(continuity, owner, project), before = readFileSync(continuity.store.path);
  const module = JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href);
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { SessionContinuity } from ${module};
    const original = fs.writeFileSync;
    fs.writeFileSync = function(fd, data, ...args) {
      if (typeof data === 'string' && data.startsWith('{"version":1,"id":')) { original(fd, data.slice(0, 16), ...args); const error = new Error('Injected partial write'); error.code = 'ENOSPC'; throw error; }
      return original(fd, data, ...args);
    };
    syncBuiltinESMExports();
    try { await new SessionContinuity(process.argv[1]).checkpoint(process.argv[2], { project: process.argv[3], event: 'Stop', automatic: JSON.parse(process.argv[4]) }); process.exitCode = 2; }
    catch (error) { if (error.code !== 'CHAINING_UNAVAILABLE') throw error; }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner, project, JSON.stringify(automatic)], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(readFileSync(continuity.store.path), before);
  assert.deepEqual(readdirSync(continuity.store.checkpoints), [`${first.checkpoint_id}.json`]);
});

test('checkpoint publication cannot replace an existing UUID file', async t => {
  const { project, owner, continuity } = await setup(t);
  const first = await save(continuity, owner, project), before = readFileSync(first.path);
  const changed = JSON.parse(before); changed.recent_messages[0].text = 'Replacement';
  assert.throws(() => continuity.store.writeCheckpoint(changed), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(first.path), before);
});

test('a lost or corrupt index fails closed', async t => {
  const { project, owner, continuity } = await setup(t);
  const original = readFileSync(continuity.store.path);
  unlinkSync(continuity.store.path);
  await assert.rejects(continuity.status(owner, {}), { code: 'CHAINING_UNAVAILABLE' });
  assert.equal(existsSync(continuity.store.path), false);
  writeFileSync(continuity.store.path, original);
  for (const value of ['{broken', Buffer.from([0xc3, 0x28])]) {
    writeFileSync(continuity.store.path, value);
    await assert.rejects(continuity.restore(owner, { project }), { code: 'CHAINING_UNAVAILABLE' });
  }
});

test('unknown and unreadable checkpoint files are kept with warnings', async t => {
  const { project, owner, continuity } = await setup(t, { limits: { keep_per_session: 1 } });
  const unknown = join(continuity.store.checkpoints, 'unknown.txt'), unreadable = join(continuity.store.checkpoints, `${randomUUID()}.json`);
  writeFileSync(unknown, 'Keep this file'); writeFileSync(unreadable, '{broken');
  const saved = await save(continuity, owner, project);
  assert.ok(saved.warnings.some(value => value.includes('Unknown')));
  assert.ok(saved.warnings.some(value => value.includes('Unreadable')));
  assert.equal(existsSync(unknown), true); assert.equal(existsSync(unreadable), true);
});

test('a linked continuity directory cannot redirect storage', async t => {
  const root = temporary(t), outside = temporary(t), project = join(root, 'project'), owner = randomUUID();
  mkdirSync(project); mkdirSync(join(outside, 'checkpoints'));
  try { symlinkSync(outside, join(root, 'session-continuity-v1'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory link permission is not available.'); return; } throw error; }
  const continuity = new SessionContinuity(root);
  await assert.rejects(continuity.ensureOwnSession(owner, { project }), { code: 'CHAINING_UNAVAILABLE' });
  await assert.rejects(continuity.restore(owner, { project }), { code: 'CHAINING_UNAVAILABLE' });
  assert.deepEqual(readdirSync(outside), ['checkpoints']);
});

test('expired closed sessions are pruned by a later writer and do not stay protected forever', async t => {
  const root = temporary(t), project = join(root, 'project'), closedOwner = randomUUID(), currentOwner = randomUUID();
  mkdirSync(project);
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const continuity = new SessionContinuity(root, { now: () => now, limits: { retention_ms: 1000, keep_per_session: 1 } });
  await continuity.ensureOwnSession(closedOwner, { project });
  const closed = await save(continuity, closedOwner, project, 'SessionEnd');
  now += 2000;
  await continuity.ensureOwnSession(currentOwner, { project });
  assert.equal((await continuity.status(closedOwner, {})).status, 'absent');
  assert.equal(existsSync(closed.path), false);
});

test('legacy chaining-v1 is outside lock release and cleanup scope', async t => {
  const { root, continuity } = await setup(t);
  const legacy = join(root, 'chaining-v1'); mkdirSync(legacy);
  const legacyLock = join(legacy, 'write.lock'); writeFileSync(legacyLock, 'legacy');
  const result = releaseTerminatedContinuityLock(root, { process_id: 999999, thread_id: 0, lock_owner_id: randomUUID() });
  assert.equal(result.released, false);
  assert.equal(readFileSync(legacyLock, 'utf8'), 'legacy');
  assert.equal(continuity.store.directory, join(root, 'session-continuity-v1'));
});
