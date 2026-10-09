import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { temporary, FakeNative, fixture } from './helpers.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function subscription(store, sawActive = false, turnId) {
  store.record('subscription', { id: 'saved-sub', from: 'session-a', to: 'session-b', sawActive, ...(turnId ? { turnId } : {}) });
}
function failJournal(store) {
  store.record('message', { id: 'saved-message', from: { id: 'session-a' }, to: { id: 'session-b' }, text: 'preserved', status: 'sending' });
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Object.assign(new Error('Injected sync failure'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    assert.throws(() => store.record('ack', { id: 'saved-message', at: 'saved-ack' }), { code: 'EIO' });
  } finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
}

test('failed journal permits explicit HTTP shutdown and preserves subscriptions and journal', async t => {
  let broker, reopened;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { await broker?.close(); reopened?.close(); }) });
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false, timeoutMs: 2000 });
  subscription(broker.service.store);
  failJournal(broker.service.store);
  const store = broker.service.store, offset = store.offset, bytes = fs.readFileSync(store.path);
  await assert.rejects(client.call('cancel_idle_notification', { subscription_id: 'saved-sub' }, 'session-a'), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(await client.request('/shutdown', {}), { stopped: true });
  await broker.close();
  assert.equal(store.offset, offset);
  assert.deepEqual(fs.readFileSync(store.path), bytes);
  assert.equal(store.subscriptions.size, 1);
  assert.equal(native.sent.length, 0);
  reopened = new Store(config.root); reopened.recover();
  assert.ok(reopened.subscriptions.has('saved-sub'));
  assert.equal(reopened.messages.get('saved-message').acknowledgedAt, 'saved-ack');
  assert.equal(reopened.messages.get('saved-message').status, 'uncertain');
  await new MessagingService(reopened, native).tick();
  assert.equal(native.sent.length, 0);
});

test('normal subscriptions and every active delivery retain shutdown protection', async t => {
  const { service, store } = fixture(t);
  subscription(store);
  await assert.rejects(service.requestShutdown(), { code: 'SUBSCRIPTIONS_ACTIVE' });
  assert.equal(service.stopping, false);
  failJournal(store);
  const active = gate(); service.deliveries.add(active.promise);
  const bytes = fs.readFileSync(store.path), offset = store.offset;
  await assert.rejects(service.requestShutdown(), { code: 'DELIVERIES_ACTIVE' });
  assert.equal(service.stopping, false);
  assert.deepEqual(fs.readFileSync(store.path), bytes);
  assert.equal(store.offset, offset);
  service.deliveries.delete(active.promise); active.release();
  await service.requestShutdown();
  assert.equal(service.stopping, true);
  assert.ok(store.subscriptions.has('saved-sub'));
});

test('stopping a failed journal prevents delayed idle checks from starting native delivery', async t => {
  for (const stage of ['turnFinished', 'list']) {
    for (const rejects of [false, true]) {
      const { service, native, store } = fixture(t);
      subscription(store, true, 'saved-turn');
      failJournal(store);
      const entered = gate(), blocked = gate();
      native.turnFinished = async () => true;
      if (stage === 'turnFinished') native.turnFinished = async () => {
        entered.release(); await blocked.promise;
        if (rejects) throw new Error('Late lookup failure');
        return true;
      };
      else {
        let calls = 0;
        native.list = async () => {
          if (++calls > 1) {
            entered.release(); await blocked.promise;
            if (rejects) throw new Error('Late lookup failure');
          }
          return native.threads;
        };
      }
      const tick = service.tick().then(() => null, error => error);
      await entered.promise;
      const bytes = fs.readFileSync(store.path), offset = store.offset;
      await service.requestShutdown();
      blocked.release();
      const error = await tick;
      if (rejects) assert.equal(error.message, 'Late lookup failure');
      else assert.equal(error, null);
      await service.drain();
      assert.equal(service.stopping, true);
      assert.equal(native.sent.length, 0);
      assert.equal(store.subscriptions.size, 1);
      assert.equal(store.offset, offset);
      assert.deepEqual(fs.readFileSync(store.path), bytes);
      assert.equal(service.idleChecks.size, 0);
      await assert.rejects(service.call('send_message', { to: 'session-b', message: 'blocked' }, 'session-a'), { code: 'BROKER_STOPPING' });
    }
  }
});

test('broker close drains a late failed idle lookup without changing the failed journal', async t => {
  let broker;
  const entered = gate(), blocked = gate();
  const config = settings({ CROSS_SESSION_HOME: temporary(t, async () => { blocked.release(); await broker?.close(); }) });
  const native = new FakeNative();
  let nativeClosed = 0;
  native.close = () => { nativeClosed++; };
  native.turnFinished = async () => { entered.release(); await blocked.promise; throw new Error('Late lookup failure'); };
  broker = await startBroker({ config, native, intervalMs: 0 });
  subscription(broker.service.store, true, 'saved-turn'); failJournal(broker.service.store);
  const bytes = fs.readFileSync(broker.service.store.path);
  const tick = broker.service.tick().then(() => null, error => error);
  await entered.promise;
  const client = new BrokerClient({ config, autoStart: false, timeoutMs: 2000 });
  assert.deepEqual(await client.request('/shutdown', {}), { stopped: true });
  const closing = broker.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeClosed, 0);
  blocked.release();
  assert.equal((await tick).message, 'Late lookup failure');
  await closing;
  assert.equal(nativeClosed, 1);
  assert.equal(broker.service.store.closed, true);
  assert.equal(native.sent.length, 0);
  assert.equal(broker.service.store.subscriptions.size, 1);
  assert.deepEqual(fs.readFileSync(broker.service.store.path), bytes);
});
