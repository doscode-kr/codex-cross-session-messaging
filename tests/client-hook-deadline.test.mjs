import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { temporary } from './helpers.mjs';
import { authToken, BrokerClient } from '../plugins/cross-session/src/client.mjs';

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

test('hook total deadline bounds sequential health and hook requests', { timeout: 15000 }, async t => {
  const root = temporary(t), requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    for await (const _chunk of req) { /* consume the request body */ }
    await wait(1600);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/health' ? { instance: config.instance } : {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }));
  const config = { root, instance: 'deadline-fixture', port: server.address().port };
  authToken(root);
  const client = new BrokerClient({ config, autoStart: false, timeoutMs: 2500 });

  const oldStarted = Date.now();
  await client.request('/health', {});
  await client.request('/hook', { input: {}, projectRoot: null });
  assert.ok(Date.now() - oldStarted >= 3000, 'Independent per-request limits reproduce a total delay above three seconds.');

  requests.length = 0;
  const started = Date.now();
  await assert.rejects(client.hook({ hook_event_name: 'UserPromptSubmit' }, undefined, { totalTimeoutMs: 2100 }), { code: 'BROKER_TIMEOUT' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1900 && elapsed < 2800, `The total hook deadline was not enforced: ${elapsed} ms`);
  assert.deepEqual(requests, ['/health', '/hook']);

  requests.length = 0;
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { ...descriptor, value: undefined });
  try {
    const fallbackStarted = Date.now();
    await assert.rejects(client.hook({ hook_event_name: 'UserPromptSubmit' }, undefined, { totalTimeoutMs: 400 }), { code: 'BROKER_TIMEOUT' });
    assert.ok(Date.now() - fallbackStarted < 1200, 'The Node 20.0 signal fallback must enforce the same total deadline.');
    assert.deepEqual(requests, ['/health']);
  } finally { Object.defineProperty(AbortSignal, 'any', descriptor); }
});
