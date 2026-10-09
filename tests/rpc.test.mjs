import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RpcSocket } from '../plugins/cross-session/src/rpc.mjs';

test('invalid RPC frames leave requests pending until a valid reply arrives', async t => {
  const ws = new EventEmitter();
  ws.send = () => {};
  const rpc = new RpcSocket(ws, null, 5000);
  t.after(() => rpc.fail(new Error('Test cleanup')));
  const requests = [], notifications = [];
  rpc.on('serverRequest', value => requests.push(value));
  rpc.on('notification', value => notifications.push(value));
  const result = rpc.request('ping');
  result.catch(() => {});
  for (const value of [null, [], [{ id: 1, result: 'bad' }], true, 42, 'text', {},
    { id: 1 }, { id: 1, result: 'bad', error: { code: -1, message: 'bad' } },
    { id: 1, error: true }, { id: 1, error: null }, { id: 1, error: { code: 'bad', message: 'bad' } },
    { id: 1, method: 42, result: 'bad' }, { method: {} }]) {
    assert.doesNotThrow(() => ws.emit('message', JSON.stringify(value)));
    assert.equal(rpc.pending.size, 1);
  }
  ws.emit('message', '{');
  ws.emit('message', '{"id":1e400,"result":"bad"}');
  ws.emit('message', JSON.stringify({ id: 999, result: 'unknown' }));
  assert.equal(rpc.pending.size, 1);
  assert.deepEqual(requests, []);
  assert.deepEqual(notifications, []);
  ws.emit('message', JSON.stringify({ id: 1, result: null }));
  assert.equal(await result, null);
  assert.equal(rpc.pending.size, 0);
  ws.emit('message', JSON.stringify({ id: 'approval', method: 'requestApproval', params: {} }));
  ws.emit('message', JSON.stringify({ method: 'turn/completed', params: {} }));
  assert.equal(requests[0].id, 'approval');
  assert.equal(notifications[0].method, 'turn/completed');
  const rejected = rpc.request('denied');
  ws.emit('message', JSON.stringify({ id: 2, error: { code: -32000, message: 'Denied', data: { reason: 'test' } } }));
  await assert.rejects(rejected, { code: 'NATIVE_REJECTED', message: 'Denied', details: { rpcCode: -32000, rpcData: { reason: 'test' } } });
});

test('synchronous RPC send failures remove pending requests and their timers', async t => {
  const active = new Set();
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    const timer = originalSet(fn, delay); active.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { active.delete(timer); originalClear(timer); });
  const ws = new EventEmitter();
  const error = new Error('Send failed');
  ws.send = () => { throw error; };
  const rpc = new RpcSocket(ws, null, 5000);
  t.after(() => { rpc.fail(new Error('Test cleanup')); for (const timer of active) originalClear(timer); });
  await assert.rejects(rpc.request('ping'), value => value === error);
  assert.equal(rpc.pending.size, 0);
  assert.equal(active.size, 0);
  const circular = {}; circular.self = circular;
  await assert.rejects(rpc.request('ping', circular), TypeError);
  assert.equal(rpc.pending.size, 0);
  assert.equal(active.size, 0);
  assert.equal(rpc.closed, false);
  ws.send = () => {};
  const success = rpc.request('ping');
  ws.emit('message', JSON.stringify({ id: 3, result: {} }));
  assert.deepEqual(await success, {});
  assert.equal(rpc.pending.size, 0);
  assert.equal(active.size, 0);
});
