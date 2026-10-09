import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { temporary } from './helpers.mjs';
import { settings, BrokerClient, authToken } from '../plugins/cross-session/src/client.mjs';

async function fixture(t, handle, timeoutMs = 1000) {
  const config = settings({ CROSS_SESSION_HOME: temporary(t) });
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push({ path: req.url, data });
    assert.equal(req.headers.authorization, `Bearer ${authToken(config.root)}`);
    assert.equal(data.instance, config.instance);
    if (req.url === '/health' && handle.health !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instance: config.instance, version: 'test', pid: 1 }));
    } else handle(req, res, config);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  config.port = server.address().port;
  return { client: new BrokerClient({ config, autoStart: false, timeoutMs }), requests, config };
}

function operation(client, path) {
  if (path === '/call') return client.call('send_message', { to: 'session-b', message: 'private request text' }, 'session-a');
  if (path === '/hook') return client.hook({ session_id: 'session-a', permission_mode: 'read-only' }, 'C:/private-project');
  return client.request('/shutdown', {});
}

for (const path of ['/call', '/hook', '/shutdown']) {
  for (const mode of ['before-headers', 'body-timeout', 'body-cut', 'invalid-json']) {
    test(`${path} ${mode} reports an unknown result without retransmission`, async t => {
      const { client, requests, config } = await fixture(t, (req, res) => {
        if (mode === 'before-headers') { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json', ...(mode === 'body-cut' ? { 'content-length': '1000' } : {}) });
        if (mode === 'invalid-json') res.end('{private response text');
        else {
          res.flushHeaders();
          res.write('{"private response text":');
          if (mode === 'body-cut') setImmediate(() => res.destroy());
        }
      }, mode === 'body-timeout' ? 300 : 1000);
      await assert.rejects(operation(client, path), error => {
        assert.equal(error.code, mode === 'invalid-json' ? 'BROKER_RESPONSE_INVALID' : 'BROKER_TIMEOUT');
        assert.equal(error.details.requestPath, path);
        assert.equal(error.details.requestOutcome, 'unknown');
        assert.match(error.message, /request result is unknown/);
        const exposed = JSON.stringify({ message: error.message, details: error.details });
        assert.ok(!exposed.includes('private response text'));
        assert.ok(!exposed.includes('private request text'));
        assert.ok(!exposed.includes(authToken(config.root)));
        return true;
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.filter(request => request.path === path).length, 1);
    });
  }
}

test('success and error bodies must be objects and error fields must be text', async t => {
  let response;
  const { client } = await fixture(t, (req, res) => {
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  for (const status of [200, 400]) {
    for (const body of [null, [], 'private response text', 4, true]) {
      response = { status, body };
      await assert.rejects(client.request('/call', {}), { code: 'BROKER_RESPONSE_INVALID' });
    }
  }
  for (const body of [{ code: 7 }, { message: {} }, { code: null }, { message: null }, { code: '' }, { message: ' ' }]) {
    response = { status: 400, body };
    await assert.rejects(client.request('/call', {}), { code: 'BROKER_RESPONSE_INVALID' });
  }
  response = { status: 400, body: { code: 'DELIVERIES_ACTIVE', message: 'Wait for delivery.', count: 2 } };
  await assert.rejects(client.request('/shutdown', {}), error => {
    assert.equal(error.code, 'DELIVERIES_ACTIVE');
    assert.equal(error.message, 'Wait for delivery.');
    assert.deepEqual(error.details, response.body);
    return true;
  });
  response = { status: 400, body: {} };
  await assert.rejects(client.request('/call', {}), { code: 'BROKER_REJECTED', message: 'The broker rejected the request.' });
  response = { status: 200, body: {} };
  assert.deepEqual(await client.request('/hook', {}), {});
  response = { status: 200, body: { messages: [], extension: true } };
  assert.deepEqual(await client.request('/call', {}), response.body);
});

test('health and shutdown responses must describe the requested broker and action', async t => {
  let body;
  const handle = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  handle.health = true;
  const { client, config } = await fixture(t, handle);
  for (const value of [{}, { instance: 'another broker' }, { instance: config.instance, version: 3 }, { instance: config.instance, pid: 0 }, { instance: config.instance, pid: '1' }]) {
    body = value;
    await assert.rejects(client.ensure(), { code: 'BROKER_RESPONSE_INVALID' });
  }
  body = { instance: config.instance, version: '0.1.0', pid: process.pid };
  assert.deepEqual(await client.ensure(), body);
  body = { instance: config.instance };
  assert.deepEqual(await client.ensure(), body);
  for (const value of [{}, { stopped: false }, { stopped: 'true' }]) {
    body = value;
    await assert.rejects(client.request('/shutdown', {}), { code: 'BROKER_RESPONSE_INVALID' });
  }
  body = { stopped: true };
  assert.deepEqual(await client.request('/shutdown', {}), body);
});
