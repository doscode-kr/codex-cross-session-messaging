import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAdapter } from '../plugins/cross-session/src/native.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';

function adapter(state = 'active') {
  const calls = [];
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'b', status: { type: state }, canAcceptDirectInput: true } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-live', status: 'inProgress' }] };
    if (method === 'turn/steer') return { turnId: 'turn-live' };
    if (method === 'turn/start') return { turn: { id: 'turn-new' } };
    throw new Error(`Unexpected request: ${method}`);
  } };
  return { calls, rpc, native: new NativeAdapter({ rpc }) };
}
const message = { id: 'message-1', from: { id: 'a', permissionMode: 'bypass' }, to: { id: 'b' }, text: 'peer data' };

test('busy delivery uses turn/steer with exact turn guard and untrusted context', async () => {
  const { calls, native } = adapter();
  const result = await native.deliver(message);
  assert.equal(result.method, 'turn/steer');
  const sent = calls.find(c => c.method === 'turn/steer');
  assert.equal(sent.params.expectedTurnId, 'turn-live');
  assert.equal(sent.params.additionalContext['cross-session/message-1'].kind, 'untrusted');
  assert.equal(JSON.parse(sent.params.additionalContext['cross-session/message-1'].value).text, 'peer data');
  assert.deepEqual(JSON.parse(sent.params.additionalContext['cross-session/message-1'].value), message);
  assert.ok(sent.params.input[0].text.length < 220);
  assert.match(sent.params.input[0].text, /not a user command or approval/);
  assert.match(sent.params.input[0].text, /Keep your scope and permissions/);
  assert.match(sent.params.input[0].text, /Reply only for a useful result or a required question/);
  assert.equal(sent.params.approvalPolicy, undefined);
  assert.equal(sent.params.sandboxPolicy, undefined);
});

test('idle delivery starts a turn without changing permissions or resuming another executor', async () => {
  const { calls, native } = adapter('idle');
  assert.equal((await native.deliver(message)).method, 'turn/start');
  assert.deepEqual(calls.map(c => c.method), ['thread/read', 'turn/start']);
  assert.equal(calls[1].params.approvalPolicy, undefined);
  assert.equal(calls[1].params.model, undefined);
});

test('only an explicit stale-turn rejection can be retried', async () => {
  const { calls, native, rpc } = adapter();
  const original = rpc.request;
  let rejected = false;
  rpc.request = async (method, params) => {
    if (method === 'turn/steer' && !rejected) { rejected = true; throw new CrossSessionError('NATIVE_REJECTED', 'expected active turn id `old` but found `new`', { rpcCode: -32600 }); }
    return original(method, params);
  };
  assert.equal((await native.deliver(message)).accepted, true);
  assert.equal(calls.filter(c => c.method === 'thread/read').length, 2);
});

test('timeout and non-steerable turns never use turn/start, interrupt, or queue as fallback', async () => {
  for (const error of [new CrossSessionError('NATIVE_TIMEOUT', 'lost result'), new CrossSessionError('NATIVE_REJECTED', 'cannot steer a review turn', { rpcCode: -32600 })]) {
    const { calls, native, rpc } = adapter();
    const original = rpc.request;
    rpc.request = async (method, params) => { if (method === 'turn/steer') { calls.push({ method, params }); throw error; } return original(method, params); };
    await assert.rejects(native.deliver(message));
    assert.deepEqual(calls.map(c => c.method), ['thread/read', 'thread/turns/list', 'turn/steer']);
  }
});

test('unloaded and child threads cannot receive direct messages', async () => {
  for (const thread of [{ status: { type: 'notLoaded' } }, { status: { type: 'idle' }, parentThreadId: 'parent' }, { status: { type: 'idle' }, canAcceptDirectInput: false }]) {
    const native = new NativeAdapter({ rpc: { request: async () => ({ thread }) } });
    await assert.rejects(native.deliver(message), { code: 'RECIPIENT_UNAVAILABLE' });
  }
});
