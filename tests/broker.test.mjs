import test from 'node:test';
import assert from 'node:assert/strict';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, BrokerClient, authToken } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

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
