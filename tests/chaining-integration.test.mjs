import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, temporary, FakeNative } from './helpers.mjs';
import { Chaining } from '../plugins/cross-session/src/chaining.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

const run = promisify(execFile);
const A = '11111111-0000-4000-8000-000000000001', B = '11111111-0000-4000-8000-000000000002';
const C = '11111111-0000-4000-8000-000000000003';
const automatic = text => ({ messages: [{ role: 'assistant', text }], git: null });
function uuids(native) { native.threads.forEach((thread, index) => { thread.id = [A, B, C][index]; }); }

test('broker chain tools keep ownership and do not replace the receiving work state', async t => {
  const { service, native } = fixture(t); uuids(native);
  assert.equal((await service.call('link_chain', { chain_id: 'work' }, A)).status, 'bound_no_notes');
  const source = await service.chaining.checkpoint(A, { event: 'Stop', automatic: automatic('SOURCE-A') });
  const result = await service.call('link_chain', { chain_id: 'work', source_session_id: A }, B);
  assert.equal(result.binding.session_id, B);
  assert.equal(result.binding.source_session_id, A);
  assert.equal(result.binding.pinned_checkpoint_id, source.checkpoint_id);
  assert.equal((await service.call('get_work_state', {}, B)).state, null);
  assert.equal((await service.call('get_chain', {}, C)).status, 'unbound');
  await assert.rejects(service.call('get_chain', { session_id: A }, B), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.call('link_chain', { chain_id: 'work' }, 'not-live'), { code: 'SESSION_NOT_LIVE' });
  await assert.rejects(service.call('unlink_chain', { expected_chain_id: 'work', expected_checkpoint_id: 'none' }, B), { code: 'CHAINING_CONFLICT' });
  const unlinked = await service.call('unlink_chain', { expected_chain_id: 'work', expected_checkpoint_id: source.checkpoint_id }, B);
  assert.equal(unlinked.status, 'unlinked');
  const relinked = await service.call('relink_chain', { tombstone_id: unlinked.tombstone.id, chain_id: 'work', source_session_id: A }, B);
  assert.equal(relinked.binding.session_id, B);
  assert.equal(relinked.binding.pinned_checkpoint_id, source.checkpoint_id);
});

test('corrupt chaining storage leaves actual broker message delivery available', async t => {
  let broker;
  const root = temporary(t, () => broker?.close()), config = settings({ CROSS_SESSION_HOME: root });
  const native = new FakeNative(); uuids(native);
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  await client.call('link_chain', { chain_id: 'work' }, A);
  const path = join(root, 'chaining-v1', 'state.json');
  writeFileSync(path, '{broken-private-state');
  await assert.rejects(client.call('get_chain', {}, A), error => error.code === 'CHAINING_UNAVAILABLE' && !error.message.includes('broken-private'));
  const sent = await client.call('send_message', { to: B, message: 'delivery survives optional storage failure' }, A);
  assert.equal(sent.status, 'accepted');
  assert.equal(native.sent.length, 1);
  assert.equal((await client.call('read_messages', { direction: 'inbox' }, B)).messages[0].text, 'delivery survives optional storage failure');
  assert.equal(readFileSync(path, 'utf8'), '{broken-private-state');
});

test('actual CLI rejects launch without running an entry or changing saved checkpoints', async t => {
  const root = temporary(t), chain = new Chaining(root);
  await chain.bind(A, { chain_id: 'work' });
  await chain.checkpoint(A, { event: 'Stop', automatic: automatic('SOURCE-A-ONLY') });
  const statePath = join(root, 'chaining-v1', 'state.json');
  const before = readFileSync(statePath, 'utf8');
  const entry = join(root, 'codex fixture.mjs'), output = join(root, 'unexpected-child.json');
  writeFileSync(entry, 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(output) + ', "started");');
  await assert.rejects(run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', 'launch', '--chain-id', 'work', '--source-session-id', A, '--codex-js', entry], {
    env: { ...process.env, CROSS_SESSION_HOME: root, CODEX_THREAD_ID: A }, windowsHide: true, timeout: 10000
  }), error => {
    assert.notEqual(error.code, 0);
    assert.match(error.stdout + error.stderr, /CHAINING_LAUNCH_UNSUPPORTED/);
    return true;
  });
  assert.equal(existsSync(output), false);
  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(readdirSync(join(root, 'chaining-v1', 'checkpoints')).length, 1);
});
