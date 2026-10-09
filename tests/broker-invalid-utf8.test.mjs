import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, authToken, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

async function fixture(t) {
  let broker;
  const root = temporary(t, () => broker?.close());
  const config = { ...settings({ CROSS_SESSION_HOME: root }), port: 0 };
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  config.port = broker.server.address().port;
  const token = authToken(root);
  async function post(body, path = '/call', headers = {}) {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body });
    return { status: response.status, body: await response.json() };
  }
  return { broker, native, config, post };
}

function damagedRequest(instance, bytes) {
  const parts = JSON.stringify({ instance, method: 'send_message', sessionId: 'session-a', args: { to: 'session-b', message: 'private-prefix REPLACE private-suffix' } }).split('REPLACE');
  return Buffer.concat([Buffer.from(parts[0]), Buffer.from(bytes), Buffer.from(parts[1])]);
}

test('invalid UTF-8 requests are rejected before service calls or journal changes', async t => {
  const { broker, native, config, post } = await fixture(t);
  const { store } = broker.service;
  // The snapshot includes existing state, not only an empty journal.
  store.record('leader', 'session-a');
  store.record('subscription', { id: 'saved', from: 'session-a', to: 'session-b', sawActive: true });
  const bytes = readFileSync(store.path), offset = store.offset, sub = store.subscriptions.get('saved');
  let calls = 0, lists = 0;
  const originalCall = broker.service.call.bind(broker.service);
  broker.service.call = (...args) => { calls++; return originalCall(...args); };
  const originalList = native.list.bind(native);
  native.list = (...args) => { lists++; return originalList(...args); };
  const invalid = [[0xff], [0x80], [0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xf0, 0x9f, 0x9b], [0xe2, 0x28, 0xa1]];
  for (const value of invalid) {
    const result = await post(damagedRequest(config.instance, value));
    assert.deepEqual(result, { status: 400, body: { code: 'INVALID_REQUEST', message: 'Request body must use valid UTF-8.' } });
  }
  for (const path of ['/hook', '/shutdown', '/health']) {
    const result = await post(damagedRequest(config.instance, [0xff]), path);
    assert.equal(result.body.code, 'INVALID_REQUEST');
  }
  const truncated = await post(Buffer.from([0x7b, 0xe2, 0x82]));
  assert.equal(truncated.body.code, 'INVALID_REQUEST');
  assert.equal(calls, 0);
  assert.equal(lists, 0);
  assert.equal(native.sent.length, 0);
  assert.deepEqual(readFileSync(store.path), bytes);
  assert.equal(store.offset, offset);
  assert.equal(store.leader, 'session-a');
  assert.equal(store.subscriptions.get('saved'), sub);
  assert.equal(store.messages.size, 0);
  assert.equal(broker.service.stopping, false);
  const client = new BrokerClient({ config, autoStart: false });
  assert.equal((await client.request('/health')).instance, config.instance);
  const receipt = await client.call('send_message', { to: 'session-b', message: '정상 🛰️ �' }, 'session-a');
  assert.equal(receipt.status, 'accepted');
  assert.equal(native.sent[0].text, '정상 🛰️ �');
});

test('UTF-8 validation keeps authentication, origin, instance, size, and BOM boundaries', async t => {
  const { config, post, native, broker } = await fixture(t);
  const bad = damagedRequest(config.instance, [0xff]);
  assert.equal((await post(bad, '/call', { authorization: 'Bearer wrong' })).body.code, 'AUTH_FAILED');
  assert.equal((await post(bad, '/call', { origin: 'https://example.invalid' })).body.code, 'INVALID_REQUEST');
  assert.equal((await post(Buffer.alloc(131073, 0xff))).body.code, 'REQUEST_TOO_LARGE');
  assert.equal((await post(JSON.stringify({ instance: 'wrong' }), '/health')).body.code, 'INSTANCE_MISMATCH');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ instance: config.instance }))]);
  assert.equal((await post(bom, '/health')).status, 400);
  assert.equal(native.sent.length, 0);
  assert.equal(broker.service.store.messages.size, 0);
});
