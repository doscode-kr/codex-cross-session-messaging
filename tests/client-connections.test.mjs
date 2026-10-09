import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

test('one client can use a fixed port through repeated broker restarts', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  config.port = 0;
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  config.port = broker.server.address().port;
  const client = new BrokerClient({ config, autoStart: false });
  for (let i = 0; i < 20; i++) {
    await client.request('/health', {});
    await broker.close();
    broker = await startBroker({ config, native, intervalMs: 0 });
    const sent = await client.call('send_message', { to: 'session-b', message: `restart:${i}:한글😀` }, 'session-a');
    assert.equal(sent.status, 'accepted');
    assert.equal(broker.service.store.messages.get(sent.messageId).text, `restart:${i}:한글😀`);
  }
  assert.equal(native.sent.length, 20);
});

for (const path of ['/call', '/hook']) {
  test(`a lost ${path} response does not cause automatic retransmission`, async t => {
    const config = settings({ CROSS_SESSION_HOME: temporary(t) });
    let processed = 0;
    const connections = [];
    const server = createServer(async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      connections.push(req.headers.connection);
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ instance: config.instance }));
      } else {
        assert.equal(req.url, path);
        assert.equal(data.instance, config.instance);
        processed++;
        req.socket.destroy();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
    config.port = server.address().port;
    const client = new BrokerClient({ config, autoStart: false });
    const request = path === '/call'
      ? client.call('send_message', { to: 'session-b', message: 'lost reply' }, 'session-a')
      : client.hook({ session_id: 'session-a', permission_mode: 'read-only' }, 'C:/project-a');
    await assert.rejects(request, { code: 'BROKER_TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(processed, 1);
    assert.deepEqual(connections, ['close', 'close']);
  });
}
