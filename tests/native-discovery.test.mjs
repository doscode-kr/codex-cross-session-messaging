import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAdapter } from '../plugins/cross-session/src/native.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';
import { fixture } from './helpers.mjs';

const rolloutPath = 'C:\\sessions\\rollout-한국어.jsonl';
const emptyMessage = `failed to read thread: thread-store internal error: failed to read session metadata ${rolloutPath}: rollout at ${rolloutPath} is empty`;
const emptyError = () => new CrossSessionError('NATIVE_REJECTED', emptyMessage, { rpcCode: -32603 });

function discovery(ids, read, pages) {
  const calls = [];
  const native = new NativeAdapter({ rpc: { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/loaded/list') return pages ? pages.get(params.cursor) : { data: ids, nextCursor: null };
    assert.equal(method, 'thread/read');
    return { thread: await read(params.threadId) };
  } } });
  return { native, calls };
}

const thread = id => ({ id, cwd: 'C:/project', status: { type: 'idle' } });
const reads = (calls, id) => calls.filter(call => call.method === 'thread/read' && call.params.threadId === id);

test('discovery retries one exact empty rollout read and includes the recovered session', async () => {
  let attempts = 0;
  const { native, calls } = discovery(['a', 'b'], async id => {
    if (id === 'b' && ++attempts === 1) throw emptyError();
    return thread(id);
  });
  assert.deepEqual((await native.list()).map(value => value.id), ['a', 'b']);
  assert.equal(reads(calls, 'a').length, 1);
  assert.deepEqual(reads(calls, 'b').map(call => call.params), [
    { threadId: 'b', includeTurns: false }, { threadId: 'b', includeTurns: false }
  ]);
});

test('persistent empty rollout fails the full list after two reads', async () => {
  const error = emptyError();
  const { native, calls } = discovery(['a', 'b'], async id => {
    if (id === 'b') throw error;
    return thread(id);
  });
  await assert.rejects(native.list(), value => value === error);
  assert.equal(reads(calls, 'b').length, 2);
});

test('exact matching supports drive paths, spaces and recovered child filtering', async () => {
  for (const path of ['C:\\Users\\name with spaces\\rollout.jsonl', '/tmp/name with spaces/rollout.jsonl']) {
    let attempts = 0;
    const error = new CrossSessionError('NATIVE_REJECTED', `failed to read thread: thread-store internal error: failed to read session metadata ${path}: rollout at ${path} is empty`, { rpcCode: -32603 });
    const { native, calls } = discovery(['child'], async id => {
      if (++attempts === 1) throw error;
      return { ...thread(id), parentThreadId: 'parent' };
    });
    assert.deepEqual(await native.list(), []);
    assert.equal(reads(calls, 'child').length, 2);
  }
});

test('discovery does not retry other codes or similar error messages', async () => {
  for (const error of [
    new CrossSessionError('NATIVE_TIMEOUT', emptyMessage, { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_DISCONNECTED', emptyMessage, { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_REJECTED', emptyMessage, { rpcCode: -32600 }),
    new CrossSessionError('NATIVE_REJECTED', emptyMessage, { rpcCode: -32601 }),
    new CrossSessionError('NATIVE_REJECTED', 'rollout is empty', { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_REJECTED', emptyMessage.replace(`rollout at ${rolloutPath}`, 'rollout at C:/other.jsonl'), { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_REJECTED', `${emptyMessage} (other failure)`, { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_REJECTED', emptyMessage.replace('is empty', 'is corrupt'), { rpcCode: -32603 }),
    new CrossSessionError('NATIVE_REJECTED', emptyMessage)
  ]) {
    const { native, calls } = discovery(['a'], async () => { throw error; });
    await assert.rejects(native.list(), value => value === error);
    assert.equal(reads(calls, 'a').length, 1);
  }
});

test('a different retry error propagates without a third read', async () => {
  let attempts = 0;
  const error = new CrossSessionError('NATIVE_TIMEOUT', 'read timed out');
  const { native, calls } = discovery(['a'], async () => { throw ++attempts === 1 ? emptyError() : error; });
  await assert.rejects(native.list(), value => value === error);
  assert.equal(reads(calls, 'a').length, 2);
});

test('loaded pages and batches retain root filters and explicit removal races', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `root-${index}`);
  let attempts = 0;
  const pages = new Map([
    [undefined, { data: ids.slice(0, 10), nextCursor: 'second' }],
    ['second', { data: [...ids.slice(10), 'child', 'subagent', 'unloaded', 'removed'], nextCursor: null }]
  ]);
  const { native, calls } = discovery([], async id => {
    if (id === 'root-11' && ++attempts === 1) throw emptyError();
    if (id === 'child') return { ...thread(id), parentThreadId: 'parent' };
    if (id === 'subagent') return { ...thread(id), source: { subAgent: {} } };
    if (id === 'unloaded') return { ...thread(id), status: { type: 'notLoaded' } };
    if (id === 'removed') throw new CrossSessionError('NATIVE_REJECTED', 'thread not found', { rpcCode: -32600 });
    return thread(id);
  }, pages);
  assert.deepEqual((await native.list()).map(value => value.id), ids);
  assert.deepEqual(calls.filter(call => call.method === 'thread/loaded/list').map(call => call.params), [
    { limit: 100 }, { limit: 100, cursor: 'second' }
  ]);
  assert.equal(reads(calls, 'root-11').length, 2);
  assert.equal(reads(calls, 'removed').length, 1);
});

test('loaded-list failures are not retried', async () => {
  let calls = 0;
  const error = emptyError();
  const native = new NativeAdapter({ rpc: { async request(method) {
    ++calls;
    assert.equal(method, 'thread/loaded/list');
    throw error;
  } } });
  await assert.rejects(native.list(), value => value === error);
  assert.equal(calls, 1);
});

test('repeated or cyclic session cursors fail before reading a partial list', async () => {
  for (const cycle of [['one', 'one'], ['one', 'two', 'one']]) {
    let pages = 0;
    const native = new NativeAdapter({ rpc: { async request(method) {
      assert.equal(method, 'thread/loaded/list');
      assert.ok(pages < cycle.length, 'discovery must stop at the repeated cursor');
      return { data: [`session-${pages}`], nextCursor: cycle[pages++] };
    } } });
    await assert.rejects(native.list(), { code: 'NATIVE_REJECTED', message: 'The daemon repeated a session list cursor.' });
    assert.equal(pages, cycle.length);
  }
});

test('overlapping session pages read each session once in first-seen order', async () => {
  const pages = new Map([
    [undefined, { data: ['a', 'b', 'a'], nextCursor: 'next' }],
    ['next', { data: ['b', 'c'], nextCursor: null }]
  ]);
  const { native, calls } = discovery([], async id => thread(id), pages);
  assert.deepEqual((await native.list()).map(value => value.id), ['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) assert.equal(reads(calls, id).length, 1);
});

test('a session cursor cycle cannot clear a leader or consume a subscription', async t => {
  const { native, service, store } = fixture(t);
  await service.call('claim_leader', {}, 'session-a');
  await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  const previousLive = service.live;
  const subscriptions = [...store.subscriptions.values()];
  const loop = new NativeAdapter({ rpc: { async request(method) {
    assert.equal(method, 'thread/loaded/list');
    return { data: [], nextCursor: 'same' };
  } } });
  native.list = loop.list.bind(loop);
  await assert.rejects(service.tick(), { code: 'NATIVE_REJECTED' });
  assert.equal(service.live, previousLive);
  assert.equal(store.leader, 'session-a');
  assert.deepEqual([...store.subscriptions.values()], subscriptions);
  assert.equal(native.sent.length, 1);
});

test('direct reads and delivery do not acquire discovery retries', async () => {
  for (const action of [native => native.read('a'), native => native.deliver({ id: 'message', to: { id: 'a' } })]) {
    const error = emptyError();
    const { native, calls } = discovery([], async () => { throw error; });
    await assert.rejects(action(native), value => value === error);
    assert.deepEqual(calls.map(call => call.method), ['thread/read']);
  }
});

test('persistent discovery failure preserves service live, leader, subscriptions and messages', async t => {
  const { native, service, store } = fixture(t);
  await service.call('claim_leader', {}, 'session-b');
  await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  const previousLive = service.live;
  const subscriptions = [...store.subscriptions.values()].map(value => ({ ...value }));
  const messages = [...store.messages.values()].map(value => ({ ...value }));
  const error = emptyError();
  const adapter = discovery(native.threads.map(value => value.id), async id => {
    if (id === 'session-b') throw error;
    return native.threads.find(value => value.id === id);
  });
  native.list = adapter.native.list.bind(adapter.native);
  for (const action of [() => service.tick(), () => service.call('send_message', { to: 'session-c', message: 'blocked' }, 'session-a')]) {
    await assert.rejects(action(), value => value === error);
    assert.equal(service.live, previousLive);
    assert.equal(store.leader, 'session-b');
    assert.deepEqual([...store.subscriptions.values()], subscriptions);
    assert.deepEqual([...store.messages.values()], messages);
    assert.equal(native.sent.length, 1);
  }
  assert.equal(reads(adapter.calls, 'session-b').length, 4);
});
