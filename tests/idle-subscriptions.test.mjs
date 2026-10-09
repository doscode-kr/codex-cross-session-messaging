import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, temporary, FakeNative } from './helpers.mjs';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';
import { tools } from '../plugins/cross-session/src/tools.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { settings } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const query = (service, args = {}, caller = 'session-a') => service.call('list_idle_notifications', args, caller);
const subscription = (store, id, extra = {}) => store.record('subscription', { id, from: 'session-a', to: 'session-b', sawActive: true, ...extra });

test('subscription pages use character order, owner filtering, and public fields only', async t => {
  const { store, service, native } = fixture(t);
  for (const id of ['z', 'a', 'Z', '0']) subscription(store, id, { turnId: 'private', private: 'hidden', ...(id === 'Z' ? { messageId: 'saved' } : {}) });
  subscription(store, 'A', { from: 'session-c' });
  const first = await query(service, { limit: 2 });
  assert.deepEqual(first, { subscriptions: [
    { subscriptionId: '0', to: 'session-b', event: 'next-idle', oneShot: true },
    { subscriptionId: 'Z', to: 'session-b', messageId: 'saved', event: 'next-idle', oneShot: true }
  ], nextCursor: 'Z' });
  await service.call('cancel_idle_notification', { subscription_id: first.nextCursor }, 'session-a');
  assert.deepEqual((await query(service, { limit: 2, after_subscription_id: first.nextCursor })).subscriptions.map(s => s.subscriptionId), ['a', 'z']);
  assert.equal((await query(service, { after_subscription_id: 'missing' })).nextCursor, null);
  assert.deepEqual((await query(service, { after_subscription_id: 'A' })).subscriptions.map(s => s.subscriptionId), ['a', 'z']);
  assert.equal((await query(service, {}, 'session-c')).subscriptions.length, 1);
  assert.equal(native.sent.length, 0);
});

test('default and maximum pages survive recovery and use the current subscription set', async t => {
  const { root, store, native, service } = fixture(t);
  for (let i = 104; i >= 0; i--) subscription(store, String(i).padStart(3, '0'));
  const first = await query(service);
  assert.equal(first.subscriptions.length, 20);
  assert.equal(first.nextCursor, '019');
  subscription(store, '019a');
  await service.call('cancel_idle_notification', { subscription_id: '020' }, 'session-a');
  store.close();
  const recovered = new Store(root);
  t.after(() => recovered.close());
  const restored = new MessagingService(recovered, native);
  const page = await query(restored, { limit: 100, after_subscription_id: first.nextCursor });
  assert.equal(page.subscriptions.length, 85);
  assert.equal(page.subscriptions[0].subscriptionId, '019a');
  assert.equal(page.nextCursor, null);
  assert.equal((await query(restored, { limit: 100 })).subscriptions.length, 100);
  recovered.close();
});

test('subscription query preserves journal, stale leader, and pending subscription state', async t => {
  const { store, native, service } = fixture(t);
  store.record('leader', 'missing');
  subscription(store, 's', { sawActive: false, turnId: 'old' });
  const sub = store.subscriptions.get('s');
  const bytes = readFileSync(store.path);
  native.turnFinished = () => assert.fail('Query must not check or deliver idle notifications');
  await query(service);
  assert.deepEqual(readFileSync(store.path), bytes);
  assert.equal(store.leader, 'missing');
  assert.equal(store.subscriptions.get('s'), sub);
  assert.equal(sub.sawActive, false);
  assert.equal(native.sent.length, 0);
  await assert.rejects(query(service, {}, 'not-loaded'), { code: 'SESSION_NOT_LIVE' });
  native.list = async () => { throw Object.assign(new Error('offline'), { code: 'DAEMON_REQUIRED' }); };
  await assert.rejects(query(service), { code: 'DAEMON_REQUIRED' });
  assert.deepEqual(readFileSync(store.path), bytes);
});

test('invalid subscription page arguments are rejected', async t => {
  const { service } = fixture(t);
  for (const limit of [0, 101, 1.5, '1']) await assert.rejects(query(service, { limit }), { code: 'INVALID_ARGUMENT' });
  for (const after_subscription_id of ['', 42, 'x'.repeat(201)]) await assert.rejects(query(service, { after_subscription_id }), { code: 'INVALID_ARGUMENT' });
});

test('failed journal still permits subscription reads without state changes', async t => {
  const { store, service, native } = fixture(t);
  subscription(store, 'saved', { turnId: 'private' });
  subscription(store, 'other', { from: 'session-c' });
  store.record('leader', 'missing');
  const bytes = readFileSync(store.path), offset = store.offset, sub = store.subscriptions.get('saved');
  store.failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
  native.deliver = () => assert.fail('Read must not deliver');
  native.turnFinished = () => assert.fail('Read must not check turns');
  const result = await query(service);
  assert.deepEqual(result.subscriptions.map(s => s.subscriptionId), ['saved']);
  assert.deepEqual(readFileSync(store.path), bytes);
  assert.equal(store.offset, offset);
  assert.equal(store.leader, 'missing');
  assert.equal(store.subscriptions.get('saved'), sub);
});

for (const readFirst of [true, false]) test(`shared native collection preserves normal leader cleanup (read first: ${readFirst})`, async t => {
  const { store, native, service } = fixture(t);
  store.record('leader', 'missing');
  const gate = deferred();
  let lists = 0;
  native.list = async () => { lists++; await gate.promise; return native.threads; };
  const read = () => query(service);
  const normal = () => service.call('list_agents', {}, 'session-a');
  const first = readFirst ? read() : normal();
  const second = readFirst ? normal() : read();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(lists, 1);
  assert.equal(store.leader, null);
  assert.equal(readFileSync(store.path, 'utf8').split('\n').filter(line => line.includes('"type":"leader"')).length, 2);
});

test('two read queries share collection without clearing the leader', async t => {
  const { store, native, service } = fixture(t);
  store.record('leader', 'missing');
  const gate = deferred();
  let lists = 0;
  native.list = async () => { lists++; await gate.promise; return native.threads; };
  const calls = [query(service), query(service)];
  gate.resolve();
  await Promise.all(calls);
  assert.equal(lists, 1);
  assert.equal(store.leader, 'missing');
});

test('drain waits for refresh writer jobs after native collection finishes', async t => {
  const { service, native } = fixture(t);
  const gate = deferred(), scheduled = deferred();
  const originalRun = service.run.bind(service);
  service.run = action => { scheduled.resolve(); return gate.promise.then(() => originalRun(action)); };
  const refresh = service.refresh({ persistLeader: false });
  await scheduled.promise;
  assert.equal(service.refreshing, null);
  let drained = false;
  const drain = service.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  gate.resolve();
  await Promise.all([refresh, drain]);
  assert.equal(service.live.size, native.threads.length);
  assert.equal(service.refreshes.size, 0);
});

test('a delayed older refresh cannot replace a newer live snapshot', async t => {
  const { service, native } = fixture(t);
  const gate = deferred(), scheduled = deferred();
  const originalRun = service.run.bind(service);
  let runs = 0;
  service.run = action => ++runs === 1 ? (scheduled.resolve(), gate.promise.then(() => originalRun(action))) : originalRun(action);
  native.list = async () => [{ id: 'old' }];
  const old = service.refresh({ persistLeader: false });
  await scheduled.promise;
  native.list = async () => [{ id: 'new' }];
  await service.refresh({ persistLeader: false });
  gate.resolve();
  await old;
  assert.deepEqual([...service.live.keys()], ['new']);
});

test('shutdown rejects late refresh jobs without changing state', async t => {
  const { store, service, native } = fixture(t);
  store.record('leader', 'missing');
  const bytes = readFileSync(store.path), gate = deferred();
  native.list = async () => { await gate.promise; return native.threads; };
  const pending = query(service);
  const rejected = assert.rejects(pending, { code: 'BROKER_STOPPING' });
  await service.requestShutdown();
  const drain = service.drain();
  gate.resolve();
  await Promise.all([rejected, drain]);
  assert.deepEqual(readFileSync(store.path), bytes);
  assert.equal(service.live.size, 0);
});

test('send returns saved subscription IDs and only the owner can cancel them', async t => {
  const { service, store, native } = fixture(t);
  const sent = await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  assert.ok(store.subscriptions.has(sent.subscriptionId));
  assert.deepEqual((await query(service)).subscriptions[0], { subscriptionId: sent.subscriptionId, to: 'session-b', messageId: sent.messageId, event: 'next-idle', oneShot: true });
  assert.deepEqual((await query(service, {}, 'session-b')).subscriptions, []);
  await assert.rejects(service.call('cancel_idle_notification', { subscription_id: sent.subscriptionId }, 'session-b'), { code: 'SUBSCRIPTION_NOT_FOUND' });
  await service.call('cancel_idle_notification', { subscription_id: sent.subscriptionId }, 'session-a');
  assert.deepEqual((await query(service)).subscriptions, []);
  for (const notify_when_idle of [false, undefined]) {
    const receipt = await service.call('send_message', { to: 'session-b', message: 'plain', notify_when_idle }, 'session-a');
    assert.equal(Object.hasOwn(receipt, 'subscriptionId'), false);
  }
  const sub = await service.call('notify_when_idle', { to: 'session-b' }, 'session-a');
  native.threads.find(thread => thread.id === 'session-b').status = { type: 'idle' };
  await service.tick();
  assert.equal(store.subscriptions.has(sub.subscriptionId), false);
  const deliveries = native.sent.length;
  await query(service);
  await service.tick();
  assert.equal(native.sent.length, deliveries);
});

test('MCP exposes subscription schemas, cursors, saved IDs, and full detail', async () => {
  const tool = tools.find(item => item.name === 'list_idle_notifications');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.limit.maximum, 100);
  const data = { subscriptions: [{ subscriptionId: 's', to: 'b', messageId: 'm', event: 'next-idle', oneShot: true }], nextCursor: 's' };
  for (const detail of [false, true]) {
    const result = await handleMcp({ method: 'tools/call', params: { name: 'list_idle_notifications', arguments: { limit: 1, after_subscription_id: 'r', detail }, _meta: { sessionId: 'a' } } }, { async call(name, args, id) {
      assert.equal(name, 'list_idle_notifications'); assert.equal(id, 'a');
      assert.deepEqual(args, { limit: 1, after_subscription_id: 'r' }); return data;
    } });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, data);
    if (detail) assert.deepEqual(JSON.parse(result.content[0].text), data);
    else { assert.match(result.content[0].text, /Subscription "s"/); assert.match(result.content[0].text, /"b"/); assert.match(result.content[0].text, /after_subscription_id: "s"/); }
  }
  const sent = await handleMcp({ method: 'tools/call', params: { name: 'send_message', arguments: { to: 'b', message: 'work', notify_when_idle: true }, _meta: { sessionId: 'a' } } }, { async call() { return { messageId: 'm', status: 'accepted', subscriptionId: 'saved' }; } });
  assert.match(sent.content[0].text, /Idle subscription: "saved"/);
});

test('actual CLI supports subscription lookup, pagination, and owner cancellation', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const native = new FakeNative();
  broker = await startBroker({ config: settings({ CROSS_SESSION_HOME: root }), native, intervalMs: 0 });
  subscription(broker.service.store, 'a');
  subscription(broker.service.store, 'b');
  const execute = promisify(execFile);
  const entry = fileURLToPath(new URL('../plugins/cross-session/src/cli.mjs', import.meta.url));
  async function cli(args) {
    const result = await execute(process.execPath, [entry, ...args], { env: { ...process.env, CROSS_SESSION_HOME: root, CODEX_HOME: join(root, 'codex-home'), CODEX_THREAD_ID: 'session-a' }, windowsHide: true, timeout: 5000 });
    return JSON.parse(result.stdout);
  }
  const first = await cli(['list_idle_notifications', '--limit=1']);
  assert.equal(first.nextCursor, 'a');
  await cli(['cancel_idle_notification', '--subscription-id=a']);
  const second = await cli(['list_idle_notifications', '--after-subscription-id=a', '--limit=1']);
  assert.equal(second.subscriptions[0].subscriptionId, 'b');
  assert.equal(second.nextCursor, null);
  assert.equal(native.sent.length, 0);
});
