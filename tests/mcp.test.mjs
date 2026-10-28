import test from 'node:test';
import assert from 'node:assert/strict';
import { callerIdentity, handleMcp } from '../plugins/cross-session/src/mcp.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('per-call metadata identifies the caller and overrides process environment', () => {
  assert.equal(callerIdentity({ 'x-codex-turn-metadata': { thread_id: 'exact', session_id: 'tree-root' } }, { CODEX_THREAD_ID: 'wrong' }), 'exact');
  assert.equal(callerIdentity({ sessionId: 'native-session' }, {}), 'native-session');
  assert.throws(() => callerIdentity({}, {}), { code: 'IDENTITY_MISSING' });
});

test('missing identity and queue-mode arguments fail before broker access', async () => {
  const client = { call() { throw new Error('Broker must not be called'); } };
  const result = await handleMcp({ method: 'tools/call', params: { name: 'send_message', arguments: { to: 'b', message: 'hi', mode: 'queue' } } }, client);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'INVALID_ARGUMENT');
  // Suppress environment fallback for the missing-identity case.
  const previous = process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  try {
    const missing = await handleMcp({ method: 'tools/call', params: { name: 'list_agents', arguments: {} } }, client);
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).code, 'IDENTITY_MISSING');
  } finally { if (previous !== undefined) process.env.CODEX_THREAD_ID = previous; }
});

test('MCP stdio handshake and tool discovery emit only JSON-RPC on stdout', async t => {
  const child = spawn(process.execPath, ['plugins/cross-session/src/mcp.mjs'], { windowsHide: true });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', line => responses.push(JSON.parse(line)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP timeout')), 5000);
    lines.on('line', () => { if (responses.length === 2) { clearTimeout(timer); resolve(); } });
  });
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.ok(responses[1].result.tools.some(t => t.name === 'send_message'));
  assert.ok(responses[1].result.tools.some(t => t.name === 'claim_leader'));
  lines.close();
});

const call = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args, _meta: { sessionId: 'a' } } });

test('invalid MCP input returns errors without stopping later requests', async t => {
  const child = spawn(process.execPath, ['plugins/cross-session/src/mcp.mjs'], { windowsHide: true });
  t.after(() => child.kill());
  let output = '', stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  const invalid = [null, [], [{ jsonrpc: '2.0', id: 1, method: 'ping' }], true, 42, 'text', {},
    { jsonrpc: '2.0', id: 1, method: 42 }, { jsonrpc: '2.0', id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 'ping', params: false }, { jsonrpc: '1.0', id: 1, method: 'ping' }];
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP did not exit')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end(['{', ...invalid.map(value => JSON.stringify(value)),
    '{"jsonrpc":"2.0","id":1e400,"method":"ping"}',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'after-invalid', method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping', params: [] })].join('\n') + '\n');
  assert.equal(await exit, 0, stderr);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, invalid.length + 4);
  assert.deepEqual(responses[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
  for (const response of responses.slice(1, -2)) {
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
  }
  assert.deepEqual(responses.slice(-2), [
    { jsonrpc: '2.0', id: 'after-invalid', result: {} }, { jsonrpc: '2.0', id: 0, result: {} }
  ]);
});

test('default tool text is short and full session data stays in structuredContent', async () => {
  const data = { self: 'a', leader: 'b', agents: [{ id: 'b', name: 'Peer\nwith a new line', status: 'busy', role: 'leader', sameProject: true, cwd: 'private-path', permissionMode: 'bypassPermissions', activeFlags: [] }] };
  const result = await handleMcp(call('list_agents'), { async call(name, args, id) {
    assert.equal(name, 'list_agents');
    assert.deepEqual(args, {});
    assert.equal(id, 'a');
    return data;
  } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, data);
  assert.match(result.content[0].text, /1 sessions/);
  assert.match(result.content[0].text, /Peer\\nwith a new line/);
  assert.equal(result.content[0].text.includes('private-path'), false);
  assert.equal(result.content[0].text.includes('bypassPermissions'), false);
  assert.match(result.content[0].text, /detail: true/);
});

test('message previews preserve the full body and detail returns full JSON without changing broker arguments', async () => {
  const message = { id: 'm', kind: 'message', from: { id: 'b' }, to: { id: 'a' }, status: 'accepted', text: '한글 본문\n' + 'x'.repeat(2000) };
  const client = { async call(name, args, id) {
    assert.equal(name, 'get_message');
    assert.deepEqual(args, { message_id: 'm' });
    assert.equal(id, 'a');
    return message;
  } };
  for (const args of [{ message_id: 'm' }, { message_id: 'm', detail: false }]) {
    const result = await handleMcp(call('get_message', args), client);
    assert.equal(result.structuredContent.text, message.text);
    assert.ok(result.content[0].text.length < 400);
    assert.match(result.content[0].text, /receipt not confirmed/);
    assert.match(result.content[0].text, /한글 본문\\n/);
  }
  const detailed = await handleMcp(call('get_message', { message_id: 'm', detail: true }), client);
  assert.deepEqual(JSON.parse(detailed.content[0].text), message);
  assert.deepEqual(detailed.structuredContent, message);
});

test('display options must be boolean and invalid options never reach the broker', async () => {
  for (const detail of ['true', 1, null]) {
    const result = await handleMcp(call('list_agents', { detail }), { call() { assert.fail('Unexpected broker call'); } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'INVALID_ARGUMENT');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test('all tool summaries keep delivery, receipt, leadership, and idle states separate', async () => {
  const message = { id: 'm', from: { name: 'b' }, to: { name: 'a' }, status: 'accepted', text: 'payload' };
  const cases = [
    ['register_session', {}, { id: 'a', name: 'Peer', role: 'worker' }, /Session a/],
    ['send_message', { to: 'b', message: 'payload' }, { messageId: 'm', status: 'accepted', acknowledged: false, taskCompleted: false }, /accepted\. Receipt and task completion are not confirmed/],
    ['send_message', { to: 'b', message: 'payload' }, { messageId: 'm', status: 'accepted', acknowledged: true, taskCompleted: false }, /accepted\. Receipt confirmed\. Task completion is not confirmed/],
    ['reply', { message_id: 'm', message: 'result' }, { messageId: 'reply', status: 'accepted', acknowledged: true, taskCompleted: false }, /accepted\. Receipt confirmed\. Task completion is not confirmed/],
    ['reply', { message_id: 'm', message: 'result' }, { messageId: 'reply', status: 'accepted' }, /Message reply: accepted/],
    ['read_messages', {}, { messages: [message] }, /1 messages/],
    ['read_messages', {}, { messages: [] }, /0 messages/],
    ['acknowledge', { message_id: 'm' }, { id: 'm', acknowledgedAt: 'now', taskCompleted: false }, /receipt confirmed\. Task completion is not confirmed/],
    ['claim_leader', {}, { leader: 'a' }, /Leader: a/],
    ['release_leader', {}, { leader: null }, /Leader: none/],
    ['transfer_leader', { to: 'b' }, { leader: 'b' }, /Leader: b/],
    ['notify_when_idle', { to: 'b' }, { subscriptionId: 's', to: 'b', event: 'next-idle', oneShot: true }, /Idle status does not prove task completion/],
    ['cancel_idle_notification', { subscription_id: 's' }, { cancelled: 's' }, /Subscription s: cancelled/]
  ];
  for (const [name, args, data, expected] of cases) {
    const result = await handleMcp(call(name, { ...args, detail: false }), { async call(method, brokerArgs) {
      assert.equal(method, name);
      assert.deepEqual(brokerArgs, args);
      return data;
    } });
    assert.equal(result.isError, false, name);
    assert.deepEqual(result.structuredContent, data);
    assert.match(result.content[0].text, expected);
  }
});

test('message summaries name every observed and unobserved lifecycle stage', async () => {
  const stages = {
    submission: 'recorded', targetCodex: 'accepted', recipientDisplay: 'unknown',
    recipientReceipt: 'unconfirmed', taskCompletion: 'unreported'
  };
  const result = await handleMcp(call('send_message', { to: 'b', message: 'payload', detail: false }), { async call() {
    return { messageId: 'm', status: 'accepted', acknowledged: false, taskCompleted: false, stages, idleNotification: 'unknown', reused: true };
  } });
  assert.match(result.content[0].text, /Stages: recorded; Codex accepted; display unknown; receipt unconfirmed; completion unreported/);
  assert.match(result.content[0].text, /idle notification unknown/);
  assert.match(result.content[0].text, /Existing receipt reused; no second native submission/);
});

test('history cursors reach the broker and remain available in short and detailed MCP results', async () => {
  const data = { messages: [{ id: 'older', from: { id: 'b' }, to: { id: 'a' }, status: 'uncertain', text: 'body' }], nextCursor: 'older' };
  const client = { async call(name, args, session) {
    assert.equal(name, 'read_messages');
    assert.equal(session, 'a');
    assert.deepEqual(args, { before_message_id: 'anchor', limit: 1 });
    return data;
  } };
  const short = await handleMcp(call('read_messages', { before_message_id: 'anchor', limit: 1 }), client);
  assert.equal(short.isError, false);
  assert.deepEqual(short.structuredContent, data);
  assert.match(short.content[0].text, /Older messages: before_message_id: "older"/);
  const detailed = await handleMcp(call('read_messages', { before_message_id: 'anchor', limit: 1, detail: true }), client);
  assert.deepEqual(JSON.parse(detailed.content[0].text), data);
  const invalid = await handleMcp(call('read_messages', { before_message_id: 42 }), { call() { assert.fail('Unexpected broker call'); } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.code, 'INVALID_ARGUMENT');
});
