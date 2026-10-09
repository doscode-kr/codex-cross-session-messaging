import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { settings, authToken, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { readBrokerStatus } from '../plugins/cross-session/src/diagnostics.mjs';
import { temporary, FakeNative } from './helpers.mjs';

const run = promisify(execFile);
const cli = resolve('plugins/cross-session/src/cli.mjs');

test('status CLI leaves missing state and missing token untouched', async t => {
  const root = temporary(t);
  for (const home of [join(root, 'missing', 'nested'), root]) {
    const result = await run(process.execPath, [cli, 'broker-status'], { env: { ...process.env, CROSS_SESSION_HOME: home }, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), { status: 'offline', reason: 'STATE_MISSING' });
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(root), []);
    assert.equal(existsSync(join(home, 'auth-token')), false);
  }
});

test('status uses memory metrics without native queries or journal writes', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const env = { CROSS_SESSION_HOME: root };
  const config = settings(env);
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  await client.call('send_message', { to: 'session-b', message: 'private message body' }, 'session-a');
  native.list = async () => { throw new Error('Status must not query the daemon'); };
  const before = new Map(readdirSync(root).map(file => [file, readFileSync(join(root, file))]));
  const originalRecord = broker.service.store.record;
  broker.service.store.record = () => { throw new Error('Status must not write journal events'); };
  try {
    const result = await run(process.execPath, [cli, 'broker-status'], { env: { ...process.env, ...env }, windowsHide: true });
    const status = JSON.parse(result.stdout);
    assert.equal(status.status, 'running');
    assert.deepEqual(status.diagnostics, {
      stopping: false,
      journal: { committedBytes: broker.service.store.offset, failureCode: null },
      counts: { messages: 1, registeredSessions: 0, idleSubscriptions: 0, pendingDeliveries: 0, pendingIdleChecks: 0 }
    });
    assert.equal(result.stdout.includes('private message body'), false);
    assert.equal(result.stdout.includes(authToken(root)), false);
    assert.equal(result.stdout.includes(root), false);
    assert.equal((await client.request('/health', {})).diagnostics, undefined);
    broker.service.store.failure = Object.assign(new Error('private file path'), { code: 'EIO' });
    assert.equal((await readBrokerStatus({ env })).status, 'degraded');
    assert.equal((await readBrokerStatus({ env })).diagnostics.journal.failureCode, 'EIO');
    broker.service.store.failure = new Error('private file path');
    assert.equal((await readBrokerStatus({ env })).diagnostics.journal.failureCode, 'STORE_UNAVAILABLE');
    broker.service.stopping = true;
    assert.equal((await readBrokerStatus({ env })).status, 'stopping');
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes);
    assert.deepEqual(readdirSync(root), [...before.keys()]);
  } finally { broker.service.store.record = originalRecord; }
});

test('offline status does not start a broker and invalid tokens stay errors', async t => {
  const root = temporary(t);
  const env = { CROSS_SESSION_HOME: root };
  const config = settings(env);
  authToken(root);
  const result = await readBrokerStatus({ env });
  assert.deepEqual(result, { status: 'offline', reason: 'BROKER_OFFLINE' });
  assert.deepEqual(readdirSync(root), ['auth-token']);
  writeFileSync(join(config.root, 'auth-token'), 'invalid');
  await assert.rejects(readBrokerStatus({ env }), { code: 'TOKEN_INVALID' });
  await assert.rejects(run(process.execPath, [cli, 'broker-status'], { env: { ...process.env, ...env }, windowsHide: true }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).code, 'TOKEN_INVALID');
    return true;
  });
  assert.equal(readFileSync(join(root, 'auth-token'), 'utf8'), 'invalid');
});

test('status supports legacy health and preserves authentication and malformed reply errors', async t => {
  let server;
  const root = temporary(t, () => new Promise(done => server.close(done)));
  const env = { CROSS_SESSION_HOME: root };
  const config = settings(env);
  const token = authToken(root);
  let mode = 'legacy';
  let diagnostics;
  let rejectedCode = 'AUTH_FAILED';
  server = createServer(async (req, res) => {
    assert.equal(req.url, '/health');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = ''; for await (const part of req) raw += part;
    assert.deepEqual(JSON.parse(raw), { instance: config.instance, diagnostics: true });
    res.setHeader('content-type', 'application/json');
    if (mode === 'auth') { res.writeHead(403); res.end(JSON.stringify({ code: rejectedCode, message: 'Denied' })); }
    else if (mode === 'invalid') res.end('null');
    else res.end(JSON.stringify({ version: '0.1.0', instance: config.instance, pid: process.pid, diagnostics }));
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(config.port, '127.0.0.1', yes); });
  assert.deepEqual(await readBrokerStatus({ env }), { status: 'running', version: '0.1.0', pid: process.pid, diagnostics: null });
  mode = 'auth';
  for (const code of ['AUTH_FAILED', 'INSTANCE_MISMATCH', 'ENOENT', 'BROKER_OFFLINE', 'EACCES']) {
    rejectedCode = code;
    await assert.rejects(readBrokerStatus({ env }), { code });
  }
  mode = 'invalid';
  await assert.rejects(readBrokerStatus({ env }), { code: 'BROKER_RESPONSE_INVALID' });
  mode = 'legacy';
  const valid = { stopping: false, journal: { committedBytes: 0, failureCode: null }, counts: { messages: 0, registeredSessions: 0, idleSubscriptions: 0, pendingDeliveries: 0, pendingIdleChecks: 0 } };
  for (const value of [[], true, 'secret', {}, { ...valid, stopping: 1 }, { ...valid, journal: { committedBytes: -1, failureCode: null } }, { ...valid, counts: { ...valid.counts, messages: 1.5 } }, { ...valid, journal: { committedBytes: 0, failureCode: 'private/path' } }]) {
    diagnostics = value;
    await assert.rejects(readBrokerStatus({ env }), { code: 'BROKER_RESPONSE_INVALID' });
  }
  diagnostics = { ...valid, body: 'private body', journal: { ...valid.journal, path: 'private path' }, counts: { ...valid.counts, token } };
  assert.deepEqual((await readBrokerStatus({ env })).diagnostics, valid);
});
