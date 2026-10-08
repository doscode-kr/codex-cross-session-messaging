import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { connectProxy } from '../plugins/cross-session/src/rpc.mjs';

const require = createRequire(new URL('../plugins/cross-session/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

test('byte proxy performs WebSocket upgrade and leaves user approval requests unanswered', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const received = [];
  server.on('connection', ws => ws.on('message', bytes => {
    const request = JSON.parse(String(bytes));
    received.push(request);
    if (request.method === 'initialize') {
      ws.send(JSON.stringify({ id: request.id, result: { userAgent: 'test' } }));
      ws.send(JSON.stringify({ id: 'approval-request', method: 'item/commandExecution/requestApproval', params: { threadId: 'b' } }));
    }
  }));
  const child = spawn(process.execPath, ['-e', `const net=require('node:net');const s=net.connect(${server.address().port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));`], { windowsHide: true });
  let rpc;
  t.after(async () => { rpc?.close(); child.kill(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  rpc = await connectProxy(child, 2000);
  const approval = new Promise(resolve => rpc.once('serverRequest', resolve));
  assert.equal((await rpc.request('initialize', { clientInfo: { name: 'test' } })).userAgent, 'test');
  assert.equal((await approval).id, 'approval-request');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(received.some(value => value.id === 'approval-request'), false);
});
