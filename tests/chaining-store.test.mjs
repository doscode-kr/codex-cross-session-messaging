import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chaining, releaseTerminatedChainingLock } from '../plugins/cross-session/src/chaining.mjs';
import { temporary } from './helpers.mjs';

const automatic = { messages: [], git: null };
const save = (chaining, owner) => chaining.checkpoint(owner, { event: 'Stop', automatic });
async function setup(t, limits) {
  const root = temporary(t), owner = randomUUID(), chaining = new Chaining(root, { limits });
  await chaining.bind(owner, { chain_id: 'work' });
  return { root, owner, chaining };
}

test('an exclusive lock rejects a concurrent writer and never steals an existing lock', async t => {
  const { root, owner, chaining } = await setup(t);
  let release;
  const held = chaining.store.transaction(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(save(new Chaining(root), owner), { code: 'CHAINING_BUSY' });
  release(); await held;
  assert.equal((await save(chaining, owner)).status, 'saved');
  writeFileSync(chaining.store.lockPath, 'An old writer may still be alive');
  await assert.rejects(save(chaining, owner), { code: 'CHAINING_BUSY' });
  assert.equal(readFileSync(chaining.store.lockPath, 'utf8'), 'An old writer may still be alive');
});

test('simultaneous checkpoint calls save once or explicitly reject without corrupting state', async t => {
  const { root, owner, chaining } = await setup(t);
  const result = await Promise.allSettled([save(chaining, owner), save(new Chaining(root), owner)]);
  assert.ok(result.some(item => item.status === 'fulfilled'));
  for (const item of result) if (item.status === 'rejected') assert.equal(item.reason.code, 'CHAINING_BUSY');
  const files = readdirSync(chaining.store.checkpoints);
  assert.equal(files.length, result.filter(item => item.status === 'fulfilled').length);
  for (const file of files) assert.equal(JSON.parse(readFileSync(join(chaining.store.checkpoints, file))).session_id, owner);
  assert.equal((await chaining.restore(owner)).status, 'restored');
});

test('a parent can release only the exact lock of its terminated child', async t => {
  const { root, owner, chaining } = await setup(t), nonce = randomUUID();
  const script = `
    import { Chaining } from ${JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href)};
    const chaining = new Chaining(process.argv[1], { lock_owner_id: process.argv[2] });
    await chaining.store.transaction(() => new Promise(resolve => { process.stdin.resume(); process.stdout.write('locked'); process.stdin.once('data', resolve); }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, nonce], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  assert.equal((await chaining.usage()).lock_present, true);
  const closed = once(child, 'close'); child.kill(); await closed;
  assert.equal(releaseTerminatedChainingLock(root, { process_id: child.pid, thread_id: 0, lock_owner_id: randomUUID() }).released, false);
  assert.equal((await chaining.usage()).lock_present, true);
  assert.equal(releaseTerminatedChainingLock(root, { process_id: child.pid, thread_id: 0, lock_owner_id: nonce }).released, true);
  assert.equal((await chaining.usage()).lock_present, false);
  assert.equal((await save(chaining, owner)).status, 'saved');
});

test('separate processes cannot corrupt concurrent checkpoint commits', async t => {
  const { root, owner, chaining } = await setup(t);
  const script = `
    import { Chaining } from ${JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href)};
    try { process.stdout.write(JSON.stringify(await new Chaining(process.argv[1]).checkpoint(process.argv[2], { event: 'Stop', automatic: { messages: [], git: null } }))); }
    catch (error) { if (error.code !== 'CHAINING_BUSY') throw error; process.stdout.write(JSON.stringify({ status: 'busy' })); }
  `;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner], { windowsHide: true, timeout: 10000 });
  const results = await Promise.all([run(), run()]);
  const values = results.map(result => JSON.parse(result.stdout));
  assert.ok(values.some(value => value.status === 'saved'));
  const files = readdirSync(chaining.store.checkpoints);
  assert.equal(files.length, values.filter(value => value.status === 'saved').length);
  for (const file of files) assert.equal(JSON.parse(readFileSync(join(chaining.store.checkpoints, file))).session_id, owner);
  assert.equal((await chaining.restore(owner)).status, 'restored');
});

test('checkpoint count quota rejects before retention or deletion', async t => {
  const { owner, chaining } = await setup(t, { checkpoints: 2, keep_per_session: 1 });
  const first = await save(chaining, owner);
  await chaining.checkpoint(owner, { event: 'SessionEnd', automatic });
  const before = readFileSync(chaining.store.path);
  await assert.rejects(save(chaining, owner), { code: 'CHAINING_LIMIT' });
  assert.equal(existsSync(first.path), true);
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.equal(readdirSync(chaining.store.checkpoints).length, 2);
});

test('a departing lock contender does not prevent a checkpoint commit', async t => {
  const { root, owner, chaining } = await setup(t);
  const script = `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { Chaining } from ${JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href)};
    const chaining = new Chaining(process.argv[1]);
    const temporary = join(chaining.store.directory, 'lock-123-0-${randomUUID()}.tmp');
    fs.writeFileSync(temporary, 'Contender');
    const original = fs.readdirSync;
    let removed = false;
    fs.readdirSync = function(path, ...args) {
      const names = original(path, ...args);
      if (!removed && path === chaining.store.directory) { fs.unlinkSync(temporary); removed = true; }
      return names;
    };
    syncBuiltinESMExports();
    process.stdout.write(JSON.stringify(await chaining.checkpoint(process.argv[2], { event: 'Stop', automatic: { messages: [], git: null } })));
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner], { windowsHide: true, timeout: 10000 });
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.status, 'saved');
  assert.equal((await chaining.restore(owner)).checkpoint.id, saved.checkpoint_id);
  assert.deepEqual(readdirSync(chaining.store.checkpoints), [`${saved.checkpoint_id}.json`]);
});

test('inventory still rejects missing durable files and inaccessible lock temporary files', async t => {
  const { root, owner, chaining } = await setup(t);
  const first = await save(chaining, owner), before = readFileSync(chaining.store.path);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { Chaining } from ${JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href)};
    const chaining = new Chaining(process.argv[1]);
    const original = fs.lstatSync;
    const temporary = join(chaining.store.directory, 'lock-123-0-${randomUUID()}.tmp');
    fs.writeFileSync(temporary, 'Keep');
    for (const [target, code] of [[chaining.store.markerPath, 'ENOENT'], [process.argv[3], 'ENOENT'], [temporary, 'EACCES']]) {
      fs.lstatSync = function(path, ...args) {
        if (path === target) throw Object.assign(new Error('Injected inventory error'), { code });
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      await assert.rejects(chaining.checkpoint(process.argv[2], { event: 'Stop', automatic: { messages: [], git: null } }), { code: 'CHAINING_UNAVAILABLE' });
    }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner, first.path], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.deepEqual(readdirSync(chaining.store.checkpoints), [`${first.checkpoint_id}.json`]);
  assert.equal((await chaining.restore(owner)).checkpoint.id, first.checkpoint_id);
});

test('byte quota checks checkpoint and new index together before writing any checkpoint', async t => {
  const { owner, chaining } = await setup(t);
  const before = readFileSync(chaining.store.path);
  chaining.store.limits.total_bytes = (await chaining.usage()).bytes + 100;
  await assert.rejects(save(chaining, owner), { code: 'CHAINING_LIMIT' });
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.deepEqual(readdirSync(chaining.store.checkpoints), []);
});

test('an index commit failure preserves its previous binding and checkpoint', async t => {
  const { owner, chaining } = await setup(t);
  const first = await save(chaining, owner), before = readFileSync(chaining.store.path);
  const original = chaining.store.writeAtomic;
  chaining.store.writeAtomic = () => { throw new Error('Injected index failure'); };
  await assert.rejects(save(chaining, owner), { code: 'CHAINING_UNAVAILABLE' });
  chaining.store.writeAtomic = original;
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.equal((await chaining.restore(owner)).checkpoint.id, first.checkpoint_id);
  assert.equal(existsSync(first.path), true);
  assert.equal(existsSync(chaining.store.lockPath), false);
});

test('failed or concurrent confirmation keeps the source pending', async t => {
  const { root, owner, chaining } = await setup(t), target = randomUUID();
  const source = await save(chaining, owner);
  const bound = await chaining.bind(target, { chain_id: 'work', source_session_id: owner });
  const expected = { expected_binding_id: bound.binding.id, expected_checkpoint_id: source.checkpoint_id };
  const before = readFileSync(chaining.store.path), original = chaining.store.writeAtomic;
  chaining.store.writeAtomic = () => { throw new Error('Injected confirmation failure'); };
  await assert.rejects(chaining.confirmRestore(target, expected), { code: 'CHAINING_UNAVAILABLE' });
  chaining.store.writeAtomic = original;
  assert.deepEqual(readFileSync(chaining.store.path), before);
  let release;
  const held = chaining.store.transaction(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(new Chaining(root).confirmRestore(target, expected), { code: 'CHAINING_BUSY' });
  release(); await held;
  assert.equal((await new Chaining(root).restore(target)).binding.restore_pending, true);
  assert.equal((await save(chaining, target)).status, 'awaiting_restore');
  assert.equal((await chaining.restore(target)).checkpoint.id, source.checkpoint_id);
  assert.equal(readdirSync(chaining.store.checkpoints).length, 1);
});

test('invalid pending restore states fail closed', async t => {
  const { owner, chaining } = await setup(t);
  const source = await save(chaining, owner), target = randomUUID();
  await chaining.bind(target, { chain_id: 'work', source_session_id: owner });
  const original = JSON.parse(readFileSync(chaining.store.path));
  for (const change of [
    state => { state.bindings[target].restore_pending = 'true'; },
    state => { state.bindings[target].latest_checkpoint_id = source.checkpoint_id; },
    state => { state.bindings[owner].restore_pending = true; }
  ]) {
    const invalid = structuredClone(original); change(invalid);
    writeFileSync(chaining.store.path, JSON.stringify(invalid));
    await assert.rejects(chaining.restore(target), { code: 'CHAINING_UNAVAILABLE' });
  }
});

test('a partial checkpoint write never publishes an incomplete final file', async t => {
  const { root, owner, chaining } = await setup(t);
  const first = await save(chaining, owner), before = readFileSync(chaining.store.path);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { Chaining } from ${JSON.stringify(new URL('../plugins/cross-session/src/chaining.mjs', import.meta.url).href)};
    const original = fs.writeFileSync;
    fs.writeFileSync = function(fd, data, ...args) {
      if (typeof data === 'string' && data.startsWith('{"version":1,"id":')) {
        original(fd, data.slice(0, 16), ...args);
        const error = new Error('Injected partial write'); error.code = 'ENOSPC'; throw error;
      }
      return original(fd, data, ...args);
    };
    syncBuiltinESMExports();
    try { await new Chaining(process.argv[1]).checkpoint(process.argv[2], { event: 'Stop', automatic: { messages: [], git: null } }); process.exitCode = 2; }
    catch (error) { if (error.code !== 'CHAINING_UNAVAILABLE') throw error; }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, owner], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(readFileSync(chaining.store.path), before);
  assert.deepEqual(readdirSync(chaining.store.checkpoints), [`${first.checkpoint_id}.json`]);
  assert.equal((await chaining.restore(owner)).checkpoint.id, first.checkpoint_id);
});

test('checkpoint publication cannot replace an existing UUID file', async t => {
  const { owner, chaining } = await setup(t);
  const first = await save(chaining, owner), before = readFileSync(first.path);
  const changed = JSON.parse(before); changed.automatic.messages = [{ role: 'user', text: 'Replacement' }];
  assert.throws(() => chaining.store.writeCheckpoint(changed), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(first.path), before);
});

test('a lost index does not reset bindings or tombstones', async t => {
  const { owner, chaining } = await setup(t);
  await chaining.unlink(owner, { expected_chain_id: 'work', expected_checkpoint_id: null });
  unlinkSync(chaining.store.path);
  await assert.rejects(chaining.status(owner), { code: 'CHAINING_UNAVAILABLE' });
  await assert.rejects(chaining.bind(owner, { chain_id: 'other' }), { code: 'CHAINING_UNAVAILABLE' });
  assert.equal(existsSync(chaining.store.path), false);
});

test('corrupt index data and malformed UTF-8 fail closed', async t => {
  const { owner, chaining } = await setup(t);
  const original = readFileSync(chaining.store.path);
  for (const data of ['{broken', Buffer.from([0xc3, 0x28]), JSON.stringify({ version: 1, bindings: {}, tombstones: {}, tickets: {}, extra: true })]) {
    writeFileSync(chaining.store.path, data);
    await assert.rejects(chaining.status(owner), { code: 'CHAINING_UNAVAILABLE' });
    await assert.rejects(save(chaining, owner), { code: 'CHAINING_UNAVAILABLE' });
  }
  writeFileSync(chaining.store.path, original);
  assert.equal((await chaining.status(owner)).status, 'bound_no_notes');
});

test('unknown and unreadable checkpoint files are kept with a warning', async t => {
  const { owner, chaining } = await setup(t, { keep_per_session: 1 });
  const unknown = join(chaining.store.checkpoints, 'unknown.txt'), unreadable = join(chaining.store.checkpoints, `${randomUUID()}.json`);
  writeFileSync(unknown, 'Keep this file'); writeFileSync(unreadable, '{broken');
  const saved = await save(chaining, owner);
  assert.ok(saved.warnings.some(text => text.includes('Unknown')));
  assert.ok(saved.warnings.some(text => text.includes('Unreadable')));
  assert.equal(existsSync(unknown), true); assert.equal(existsSync(unreadable), true);
});

test('a linked chaining directory cannot redirect storage', async t => {
  const root = temporary(t), outside = temporary(t), owner = randomUUID();
  mkdirSync(join(outside, 'checkpoints'));
  try { symlinkSync(outside, join(root, 'chaining-v1'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory link permission is not available.'); return; } throw error; }
  const chaining = new Chaining(root);
  await assert.rejects(chaining.bind(owner, { chain_id: 'work' }), { code: 'CHAINING_UNAVAILABLE' });
  await assert.rejects(chaining.restore(owner), { code: 'CHAINING_UNAVAILABLE' });
  assert.deepEqual(readdirSync(outside), ['checkpoints']);
});
