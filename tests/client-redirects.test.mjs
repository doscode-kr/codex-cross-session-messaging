import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { temporary } from './helpers.mjs';
import { settings, BrokerClient, authToken } from '../plugins/cross-session/src/client.mjs';

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

for (const path of ['/call', '/hook', '/shutdown']) {
  test(`${path} rejects redirect statuses without a second request`, async t => {
    const config = settings({ CROSS_SESSION_HOME: temporary(t) });
    let status, location;
    const received = [], redirected = [];
    const destination = await listen(t, async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      redirected.push({ method: req.method, authorization: req.headers.authorization, body: Buffer.concat(parts).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"stopped":true}');
    });
    const source = await listen(t, async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      if (req.url !== path) {
        redirected.push({ method: req.method, authorization: req.headers.authorization, body: Buffer.concat(parts).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"stopped":true}');
        return;
      }
      received.push({ method: req.method, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
      res.writeHead(status, { location, 'content-type': 'application/json' });
      res.end('{"code":"REDIRECT_BODY_CODE","message":"private response text"}');
    });
    config.port = source.address().port;
    const client = new BrokerClient({ config, autoStart: false });
    for (const target of ['same-origin', 'other-port']) {
      for (const code of [301, 302, 303, 307, 308]) {
        status = code;
        location = target === 'same-origin' ? '/redirected?private-location' : `http://127.0.0.1:${destination.address().port}/redirected?private-location`;
        const before = received.length;
        await assert.rejects(client.request(path, { privateText: 'private request text' }), error => {
          assert.equal(error.code, 'BROKER_RESPONSE_INVALID');
          assert.equal(error.details.httpStatus, status);
          assert.equal(error.details.requestOutcome, 'unknown');
          assert.equal(error.details.requestPath, path);
          const exposed = JSON.stringify({ message: error.message, details: error.details });
          for (const value of ['private request text', 'private response text', 'private-location', authToken(config.root)]) assert.ok(!exposed.includes(value));
          return true;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(received.length, before + 1);
        assert.equal(received.at(-1).method, 'POST');
        assert.equal(received.at(-1).authorization, `Bearer ${authToken(config.root)}`);
        assert.equal(received.at(-1).body.privateText, 'private request text');
        assert.equal(redirected.length, 0);
      }
    }
  });
}

test('a redirect body does not have to finish before the client rejects it', async t => {
  const config = settings({ CROSS_SESSION_HOME: temporary(t) });
  let received = 0;
  const server = await listen(t, async (req, res) => {
    for await (const part of req) {}
    received++;
    res.writeHead(307, { location: '/redirected', 'content-type': 'application/json' });
    res.flushHeaders(); res.write('{');
  });
  config.port = server.address().port;
  const client = new BrokerClient({ config, autoStart: false, timeoutMs: 1000 });
  await assert.rejects(client.request('/shutdown', {}), { code: 'BROKER_RESPONSE_INVALID' });
  assert.equal(received, 1);
});

test('a redirect to the same request path is not followed', async t => {
  const config = settings({ CROSS_SESSION_HOME: temporary(t) });
  let received = 0;
  const server = await listen(t, async (req, res) => {
    for await (const part of req) {}
    received++;
    res.writeHead(308, { location: '/call', 'content-type': 'application/json' });
    res.end('{}');
  });
  config.port = server.address().port;
  const client = new BrokerClient({ config, autoStart: false });
  await assert.rejects(client.request('/call', {}), { code: 'BROKER_RESPONSE_INVALID' });
  assert.equal(received, 1);
});
