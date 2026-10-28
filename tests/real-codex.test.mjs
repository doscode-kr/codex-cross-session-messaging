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
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';

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
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  const start = (cwd = projectA) => rpc.request('thread/start', { cwd, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' });
  const a = (await start(projectA)).thread;
  const b = (await start(projectB)).thread;
  const leader = (await start(projectA)).thread;
  const inventory = await rpc.request('mcpServerStatus/list', { threadId: b.id });
  assert.ok(inventory.data.some(server => Object.values(server.tools ?? {}).some(tool => tool.name === 'send_message')), 'Installed plugin exposes its messaging tool in a real Codex thread');
  const deliveryCalls = [];
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (['turn/start', 'turn/steer'].includes(method) && params.clientUserMessageId) deliveryCalls.push({ method, params });
    return request(method, params);
  };
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
  assert.ok(inputs.includes('crossSessionBoundary') && inputs.includes('untrusted'), 'The model receives the peer trust boundary');
  assert.ok(inputs.includes('userApproval') && inputs.includes('false'), 'The model receives the user approval boundary');
  assert.ok(inputs.includes('permissions') && inputs.includes('unchanged'), 'The model receives the permission boundary');
  assert.ok(inputs.includes('taskCompletion') && inputs.includes('unreported'), 'The model receives the completion boundary');
  for (const marker of ['busy-peer-marker-검증', 'idle-peer-marker-검증']) {
    const first = JSON.stringify(requests.find(request => JSON.stringify(request.input).includes(marker)).input);
    assert.equal(first.split(marker).length - 1, 1, `${marker} appears once in its delivered model input`);
  }
  const history = (await rpc.request('thread/read', { threadId: b.id, includeTurns: true })).thread;
  const notices = history.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage').flatMap(item => item.content).filter(item => item.type === 'text' && item.text.startsWith('Session message test-peer-'));
  assert.deepEqual(notices, [], 'Normal peer delivery does not save a second visible lookup notice');
  assert.deepEqual(deliveryCalls.find(call => call.params.clientUserMessageId === 'test-peer-busy').params.input, [{ type: 'text', text: '' }]);
  assert.deepEqual(deliveryCalls.find(call => call.params.clientUserMessageId === 'test-peer-idle').params.input, []);
  assert.notEqual(a.id, b.id);

  const runtime = join(root, 'broker');
  mkdirSync(runtime);
  const brokerConfig = { root: runtime, instance: 'isolated-collaboration', port: await freePort() };
  broker = await startBroker({ config: brokerConfig, native, intervalMs: 0 });
  const client = new BrokerClient({ config: brokerConfig, autoStart: false });
  let dropNextAckReply = false;
  let droppedAckResult;
  const call = async (sessionId, name, args = {}) => {
    const result = await handleMcp({ method: 'tools/call', params: {
      name, arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: sessionId } }
    } }, client);
    if (dropNextAckReply && name === 'acknowledge') {
      dropNextAckReply = false;
      droppedAckResult = result;
      return { isError: true, structuredContent: { code: 'SIMULATED_ACK_RESPONSE_LOST' } };
    }
    return result;
  };
  const success = async (sessionId, name, args) => {
    const result = await call(sessionId, name, args);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  await success(leader.id, 'claim_leader');
  const projectAgents = await success(a.id, 'list_agents');
  assert.equal(projectAgents.agents.find(agent => agent.id === b.id).sameProject, false, 'An exact UUID selects a recipient in another project.');
  const directArgs = { to: b.id, message: 'private-worker-question-검증', request_id: '88888888-8888-4888-8888-888888888888' };
  const direct = await success(a.id, 'send_message', directArgs);
  assert.equal(direct.delivery.method, 'turn/start');
  assert.equal(direct.acknowledged, false);
  assert.equal(direct.taskCompleted, false);
  assert.equal(direct.stages.submission, 'recorded');
  assert.equal(direct.stages.targetCodex, 'accepted');
  assert.equal(direct.stages.recipientDisplay, 'unknown');
  assert.equal(direct.stages.taskCompletion, 'unreported');
  await waitFor(() => requests.some(request => JSON.stringify(request.input).includes('private-worker-question-검증')));
  await waitFor(async () => (await native.read(b.id)).status.type === 'idle');
  const directInputs = requests.filter(request => JSON.stringify(request.input).includes('private-worker-question-검증')).length;
  const recoveredDirect = await success(a.id, 'send_message', directArgs);
  assert.equal(recoveredDirect.reused, true);
  assert.equal(requests.filter(request => JSON.stringify(request.input).includes('private-worker-question-검증')).length, directInputs);
  assert.equal(deliveryCalls.filter(call => call.params.clientUserMessageId === direct.messageId).length, 1, 'A same-request retry makes no second native submission.');
  dropNextAckReply = true;
  const lostAckResponse = await call(b.id, 'acknowledge', { message_id: direct.messageId });
  assert.equal(lostAckResponse.isError, true);
  assert.equal(lostAckResponse.structuredContent.code, 'SIMULATED_ACK_RESPONSE_LOST');
  const recoveredAck = await success(b.id, 'acknowledge', { message_id: direct.messageId });
  const savedAfterAckRetry = await success(b.id, 'get_message', { message_id: direct.messageId });
  assert.ok(droppedAckResult.structuredContent.acknowledgedAt);
  assert.equal(recoveredAck.acknowledgedAt, droppedAckResult.structuredContent.acknowledgedAt, 'A repeated acknowledgement keeps the first saved receipt time.');
  assert.equal(savedAfterAckRetry.acknowledgedAt, droppedAckResult.structuredContent.acknowledgedAt);
  assert.equal(recoveredAck.taskCompleted, false);
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

  const archived = (await start(projectB)).thread;
  await rpc.request('thread/archive', { threadId: archived.id });
  const archivedResult = await call(a.id, 'send_message', {
    to: archived.id, message: 'archived-target-marker-검증', request_id: '99999999-9999-4999-8999-999999999999'
  });
  assert.equal(archivedResult.isError, true);
  assert.equal(archivedResult.structuredContent.code, 'RECIPIENT_NOT_FOUND');

  let ambiguousNames = true;
  const list = native.list.bind(native);
  native.list = async () => (await list()).map(thread => [a.id, b.id].includes(thread.id) && ambiguousNames ? { ...thread, name: 'ambiguous-real-host-name' } : thread);
  const ambiguous = await call(leader.id, 'send_message', {
    to: 'ambiguous-real-host-name', message: 'ambiguous-target-marker-검증', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  });
  ambiguousNames = false;
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.code, 'AMBIGUOUS_RECIPIENT');

  const closesBeforeDelivery = (await start(projectB)).thread;
  const originalDeliver = native.deliver.bind(native);
  const closeRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  native.deliver = async envelope => {
    if (envelope.id === closeRequestId) await rpc.request('thread/archive', { threadId: envelope.to.id });
    return originalDeliver(envelope);
  };
  const closeArgs = { to: closesBeforeDelivery.id, message: 'close-before-delivery-marker-검증', request_id: closeRequestId };
  const closedFirst = await call(a.id, 'send_message', closeArgs);
  assert.equal(closedFirst.isError, true);
  assert.equal(closedFirst.structuredContent.code, 'DELIVERY_FAILED');
  const closedRecovered = await call(a.id, 'send_message', closeArgs);
  assert.equal(closedRecovered.isError, true);
  assert.equal(closedRecovered.structuredContent.code, 'DELIVERY_FAILED');
  assert.equal(closedRecovered.structuredContent.status, 'failed');
  assert.equal(closedRecovered.structuredContent.reused, true);
  assert.equal(deliveryCalls.filter(call => call.params.clientUserMessageId === closeRequestId).length, 0);
  assert.equal(requests.some(modelRequest => JSON.stringify(modelRequest.input).includes(closeArgs.message)), false);

  const timeoutRecipient = (await start(projectB)).thread;
  const timeoutRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  native.deliver = async envelope => {
    const accepted = await originalDeliver(envelope);
    if (envelope.id === timeoutRequestId) {
      // The real host accepted this input. This simulates loss at the adapter
      // result boundary, not loss of an actual network frame.
      throw new CrossSessionError('NATIVE_TIMEOUT', 'Simulated adapter result loss after real host acceptance.');
    }
    return accepted;
  };
  const timeoutArgs = { to: timeoutRecipient.id, message: 'accepted-result-lost-marker-검증', request_id: timeoutRequestId };
  const timeoutFirst = await call(a.id, 'send_message', timeoutArgs);
  assert.equal(timeoutFirst.isError, true);
  assert.equal(timeoutFirst.structuredContent.code, 'DELIVERY_UNCERTAIN');
  await waitFor(() => requests.some(modelRequest => JSON.stringify(modelRequest.input).includes(timeoutArgs.message)));
  const timeoutRecovered = await call(a.id, 'send_message', timeoutArgs);
  assert.equal(timeoutRecovered.isError, true);
  assert.equal(timeoutRecovered.structuredContent.code, 'DELIVERY_UNCERTAIN');
  assert.equal(timeoutRecovered.structuredContent.status, 'uncertain');
  assert.equal(timeoutRecovered.structuredContent.reused, true);
  assert.equal(deliveryCalls.filter(call => call.params.clientUserMessageId === timeoutRequestId).length, 1);
});
