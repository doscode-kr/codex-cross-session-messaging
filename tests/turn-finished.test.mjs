import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAdapter } from '../plugins/cross-session/src/native.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';
import { fixture } from './helpers.mjs';

function pagedAdapter(pages) {
  const calls = [];
  const native = new NativeAdapter({ rpc: { async request(method, params) {
    assert.equal(method, 'thread/turns/list');
    calls.push(params);
    const page = pages.get(params.cursor);
    assert.ok(page, `Unexpected cursor: ${params.cursor}`);
    return page;
  } } });
  return { native, calls };
}

function history(status = 'completed') {
  return new Map([
    [undefined, { data: Array.from({ length: 20 }, (_, i) => ({ id: `recent-${i}`, status: 'completed' })), nextCursor: 'second' }],
    ['second', { data: [{ id: 'older', status: 'completed' }], nextCursor: 'third' }],
    ['third', { data: [{ id: 'target', status }], nextCursor: null }]
  ]);
}

test('finished turns beyond the first twenty are found through every cursor', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const { native, calls } = pagedAdapter(history(status));
    assert.equal(await native.turnFinished('thread', 'target'), true);
    assert.deepEqual(calls, [
      { threadId: 'thread', limit: 20, sortDirection: 'desc' },
      { threadId: 'thread', limit: 20, sortDirection: 'desc', cursor: 'second' },
      { threadId: 'thread', limit: 20, sortDirection: 'desc', cursor: 'third' }
    ]);
  }
});

test('lookup stops at the target and does not report a running or unknown turn as finished', async () => {
  for (const status of ['completed', 'inProgress', 'unknown']) {
    const { native, calls } = pagedAdapter(new Map([[undefined, { data: [{ id: 'target', status }], nextCursor: 'unused' }]]));
    assert.equal(await native.turnFinished('thread', 'target'), status === 'completed');
    assert.equal(calls.length, 1);
  }
});

test('an absent target remains unfinished after the final page', async () => {
  const { native, calls } = pagedAdapter(history());
  assert.equal(await native.turnFinished('thread', 'absent'), false);
  assert.equal(calls.length, 3);
  const empty = pagedAdapter(new Map([[undefined, { data: [], nextCursor: null }]]));
  assert.equal(await empty.native.turnFinished('thread', 'target'), false);
});

test('older daemons use read-only full turn history when turns/list is unavailable', async () => {
  for (const status of ['completed', 'failed', 'interrupted', 'inProgress', undefined]) {
    const calls = [];
    const native = new NativeAdapter({ rpc: { async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/turns/list') throw new CrossSessionError('NATIVE_REJECTED', 'unknown method', { rpcCode: -32601 });
      assert.equal(method, 'thread/read');
      return { thread: { turns: status ? [{ id: 'target', status }] : [] } };
    } } });
    assert.equal(await native.turnFinished('thread', 'target'), ['completed', 'failed', 'interrupted'].includes(status));
    assert.deepEqual(calls[1], { method: 'thread/read', params: { threadId: 'thread', includeTurns: true } });
    assert.equal(calls.length, 2);
  }
});

test('page errors propagate without history fallback or delivery', async () => {
  const error = new CrossSessionError('NATIVE_TIMEOUT', 'lost response');
  let calls = 0;
  const native = new NativeAdapter({ rpc: { async request(method) {
    assert.equal(method, 'thread/turns/list');
    if (++calls === 1) return { data: [], nextCursor: 'second' };
    throw error;
  } } });
  await assert.rejects(native.turnFinished('thread', 'target'), value => value === error);
  assert.equal(calls, 2);
});

test('repeated cursors fail instead of looping or reporting completion', async () => {
  for (const nextCursor of ['second', 'third']) {
    const pages = history();
    pages.get('third').data = [];
    pages.get('third').nextCursor = nextCursor;
    const { native, calls } = pagedAdapter(pages);
    await assert.rejects(native.turnFinished('thread', 'target'), { code: 'NATIVE_REJECTED', message: 'The daemon repeated a turn history cursor.' });
    assert.equal(calls.length, 3);
  }
});

test('service sends one idle notification when the delivered turn is on an older page', async t => {
  const { service, native, store } = fixture(t);
  const pages = history('inProgress');
  pages.get('third').data[0].id = 'fake-turn';
  const lookup = pagedAdapter(pages);
  native.turnFinished = lookup.native.turnFinished.bind(lookup.native);
  await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  native.threads[1].status = { type: 'idle' };
  await service.tick();
  assert.equal(native.sent.length, 1);
  assert.equal(store.subscriptions.size, 1);
  pages.get('third').data[0].status = 'completed';
  await service.tick();
  await service.tick();
  assert.equal(native.sent.length, 2);
  assert.equal(native.sent[1].kind, 'idle-notification');
  assert.equal(native.sent[1].to.id, 'session-a');
  assert.equal(store.subscriptions.size, 0);
});
