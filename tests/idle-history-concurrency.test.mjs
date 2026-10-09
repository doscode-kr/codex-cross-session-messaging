import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, temporary, FakeNative } from './helpers.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { settings } from '../plugins/cross-session/src/client.mjs';

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request waited for unrelated turn history')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function watched(service, native) {
  const sent = await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  native.threads[1].status = { type: 'idle' };
  return sent;
}

test('slow idle history does not block sends, reads, acknowledgments or cancellation', async t => {
  const { service, native, store } = fixture(t);
  const sent = await watched(service, native);
  const entered = gate(), blocked = gate();
  native.turnFinished = async () => { entered.release(); await blocked.promise; return true; };
  const tick = service.tick();
  try {
    await entered.promise;
    assert.equal((await promptly(service.call('send_message', { to: 'session-a', message: 'independent' }, 'session-c'))).status, 'accepted');
    assert.equal((await promptly(service.call('read_messages', {}, 'session-b'))).messages[0].id, sent.messageId);
    await promptly(service.call('acknowledge', { message_id: sent.messageId }, 'session-b'));
    const [sub] = store.subscriptions.values();
    await promptly(service.call('cancel_idle_notification', { subscription_id: sub.id }, 'session-a'));
  } finally { blocked.release(); await tick; }
  assert.equal(store.subscriptions.size, 0);
  assert.equal(native.sent.filter(m => m.kind === 'idle-notification').length, 0);
});

test('overlapping idle checks share history and send only one notification', async t => {
  const { service, native } = fixture(t);
  await watched(service, native);
  const entered = gate(), blocked = gate();
  let calls = 0;
  native.turnFinished = async () => { calls++; entered.release(); await blocked.promise; return true; };
  const first = service.tick();
  await entered.promise;
  const second = service.tick();
  try { await service.serial; assert.equal(calls, 1); }
  finally { blocked.release(); await Promise.all([first, second]); }
  assert.equal(native.sent.filter(m => m.kind === 'idle-notification').length, 1);
  assert.equal(service.idleChecks.size, 0);
});

test('late history does not notify when the target became busy without another call', async t => {
  const { service, native, store } = fixture(t);
  await watched(service, native);
  // Snapshots must not share mutable status objects with the fake daemon.
  native.list = async () => structuredClone(native.threads);
  const entered = gate(), blocked = gate();
  native.turnFinished = async () => { entered.release(); await blocked.promise; return true; };
  const tick = service.tick();
  await entered.promise;
  native.threads[1].status = { type: 'active' };
  blocked.release();
  await tick;
  assert.equal(store.subscriptions.size, 1);
  assert.equal(native.sent.length, 1);
});

test('a history failure leaves its subscription and does not suppress another notification', async t => {
  const { service, native, store } = fixture(t);
  await watched(service, native);
  await service.call('send_message', { to: 'session-c', message: 'other', notify_when_idle: true }, 'session-a');
  native.threads[2].status = { type: 'idle' };
  native.turnFinished = async id => { if (id === 'session-b') throw new Error('history unavailable'); return true; };
  await assert.rejects(service.tick(), /history unavailable/);
  await service.drain();
  assert.equal(store.subscriptions.size, 1);
  assert.equal(native.sent.filter(m => m.kind === 'idle-notification').length, 1);
  native.turnFinished = async () => true;
  await service.tick();
  assert.equal(store.subscriptions.size, 0);
  assert.equal(native.sent.filter(m => m.kind === 'idle-notification').length, 2);
});

test('broker close drains a cancelled history check without sending after shutdown', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  let closed = false;
  native.close = () => { closed = true; };
  broker = await startBroker({ config, native, intervalMs: 0 });
  await watched(broker.service, native);
  native.turnFinished = async () => { entered.release(); await blocked.promise; return true; };
  const tick = broker.service.tick();
  await entered.promise;
  try {
    const [sub] = broker.service.store.subscriptions.values();
    await promptly(broker.service.call('cancel_idle_notification', { subscription_id: sub.id }, 'session-a'));
    await promptly(broker.service.requestShutdown());
    const closing = broker.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    blocked.release();
    await Promise.all([tick, closing]);
  } finally { blocked.release(); }
  assert.equal(closed, true);
  assert.equal(native.sent.length, 1);
});

test('a slow session refresh does not block delivery receipts and concurrent calls share it', async t => {
  const { service, native } = fixture(t);
  const delivering = gate(), delivery = gate(), listing = gate(), list = gate();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => { delivering.release(); await delivery.promise; return deliver(message); };
  const sent = service.call('send_message', { to: 'session-b', message: 'work' }, 'session-a');
  await delivering.promise;
  let queries = 0;
  native.list = async () => { queries++; listing.release(); await list.promise; return native.threads; };
  const first = service.call('list_agents', {}, 'session-a');
  await listing.promise;
  const second = service.call('read_messages', {}, 'session-b');
  try {
    delivery.release();
    assert.equal((await promptly(sent)).status, 'accepted');
    assert.equal(queries, 1);
  } finally { delivery.release(); list.release(); await Promise.all([first, second]); }
  await service.call('list_agents', {}, 'session-a');
  assert.equal(queries, 2, 'later calls fetch a new snapshot rather than a cached status');
});

test('shutdown drains session refresh and never applies its late snapshot', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  let closed = false;
  native.close = () => { closed = true; };
  broker = await startBroker({ config, native, intervalMs: 0 });
  await broker.service.call('claim_leader', {}, 'session-a');
  native.list = async () => { entered.release(); await blocked.promise; return []; };
  const pending = assert.rejects(broker.service.call('list_agents', {}, 'session-a'), { code: 'BROKER_STOPPING' });
  await entered.promise;
  try {
    await promptly(broker.service.requestShutdown());
    const closing = broker.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    blocked.release();
    await Promise.all([pending, closing]);
  } finally { blocked.release(); }
  assert.equal(broker.service.store.leader, 'session-a');
  assert.equal(closed, true);
});

test('failed shared refresh preserves current state and permits a later fresh query', async t => {
  const { service, native, store } = fixture(t);
  await service.call('claim_leader', {}, 'session-a');
  const before = service.live;
  const entered = gate(), blocked = gate();
  native.list = async () => { entered.release(); await blocked.promise; throw new Error('list unavailable'); };
  const first = assert.rejects(service.call('list_agents', {}, 'session-a'), /list unavailable/);
  await entered.promise;
  const second = assert.rejects(service.call('get_message', { message_id: 'absent' }, 'session-b'), /list unavailable/);
  blocked.release();
  await Promise.all([first, second]);
  assert.equal(service.live, before);
  assert.equal(store.leader, 'session-a');
  assert.equal(service.refreshing, null);
  native.list = async () => native.threads;
  assert.equal((await service.call('list_agents', {}, 'session-a')).agents.length, 3);
});

test('unfinished or replaced subscriptions cannot be consumed by an old history result', async t => {
  const { service, native, store } = fixture(t);
  await watched(service, native);
  native.turnFinished = async () => false;
  await service.tick();
  assert.equal(store.subscriptions.size, 1);
  const entered = gate(), blocked = gate();
  native.turnFinished = async () => { entered.release(); await blocked.promise; return true; };
  const tick = service.tick();
  await entered.promise;
  const [sub] = store.subscriptions.values();
  await service.run(() => store.record('subscription', { ...sub, turnId: 'new-turn' }));
  blocked.release();
  await tick;
  assert.equal(store.subscriptions.get(sub.id).turnId, 'new-turn');
  assert.equal(native.sent.length, 1);
});

test('message history reads only returned bodies and retains filtering and insertion order', async t => {
  const { service, store } = fixture(t);
  let bodyReads = 0;
  for (let i = 0; i < 350; i++) {
    const message = { id: String(i), from: { id: i % 2 ? 'session-b' : 'session-c' }, to: { id: 'session-a' }, acknowledgedAt: i % 3 ? undefined : 'recorded' };
    Object.defineProperty(message, 'text', { enumerable: true, get() { bodyReads++; return `body-${i}`; } });
    store.messages.set(message.id, message);
  }
  const result = await service.call('read_messages', { direction: 'inbox', unacknowledged_only: true, limit: 3 }, 'session-a');
  assert.equal(bodyReads, 0);
  assert.deepEqual(result.messages.map(m => m.id), ['346', '347', '349']);
  assert.equal(JSON.parse(JSON.stringify(result)).messages.length, 3);
  assert.equal(bodyReads, 3);
  assert.deepEqual((await service.call('read_messages', { direction: 'outbox', limit: 2 }, 'session-b')).messages.map(m => m.id), ['347', '349']);
  assert.equal((await service.call('read_messages', { direction: 'inbox' }, 'session-b')).messages.length, 0);
});
