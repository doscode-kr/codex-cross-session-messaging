import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, temporary, FakeNative } from './helpers.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { summarizeResult } from '../plugins/cross-session/src/mcp.mjs';

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('An unrelated request waited for the blocked recipient')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const method of ['send_message', 'reply']) {
  test(`${method} returns a receipt recorded before the native response`, async t => {
    const { service, native } = fixture(t);
    const original = method === 'reply' ? await service.call('send_message', { to: 'session-a', message: 'question' }, 'session-b') : undefined;
    const entered = gate(), blocked = gate();
    const deliver = native.deliver.bind(native);
    native.deliver = async message => { entered.release(); await blocked.promise; return deliver(message); };
    const args = method === 'reply' ? { message_id: original.messageId, message: 'answer' } : { to: 'session-b', message: 'question' };
    const sending = service.call(method, args, 'session-a');
    try {
      await entered.promise;
      const inbox = await service.call('read_messages', {}, 'session-b');
      assert.equal(inbox.messages[0].status, 'sending');
      await service.call('acknowledge', { message_id: inbox.messages[0].id }, 'session-b');
    } finally { blocked.release(); }
    const receipt = await sending;
    assert.equal(receipt.acknowledged, true);
    assert.equal(receipt.taskCompleted, false);
    assert.match(summarizeResult(method, receipt), /Receipt confirmed\. Task completion is not confirmed/);
  });
}

test('a blocked recipient does not block another peer or message history', async t => {
  const { service, native, store } = fixture(t);
  const entered = gate(), blocked = gate();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => {
    if (message.to.id === 'session-b') { entered.release(); await blocked.promise; }
    return deliver(message);
  };
  const slow = service.call('send_message', { to: 'session-b', message: 'slow' }, 'session-a');
  try {
    await entered.promise;
    const history = await promptly(service.call('read_messages', { direction: 'outbox' }, 'session-a'));
    assert.equal(history.messages[0].status, 'sending');
    assert.equal((await promptly(service.call('list_agents', {}, 'session-c'))).agents.length, 3);
    const fast = await promptly(service.call('send_message', { to: 'session-a', message: 'fast' }, 'session-c'));
    assert.equal(fast.status, 'accepted');
    assert.equal([...store.messages.values()].find(message => message.text === 'slow').status, 'sending');
  } finally { blocked.release(); await slow; }
  await service.drain();
  assert.equal(service.deliveries.size, 0);
  assert.equal(service.recipients.size, 0);
});

test('same-recipient submissions retain order and an uncertain result is not retried', async t => {
  const { service, native, store } = fixture(t);
  const entered = gate(), blocked = gate();
  const submissions = [];
  const deliver = native.deliver.bind(native);
  native.deliver = async message => {
    submissions.push(message.text);
    if (message.text === 'first') {
      entered.release(); await blocked.promise;
      throw new CrossSessionError('NATIVE_TIMEOUT', 'Native reply lost');
    }
    return deliver(message);
  };
  const first = assert.rejects(service.call('send_message', { to: 'session-b', message: 'first' }, 'session-a'), { code: 'DELIVERY_UNCERTAIN' });
  await entered.promise;
  const second = service.call('send_message', { to: 'session-b', message: 'second' }, 'session-c');
  try {
    await service.call('list_agents', {}, 'session-a');
    assert.deepEqual(submissions, ['first']);
    assert.equal(store.messages.size, 2);
  } finally { blocked.release(); await first; }
  assert.equal((await second).status, 'accepted');
  await service.tick();
  assert.deepEqual(submissions, ['first', 'second']);
  assert.deepEqual([...store.messages.values()].map(message => message.status), ['uncertain', 'accepted']);
});

test('journal failure stops a waiting submission before native delivery', async t => {
  const { service, native, store } = fixture(t);
  const entered = gate(), blocked = gate();
  const deliver = native.deliver.bind(native);
  const submissions = [];
  native.deliver = async message => {
    submissions.push(message.text);
    entered.release(); await blocked.promise;
    return deliver(message);
  };
  const first = service.call('send_message', { to: 'session-b', message: 'first' }, 'session-a');
  const firstFailure = assert.rejects(first);
  await entered.promise;
  const second = service.call('send_message', { to: 'session-b', message: 'second' }, 'session-c');
  const secondFailure = assert.rejects(second, { code: 'STORE_UNAVAILABLE' });
  try {
    await service.call('list_agents', {}, 'session-a');
    store.failure = new Error('Injected disk failure');
  } finally { blocked.release(); }
  await Promise.all([firstFailure, secondFailure]);
  assert.deepEqual(submissions, ['first']);
  await service.drain();
});

test('a blocked idle notification does not stop other peers or repeat the notification', async t => {
  const { service, native, store } = fixture(t);
  const entered = gate(), blocked = gate();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => {
    if (message.kind === 'idle-notification') { entered.release(); await blocked.promise; }
    return deliver(message);
  };
  await service.call('notify_when_idle', { to: 'session-a' }, 'session-b');
  native.threads[0].status = { type: 'idle' };
  const tick = service.tick();
  try {
    await entered.promise;
    assert.equal(store.subscriptions.size, 0);
    const sent = await promptly(service.call('send_message', { to: 'session-a', message: 'unrelated' }, 'session-c'));
    assert.equal(sent.status, 'accepted');
    await promptly(service.tick());
  } finally { blocked.release(); await tick; }
  assert.equal(native.sent.filter(message => message.kind === 'idle-notification').length, 1);
});

test('HTTP requests to another recipient complete while native delivery is blocked', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => {
    if (message.to.id === 'session-b') { entered.release(); await blocked.promise; }
    return deliver(message);
  };
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  const slow = client.call('send_message', { to: 'session-b', message: 'slow' }, 'session-a');
  try {
    await entered.promise;
    const fast = await promptly(client.call('send_message', { to: 'session-a', message: 'fast' }, 'session-c'));
    assert.equal(fast.status, 'accepted');
    assert.equal(native.sent.length, 1);
  } finally { blocked.release(); await slow; }
});

test('broker close drains native delivery before closing the journal', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  const deliver = native.deliver.bind(native);
  const events = [];
  native.deliver = async message => {
    entered.release(); await blocked.promise;
    events.push('delivered');
    return deliver(message);
  };
  native.close = () => events.push('closed');
  broker = await startBroker({ config, native, intervalMs: 0 });
  const sent = broker.service.call('send_message', { to: 'session-b', message: 'drain' }, 'session-a');
  await entered.promise;
  const closing = broker.close();
  const closingAgain = broker.close();
  assert.equal(closingAgain, closing);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []);
  } finally { blocked.release(); }
  assert.equal((await sent).status, 'accepted');
  await closing;
  await closingAgain;
  assert.deepEqual(events, ['delivered', 'closed']);
  const journal = readFileSync(join(config.root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).value.status, 'accepted');
});

test('shutdown refuses a pending notification request before its subscription exists', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => { entered.release(); await blocked.promise; return deliver(message); };
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  const sent = client.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  try {
    await entered.promise;
    assert.equal(broker.service.store.subscriptions.size, 0);
    await assert.rejects(client.request('/shutdown', {}), { code: 'DELIVERIES_ACTIVE' });
    assert.equal(broker.service.stopping, false);
  } finally { blocked.release(); await sent; }
  assert.equal(broker.service.store.subscriptions.size, 1);
  await assert.rejects(client.request('/shutdown', {}), { code: 'SUBSCRIPTIONS_ACTIVE' });
  const [subscription] = broker.service.store.subscriptions.values();
  await client.call('cancel_idle_notification', { subscription_id: subscription.id }, 'session-a');
  await broker.service.requestShutdown();
  await assert.rejects(broker.service.call('send_message', { to: 'session-b', message: 'late' }, 'session-c'), { code: 'BROKER_STOPPING' });
  await assert.rejects(broker.service.hook({ session_id: 'session-c' }), { code: 'BROKER_STOPPING' });
  assert.equal(native.sent.length, 1);
});
