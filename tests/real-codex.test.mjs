import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { temporary } from './helpers.mjs';
import { NativeAdapter, resolveCodex } from '../plugins/cross-session/src/native.mjs';
import { RpcSocket } from '../plugins/cross-session/src/rpc.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';

const require = createRequire(new URL('../plugins/cross-session/package.json', import.meta.url));
const WebSocket = require('ws');
async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for the isolated Codex server');
}
async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
test('real isolated Codex delivers busy and idle peer messages and direct worker collaboration', { skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 60000 }, async t => {
  let child, rpc, model, broker;
  const root = temporary(t, async () => {
    await broker?.close();
    rpc?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; }
    if (model) await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); });
  });
  const requests = [];
  const pending = [];
  let releaseImmediately = false;
  let responseId = 0;
  const event = (res, value) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const finish = (res, id) => {
    if (res.destroyed || res.writableEnded) return;
    event(res, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'local test reply' }] } });
    event(res, { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  };
  model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const id = `response-${++responseId}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { type: 'response.created', response: { id } });
    if (releaseImmediately) finish(res, id);
    else pending.push([res, id]);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const bin = resolveCodex();
  const isolatedHome = join(root, 'codex-home');
  mkdirSync(isolatedHome);
  const execute = promisify(execFile);
  const env = { ...process.env, CODEX_HOME: isolatedHome };
  await execute(bin.command, [...bin.args, 'plugin', 'marketplace', 'add', resolve('.'), '--json'], { env, windowsHide: true, timeout: 15000 });
  await execute(bin.command, [...bin.args, 'plugin', 'add', 'cross-session@cross-session-local', '--json'], { env, windowsHide: true, timeout: 15000 });
  const config = {
    model_provider: 'local_mock', model: 'fake-model',
    'model_providers.local_mock.name': 'Local test only',
    'model_providers.local_mock.base_url': `http://127.0.0.1:${model.address().port}/v1`,
    'model_providers.local_mock.wire_api': 'responses',
    'model_providers.local_mock.requires_openai_auth': false,
    'model_providers.local_mock.supports_websockets': false
  };
  child = spawn(bin.command, [...bin.args, 'app-server', '--listen', `ws://127.0.0.1:${port}`, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], {
    windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-5000); });
  const ws = await waitFor(() => new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', () => resolve(false));
  })).catch(error => { throw new Error(`${error.message}: ${stderr}`); });
  rpc = new RpcSocket(ws, undefined, 15000);
  await rpc.request('initialize', { clientInfo: { name: 'cross_session_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  rpc.write({ method: 'initialized' });
  const start = () => rpc.request('thread/start', { cwd: root, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' });
  const a = (await start()).thread;
  const b = (await start()).thread;
  const leader = (await start()).thread;
  const inventory = await rpc.request('mcpServerStatus/list', { threadId: b.id });
  assert.ok(inventory.data.some(server => Object.values(server.tools ?? {}).some(tool => tool.name === 'send_message')), 'Installed plugin exposes its messaging tool in a real Codex thread');
  const native = new NativeAdapter({ rpc });
  await rpc.request('turn/start', { threadId: b.id, input: [{ type: 'text', text: 'Remain active for the local test.' }] });
  await waitFor(() => requests.length > 0);
  const envelope = { id: 'test-peer-busy', from: { id: a.id }, to: { id: b.id }, text: 'busy-peer-marker-검증' };
  const busy = await native.deliver(envelope);
  assert.equal(busy.method, 'turn/steer');
  releaseImmediately = true;
  for (const [res, id] of pending) finish(res, id);
  await waitFor(async () => (await native.read(b.id)).status.type === 'idle');
  const idle = await native.deliver({ ...envelope, id: 'test-peer-idle', text: 'idle-peer-marker-검증' });
  assert.equal(idle.method, 'turn/start');
  await waitFor(() => requests.some(request => JSON.stringify(request.input).includes('idle-peer-marker-검증')));
  await waitFor(async () => (await native.read(b.id)).status.type === 'idle');
  const inputs = requests.map(request => JSON.stringify(request.input)).join('\n');
  assert.ok(inputs.includes('busy-peer-marker-검증'), 'Busy peer body reached the model request');
  assert.ok(inputs.includes('idle-peer-marker-검증'), 'Idle peer body reached the model request');
  assert.notEqual(a.id, b.id);

  const runtime = join(root, 'broker');
  mkdirSync(runtime);
  const brokerConfig = { root: runtime, instance: 'isolated-collaboration', port: await freePort() };
  broker = await startBroker({ config: brokerConfig, native, intervalMs: 0 });
  const client = new BrokerClient({ config: brokerConfig, autoStart: false });
  const call = (sessionId, name, args = {}) => handleMcp({ method: 'tools/call', params: {
    name, arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: sessionId } }
  } }, client);
  const success = async (sessionId, name, args) => {
    const result = await call(sessionId, name, args);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  await success(leader.id, 'claim_leader');
  const direct = await success(a.id, 'send_message', { to: b.id, message: 'private-worker-question-검증' });
  assert.equal(direct.delivery.method, 'turn/start');
  assert.equal(direct.acknowledged, false);
  assert.equal(direct.taskCompleted, false);
  await waitFor(() => requests.some(request => JSON.stringify(request.input).includes('private-worker-question-검증')));
  await waitFor(async () => (await native.read(b.id)).status.type === 'idle');
  const reply = await success(b.id, 'reply', { message_id: direct.messageId, message: 'private-worker-answer-검증' });
  await waitFor(() => requests.some(request => JSON.stringify(request.input).includes('private-worker-answer-검증')));
  await waitFor(async () => (await native.read(a.id)).status.type === 'idle');
  const savedReply = await success(a.id, 'get_message', { message_id: reply.messageId });
  assert.equal(savedReply.to.id, a.id);
  assert.equal(savedReply.replyTo, direct.messageId);
  for (const name of ['get_message', 'acknowledge']) {
    const denied = await call(leader.id, name, { message_id: direct.messageId });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, 'MESSAGE_NOT_FOUND');
  }
  assert.equal((await success(leader.id, 'read_messages')).messages.length, 0);
  const report = await success(b.id, 'send_message', { to: 'leader', message: 'agreed-worker-summary-검증' });
  await waitFor(() => requests.some(request => JSON.stringify(request.input).includes('agreed-worker-summary-검증')));
  await waitFor(async () => (await native.read(leader.id)).status.type === 'idle');
  const reports = (await success(leader.id, 'read_messages')).messages;
  assert.deepEqual(reports.map(message => message.id), [report.messageId]);
  assert.equal(reports[0].from.id, b.id);
  assert.equal(reports[0].to.id, leader.id);
  const leaderInput = JSON.stringify(requests.find(request => JSON.stringify(request.input).includes('agreed-worker-summary-검증')).input);
  assert.ok(!leaderInput.includes('private-worker-question-검증'));
  assert.ok(!leaderInput.includes('private-worker-answer-검증'));
  assert.equal(broker.service.store.messages.size, 3);
  assert.equal(broker.service.store.leader, leader.id);
});
