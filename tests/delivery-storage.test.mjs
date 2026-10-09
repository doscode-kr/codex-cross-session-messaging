import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { temporary, FakeNative } from './helpers.mjs';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';

function setup(t) {
  let store;
  const root = temporary(t, () => store.close());
  store = new Store(root);
  const native = new FakeNative(), service = new MessagingService(store, native);
  return { native, service, get store() { return store; }, restart() {
    store.close(); store = new Store(root); store.recover(); service.store = store;
  } };
}
async function withFs(overrides, action) {
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]));
  Object.assign(fs, overrides); syncBuiltinESMExports();
  try { return await action(); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}
const ioError = () => Object.assign(new Error('private-path/private-token storage failure'), { code: 'EIO' });
const capture = async promise => { try { await promise; } catch (error) { return error; } assert.fail('Expected a rejection'); };
const send = state => state.service.call('send_message', { to: 'session-b', message: 'preserve body' }, 'session-a');

test('initial journal save failure never submits native input', async t => {
  const state = setup(t);
  const error = await withFs({ fsyncSync: () => { throw ioError(); } }, () => capture(send(state)));
  assert.equal(error.code, 'EIO');
  assert.equal(state.native.sent.length, 0);
  const size = fs.statSync(state.store.path).size;
  await assert.rejects(send(state), { code: 'STORE_UNAVAILABLE' });
  assert.equal(fs.statSync(state.store.path).size, size);
  state.restart(); await state.service.tick();
  assert.equal(state.native.sent.length, 0);
  assert.equal([...state.store.messages.values()][0].status, 'uncertain');
});

test('a saved message blocked before submission retains its ID without another write', async t => {
  const state = setup(t);
  const message = { id: 'saved', from: { id: 'session-a' }, to: { id: 'session-b' }, text: 'body', status: 'sending' };
  state.store.record('message', message);
  state.store.failure = ioError();
  const bytes = fs.readFileSync(state.store.path);
  const error = await capture(state.service.deliver(message, false));
  assert.equal(error.code, 'STORE_UNAVAILABLE');
  assert.equal(error.details.messageId, 'saved');
  assert.equal(error.details.requestOutcome, 'not_submitted');
  assert.deepEqual(error.details.storageError, { code: 'EIO' });
  assert.equal(state.native.sent.length, 0);
  assert.deepEqual(fs.readFileSync(state.store.path), bytes);
  state.restart(); await state.service.tick();
  assert.equal(state.store.messages.get('saved').status, 'uncertain');
  assert.equal(state.native.sent.length, 0);
});

test('accepted submissions retain uncertain diagnostics after complete or partial result writes', async t => {
  for (const mode of ['fsync', 'partial']) {
    const state = setup(t);
    const records = t.mock.method(state.store, 'record');
    let accepted = false, writesAfterAcceptance = 0;
    const deliver = state.native.deliver.bind(state.native), write = fs.writeSync, sync = fs.fsyncSync;
    state.native.deliver = async message => { const result = await deliver(message); accepted = true; return result; };
    const error = await withFs({
      writeSync: (...args) => {
        if (!accepted) return write(...args);
        writesAfterAcceptance++;
        if (mode === 'partial') {
          if (writesAfterAcceptance === 1) return write(args[0], args[1], args[2], 17, args[4]);
          throw ioError();
        }
        return write(...args);
      },
      fsyncSync: fd => { if (accepted && mode === 'fsync') throw ioError(); return sync(fd); }
    }, () => capture(send(state)));
    assert.equal(error.code, 'DELIVERY_UNCERTAIN');
    const messageId = state.native.sent[0].id;
    assert.equal(error.details.messageId, messageId);
    assert.equal(error.details.requestOutcome, 'unknown');
    assert.equal(error.details.queued, false);
    assert.equal(error.details.delivery.accepted, true);
    assert.deepEqual(error.details.storageError, { code: 'EIO' });
    assert.equal(JSON.stringify(error.details).includes('private-path'), false);
    assert.equal(error.message.includes('private-token'), false);
    assert.equal(writesAfterAcceptance, mode === 'fsync' ? 1 : 2);
    assert.equal(records.mock.callCount(), 2);
    assert.equal(state.native.sent.length, 1);
    assert.equal(state.store.messages.get(messageId).status, 'sending');
    const size = fs.statSync(state.store.path).size;
    await assert.rejects(send(state), { code: 'STORE_UNAVAILABLE' });
    assert.equal(fs.statSync(state.store.path).size, size);
    state.restart(); await state.service.tick();
    assert.equal(state.store.messages.get(messageId).status, mode === 'fsync' ? 'accepted' : 'uncertain');
    assert.equal(state.store.messages.get(messageId).text, 'preserve body');
    assert.equal(state.native.sent.length, 1);
    await state.service.call('acknowledge', { message_id: messageId }, 'session-b');
    assert.ok(state.store.messages.get(messageId).acknowledgedAt);
  }
});

test('native rejection and timeout diagnostics survive failed result saves', async t => {
  for (const nativeCode of ['NATIVE_REJECTED', 'NATIVE_TIMEOUT']) {
    const state = setup(t);
    let attempted = false, failedSyncs = 0;
    const sync = fs.fsyncSync;
    state.native.deliver = async () => { attempted = true; throw new CrossSessionError(nativeCode, 'Original native error'); };
    const error = await withFs({ fsyncSync: fd => {
      if (attempted) { failedSyncs++; throw ioError(); }
      return sync(fd);
    } }, () => capture(send(state)));
    assert.equal(error.code, nativeCode === 'NATIVE_REJECTED' ? 'DELIVERY_FAILED' : 'DELIVERY_UNCERTAIN');
    assert.equal(error.message, 'Original native error');
    assert.equal(error.details.nativeError.code, nativeCode);
    assert.deepEqual(error.details.storageError, { code: 'EIO' });
    assert.equal(failedSyncs, 1);
    const messageId = error.details.messageId;
    assert.equal(state.store.messages.get(messageId).status, 'sending');
    state.restart();
    assert.equal(state.store.messages.get(messageId).status, nativeCode === 'NATIVE_REJECTED' ? 'failed' : 'uncertain');
  }
});

test('a journal body read failure during submission cannot expose storage paths or tokens', async t => {
  const state = setup(t);
  const records = t.mock.method(state.store, 'record');
  state.native.deliver = async message => { return { text: message.text }; };
  const error = await withFs({ readSync: () => { throw ioError(); } }, () => capture(send(state)));
  assert.equal(error.code, 'DELIVERY_UNCERTAIN');
  assert.equal(error.details.requestOutcome, 'unknown');
  assert.deepEqual(error.details.storageError, { code: 'EIO' });
  assert.equal(error.details.nativeError, undefined);
  assert.equal(error.message.includes('private-path'), false);
  assert.equal(JSON.stringify(error.details).includes('private-token'), false);
  assert.equal(records.mock.callCount(), 1);
  state.restart(); await state.service.tick();
  assert.equal(state.store.messages.get(error.details.messageId).status, 'uncertain');
  assert.equal(state.native.sent.length, 0);
});

test('subscription save failure preserves the already saved accepted delivery', async t => {
  const state = setup(t);
  const sync = fs.fsyncSync;
  let syncs = 0;
  const error = await withFs({ fsyncSync: fd => { if (++syncs === 3) throw ioError(); return sync(fd); } },
    () => capture(state.service.call('send_message', { to: 'session-b', message: 'body', notify_when_idle: true }, 'session-a')));
  assert.equal(error.code, 'IDLE_SUBSCRIPTION_UNCERTAIN');
  assert.equal(error.details.status, 'accepted');
  assert.equal(error.details.requestOutcome, 'accepted');
  assert.equal(error.details.idleNotificationOutcome, 'unknown');
  assert.equal(error.details.taskCompleted, false);
  assert.equal(error.details.acknowledged, false);
  assert.deepEqual(error.details.storageError, { code: 'EIO' });
  assert.equal(syncs, 3);
  assert.equal(state.store.messages.get(error.details.messageId).status, 'accepted');
  assert.equal(state.store.subscriptions.size, 0);
  state.restart(); await state.service.tick();
  assert.equal(state.store.messages.get(error.details.messageId).status, 'accepted');
  assert.ok(state.store.subscriptions.has(error.details.subscriptionId));
  assert.equal(state.native.sent.length, 1);
});

test('a pending recipient submission stops after another result save fails and keeps acknowledgments', async t => {
  const state = setup(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const deliver = state.native.deliver.bind(state.native);
  state.native.deliver = async message => { enter(); await blocked; return deliver(message); };
  const first = capture(send(state));
  await entered;
  const second = capture(send(state));
  // Finish the second state write while its native submission waits for the first.
  await state.service.refresh();
  await state.service.run(() => assert.equal(state.store.messages.size, 2));
  const messageIds = [...state.store.messages.keys()];
  for (const messageId of messageIds) await state.service.call('acknowledge', { message_id: messageId }, 'session-b');
  const errors = await withFs({ fsyncSync: () => { throw ioError(); } }, async () => {
    release(); return Promise.all([first, second]);
  });
  assert.equal(errors[0].code, 'DELIVERY_UNCERTAIN');
  assert.equal(errors[0].details.messageId, messageIds[0]);
  assert.equal(errors[1].code, 'STORE_UNAVAILABLE');
  assert.equal(errors[1].details.requestOutcome, 'not_submitted');
  assert.equal(errors[1].details.messageId, messageIds[1]);
  assert.equal(state.native.sent.length, 1);
  for (const messageId of messageIds) assert.ok(state.store.messages.get(messageId).acknowledgedAt);
  state.restart(); await state.service.tick();
  assert.equal(state.store.messages.get(messageIds[0]).status, 'accepted');
  assert.equal(state.store.messages.get(messageIds[1]).status, 'uncertain');
  for (const messageId of messageIds) assert.ok(state.store.messages.get(messageId).acknowledgedAt);
  assert.equal(state.native.sent.length, 1);
});
