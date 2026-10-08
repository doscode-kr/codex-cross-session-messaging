import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, BrokerClient, authToken } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

async function postChunks(broker, chunks) {
  const { config } = broker;
  let response;
  const complete = new Promise((resolve, reject) => {
    response = request({ hostname: '127.0.0.1', port: config.port, path: '/call', method: 'POST', headers: {
      authorization: `Bearer ${authToken(config.root)}`, 'content-type': 'application/json',
    } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
      res.on('error', reject);
    });
    response.on('error', reject);
  });
  const received = new Promise(resolve => broker.server.once('request', req => {
    let count = 0;
    req.on('data', () => {
      count++;
      if (count < chunks.length) response.write(chunks[count]);
      else { response.end(); resolve(count); }
    });
  }));
  response.write(chunks[0]);
  const result = await complete;
  return { ...result, chunks: await received };
}

test('broker preserves Korean and emoji split across HTTP chunks', { timeout: 10000 }, async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  const message = '한글 🛰️ message';
  const body = Buffer.from(JSON.stringify({ instance: config.instance, method: 'send_message', sessionId: 'session-a', args: { to: 'session-b', message } }));
  const cuts = [body.indexOf(Buffer.from('한')) + 1, body.indexOf(Buffer.from('🛰')) + 2];
  const result = await postChunks(broker, [body.subarray(0, cuts[0]), body.subarray(cuts[0], cuts[1]), body.subarray(cuts[1])]);
  assert.equal(result.chunks, 3);
  assert.equal(result.status, 200);
  assert.equal(broker.service.native.sent[0].text, message);
  assert.equal(broker.service.store.messages.get(result.body.messageId).text, message);
});

test('broker measures its request limit in bytes before delivery', { timeout: 10000 }, async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  const base = JSON.stringify({ instance: config.instance, method: 'send_message', sessionId: 'session-a', args: { to: 'session-b', message: '한글' } });
  const padded = Buffer.from(base + ' '.repeat(131072 - Buffer.byteLength(base)));
  const exact = await postChunks(broker, [padded]);
  assert.equal(exact.status, 200);
  const over = await postChunks(broker, [Buffer.concat([padded, Buffer.from(' ')])]);
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'REQUEST_TOO_LARGE');
  assert.equal(broker.service.native.sent.length, 1);
});

test('authenticated broker serializes claims, delivers across projects, and rejects token mismatch', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  const results = await Promise.allSettled(['session-a', 'session-b'].map(id => client.call('claim_leader', {}, id)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const sent = await client.call('send_message', { to: 'session-b', message: '한글과 "인용" 및 줄바꿈\n다음 줄' }, 'session-a');
  assert.equal(sent.delivery.method, 'turn/start');
  assert.equal(broker.service.native.sent[0].text, '한글과 "인용" 및 줄바꿈\n다음 줄');
  const rejected = await fetch(`http://127.0.0.1:${config.port}/health`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403);
  assert.equal(authToken(config.root), authToken(config.root));
  await assert.rejects(startBroker({ config, native: new FakeNative(), intervalMs: 0 }), { code: 'EADDRINUSE' });
});
