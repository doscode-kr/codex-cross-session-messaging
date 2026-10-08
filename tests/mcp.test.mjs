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
