import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, temporary, FakeNative } from './helpers.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

const run = promisify(execFile);
const A = '11111111-0000-4000-8000-000000000001', B = '11111111-0000-4000-8000-000000000002';
const C = '11111111-0000-4000-8000-000000000003';
function uuids(native) { native.threads.forEach((thread, index) => { thread.id = [A, B, C][index]; }); }

test('broker continuity status reads only the calling session', async t => {
  const { service, native } = fixture(t); uuids(native);
  const calls = [];
  service.chaining = { async status(...args) {
    calls.push(args);
    return { status: 'active', reason: 'SESSION_ACTIVE', session: { owner: args[0] } };
  } };
  const result = await service.call('get_chain', {}, B);
  assert.equal(result.session.owner, B);
  assert.equal(result.mode, 'session_local');
  assert.equal(result.owner, B);
  assert.deepEqual(calls, [[B, {}]]);
  await assert.rejects(service.call('get_chain', { session_id: A }, B), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(calls, [[B, {}]]);
});

test('legacy service methods fail before native or continuity access', async t => {
  const { service, native } = fixture(t); uuids(native);
  native.list = async () => { assert.fail('Legacy methods must not refresh native sessions.'); };
  service.chaining = new Proxy({}, { get() { assert.fail('Legacy methods must not access continuity storage.'); } });
  for (const method of ['link_chain', 'unlink_chain', 'relink_chain']) {
    await assert.rejects(service.call(method, { arbitrary: 'value' }, A), { code: 'CHAINING_SESSION_LOCAL_ONLY' });
  }
});

test('actual broker reports session-local continuity and keeps messaging available', async t => {
  let broker;
  const root = temporary(t, () => broker?.close()), config = settings({ CROSS_SESSION_HOME: root });
  const native = new FakeNative(); uuids(native);
  broker = await startBroker({ config, native, intervalMs: 0 });
  await broker.service.chaining.ensureOwnSession(A, { project: root });
  const client = new BrokerClient({ config, autoStart: false });
  const status = await client.call('get_chain', {}, A);
  assert.equal(status.status, 'active');
  assert.equal(status.mode, 'session_local');
  assert.equal(status.owner, A);
  assert.equal(status.session.owner, A);
  const sent = await client.call('send_message', { to: B, message: 'messaging remains independent' }, A);
  assert.equal(sent.status, 'accepted');
  assert.equal(native.sent.length, 1);
  assert.equal((await client.call('read_messages', { direction: 'inbox' }, B)).messages[0].text, 'messaging remains independent');
});

test('actual CLI rejects legacy launch without changing old storage or starting a process', async t => {
  const root = temporary(t), legacy = join(root, 'chaining-v1');
  mkdirSync(legacy, { recursive: true });
  const statePath = join(legacy, 'state.json');
  writeFileSync(statePath, '{"legacy":true}\n');
  const before = readFileSync(statePath, 'utf8');
  const entry = join(root, 'codex fixture.mjs'), output = join(root, 'unexpected-child.json');
  writeFileSync(entry, 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(output) + ', "started");');
  await assert.rejects(run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', 'launch', '--source-session-id', A, '--codex-js', entry], {
    env: { ...process.env, CROSS_SESSION_HOME: root, CODEX_THREAD_ID: A }, windowsHide: true, timeout: 10000
  }), error => {
    assert.notEqual(error.code, 0);
    assert.match(error.stdout + error.stderr, /CHAINING_SESSION_LOCAL_ONLY/);
    return true;
  });
  assert.equal(existsSync(output), false);
  assert.equal(readFileSync(statePath, 'utf8'), before);
});
