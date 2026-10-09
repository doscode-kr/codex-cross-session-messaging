import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary, FakeNative } from './helpers.mjs';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { settings } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

function history(t) {
  let store;
  const root = temporary(t, () => store.close());
  const native = new FakeNative();
  store = new Store(root);
  const service = new MessagingService(store, native);
  return { service, get store() { return store; }, restart() {
    store.close(); store = new Store(root); store.recover(); service.store = store;
  } };
}
const id = index => `m-${String(index).padStart(3, '0')}`;
function add(store, index, from = 'session-b', to = 'session-a') {
  store.record('message', { id: id(index), kind: 'message', from: { id: from }, to: { id: to },
    text: `한글 본문 😀 ${index}`, createdAt: index % 2 ? '2025-01-01T00:00:00Z' : '2026-01-01T00:00:00Z', status: 'accepted' });
}
const ids = result => result.messages.map(message => message.id);
const range = (start, end) => Array.from({ length: end - start }, (_, i) => id(start + i));

test('history pages keep insertion boundaries across new messages, updates and restart', async t => {
  const h = history(t);
  for (let i = 0; i < 205; i++) add(h.store, i);
  const first = await h.service.call('read_messages', { limit: 100 }, 'session-a');
  assert.deepEqual(ids(first), range(105, 205));
  assert.equal(first.nextCursor, id(105));
  add(h.store, 205);
  h.store.record('ack', { id: id(105), at: 'acknowledged' });
  h.store.record('delivery', { id: id(5), status: 'uncertain' });
  h.restart();
  const second = await h.service.call('read_messages', { limit: 100, before_message_id: first.nextCursor }, 'session-a');
  assert.deepEqual(ids(second), range(5, 105));
  assert.equal(second.nextCursor, id(5));
  assert.equal(second.messages[0].status, 'uncertain');
  const third = await h.service.call('read_messages', { limit: 100, before_message_id: second.nextCursor }, 'session-a');
  assert.deepEqual(ids(third), range(0, 5));
  assert.equal(third.nextCursor, null);
  assert.equal((await h.service.call('read_messages', { before_message_id: id(0) }, 'session-a')).nextCursor, null);
  assert.deepEqual(ids(await h.service.call('read_messages', {}, 'session-a')), range(186, 206));
  assert.equal(h.service.native.sent.length, 0);
});

test('owned cursors remain valid when direction and acknowledgment filters change', async t => {
  const h = history(t);
  add(h.store, 0); add(h.store, 1, 'session-a', 'session-b');
  add(h.store, 2, 'session-b', 'session-c'); add(h.store, 3);
  add(h.store, 4, 'session-a', 'session-c'); add(h.store, 5);
  const latest = await h.service.call('read_messages', { direction: 'both', limit: 2 }, 'session-a');
  assert.deepEqual(ids(latest), [id(4), id(5)]);
  assert.equal(latest.nextCursor, id(4));
  const inbox = await h.service.call('read_messages', { before_message_id: latest.nextCursor, unacknowledged_only: true }, 'session-a');
  assert.deepEqual(ids(inbox), [id(0), id(3)]);
  await h.service.call('acknowledge', { message_id: id(3) }, 'session-a');
  const changed = await h.service.call('read_messages', { before_message_id: latest.nextCursor, unacknowledged_only: true }, 'session-a');
  assert.deepEqual(ids(changed), [id(0)]);
  const outbox = await h.service.call('read_messages', { direction: 'outbox', before_message_id: id(5), limit: 1 }, 'session-a');
  assert.deepEqual(ids(outbox), [id(4)]);
  assert.equal(outbox.nextCursor, id(4));
  assert.deepEqual(ids(await h.service.call('read_messages', { direction: 'outbox', before_message_id: outbox.nextCursor }, 'session-a')), [id(1)]);
  const empty = await h.service.call('read_messages', { direction: 'outbox', before_message_id: id(1) }, 'session-a');
  assert.deepEqual(empty, { messages: [], nextCursor: null });
});

test('history reads bodies only for returned messages and never for invalid cursors', async t => {
  const h = history(t);
  for (let i = 0; i < 130; i++) add(h.store, i, 'session-b', i % 2 ? 'session-a' : 'session-c');
  const read = t.mock.method(h.store, 'readEvent');
  const latest = await h.service.call('read_messages', { limit: 3 }, 'session-a');
  assert.deepEqual(ids(latest), [id(125), id(127), id(129)]);
  assert.equal(read.mock.callCount(), 0);
  JSON.stringify(latest);
  assert.equal(read.mock.callCount(), 3);
  const earlier = await h.service.call('read_messages', { limit: 1, before_message_id: latest.nextCursor }, 'session-a');
  assert.deepEqual(ids(earlier), [id(123)]);
  assert.equal(read.mock.callCount(), 3);
  JSON.stringify(earlier);
  assert.equal(read.mock.callCount(), 4);
  const errors = [];
  for (const cursor of [id(128), 'missing-id']) {
    await assert.rejects(h.service.call('read_messages', { before_message_id: cursor }, 'session-a'), error => {
      errors.push({ code: error.code, message: error.message, details: error.details }); return error.code === 'MESSAGE_NOT_FOUND';
    });
  }
  assert.deepEqual(errors[0], errors[1]);
  for (const cursor of ['', null, 42, 'x'.repeat(201)]) {
    await assert.rejects(h.service.call('read_messages', { before_message_id: cursor }, 'session-a'), { code: 'INVALID_ARGUMENT' });
  }
  for (const limit of [0, 101, 1.5]) {
    await assert.rejects(h.service.call('read_messages', { limit }, 'session-a'), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(read.mock.callCount(), 4);
});

test('shell CLI forwards before-message-id to the isolated broker', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  for (let i = 0; i < 3; i++) add(broker.service.store, i);
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath,
    ['plugins/cross-session/src/cli.mjs', 'read_messages', '--session', 'session-a', '--limit', '1', ...args],
    { env: { ...process.env, CROSS_SESSION_HOME: config.root }, windowsHide: true })).stdout);
  const first = await run([]);
  assert.deepEqual(ids(first), [id(2)]);
  const older = await run(['--before-message-id', first.nextCursor]);
  assert.deepEqual(ids(older), [id(1)]);
  assert.equal(older.nextCursor, id(1));
});
