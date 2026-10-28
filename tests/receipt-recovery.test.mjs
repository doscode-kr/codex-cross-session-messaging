import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';
import { FakeNative, fixture, temporary } from './helpers.mjs';

const ids = {
  accepted: 'a1b2c3d4-a5b6-4c7d-8e9f-a1b2c3d4e5f6',
  pending: '22222222-2222-4222-8222-222222222222',
  uncertain: '33333333-3333-4333-8333-333333333333',
  failed: '44444444-4444-4444-8444-444444444444',
  reply: '55555555-5555-4555-8555-555555555555',
  idleUnknown: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  legacyIdle: '66666666-6666-4666-8666-666666666666',
  legacyUnknown: '77777777-7777-4777-8777-777777777777'
};

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('an accepted request ID returns its receipt without a second native submission', async t => {
  const { service, native } = fixture(t);
  const args = { to: 'session-b', message: 'one body', request_id: ids.accepted };
  const first = await service.call('send_message', args, 'session-a');
  assert.equal(first.messageId, ids.accepted);
  assert.equal(first.idleNotification, 'not_requested');
  assert.deepEqual(first.stages, {
    submission: 'recorded', targetCodex: 'accepted', recipientDisplay: 'unknown',
    recipientReceipt: 'unconfirmed', taskCompletion: 'unreported'
  });
  native.threads = native.threads.filter(thread => thread.id !== 'session-b');
  const recovered = await service.call('send_message', args, 'session-a');
  assert.equal(recovered.reused, true);
  assert.equal(recovered.messageId, first.messageId);
  assert.equal(native.sent.length, 1);
});

test('idle notification receipts report only current durable evidence', async t => {
  const { service, native } = fixture(t);
  const args = { to: 'session-b', message: 'notify body', request_id: ids.pending, notify_when_idle: true };
  const first = await service.call('send_message', args, 'session-a');
  assert.equal(first.idleNotification, 'registered');
  assert.ok(first.subscriptionId);
  await service.call('cancel_idle_notification', { subscription_id: first.subscriptionId }, 'session-a');
  const recovered = await service.call('send_message', args, 'session-a');
  assert.equal(recovered.idleNotification, 'unknown');
  assert.equal(recovered.reused, true);
  assert.equal(native.sent.length, 1);
});

test('restart keeps a missing idle subscription unknown without recreating it', async t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  store.record('message', {
    id: ids.idleUnknown, kind: 'message', from: { id: 'session-a' }, to: { id: 'session-b' },
    text: 'missing subscription', notifyIdle: true, status: 'accepted', createdAt: new Date().toISOString()
  });
  store.close();
  store = new Store(root);
  const native = new FakeNative();
  const service = new MessagingService(store, native);
  const recovered = await service.call('send_message', {
    to: 'session-b', message: 'missing subscription', request_id: ids.idleUnknown, notify_when_idle: true
  }, 'session-a');
  assert.equal(recovered.idleNotification, 'unknown');
  assert.equal(recovered.reused, true);
  assert.equal(native.sent.length, 0);
  assert.equal(store.subscriptions.size, 0);
});

test('legacy journals use current subscriptions before the missing notification flag', async t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  for (const [id, text] of [[ids.legacyIdle, 'legacy subscribed'], [ids.legacyUnknown, 'legacy unknown']]) {
    store.record('message', {
      id, kind: 'message', from: { id: 'session-a' }, to: { id: 'session-b' },
      text, status: 'accepted', createdAt: new Date().toISOString()
    });
  }
  store.record('subscription', {
    id: '88888888-8888-4888-8888-888888888888', from: 'session-a', to: 'session-b',
    sawActive: true, messageId: ids.legacyIdle
  });
  store.close();
  store = new Store(root);
  const service = new MessagingService(store, new FakeNative());
  const subscribed = await service.call('get_message', { message_id: ids.legacyIdle }, 'session-a');
  const unknown = await service.call('get_message', { message_id: ids.legacyUnknown }, 'session-a');
  assert.equal(subscribed.idleNotification, 'registered');
  assert.equal(unknown.idleNotification, 'unknown');
});

test('receipt recovery after an alias send requires the stored exact recipient UUID', async t => {
  const { service, native } = fixture(t);
  const args = { to: 'beta', message: 'alias body', request_id: ids.accepted };
  await service.call('send_message', args, 'session-a');
  await assert.rejects(service.call('send_message', args, 'session-a'), { code: 'REQUEST_ID_CONFLICT' });
  const recovered = await service.call('send_message', { ...args, to: 'session-b' }, 'session-a');
  assert.equal(recovered.reused, true);
  assert.equal(native.sent.length, 1);
});

test('uppercase and lowercase UUID spellings identify one request', async t => {
  const { service, native } = fixture(t);
  const upper = ids.accepted.toUpperCase();
  const first = await service.call('send_message', { to: 'session-b', message: 'case body', request_id: upper }, 'session-a');
  const recovered = await service.call('send_message', { to: 'session-b', message: 'case body', request_id: ids.accepted }, 'session-a');
  assert.equal(first.messageId, ids.accepted);
  assert.equal(recovered.reused, true);
  assert.equal(native.sent.length, 1);
});

test('request ID collisions do not expose or resubmit the stored request', async t => {
  const { service, native } = fixture(t);
  const base = { to: 'session-b', message: 'private body', request_id: ids.accepted };
  await service.call('send_message', base, 'session-a');
  for (const [caller, args] of [
    ['session-c', base],
    ['session-a', { ...base, message: 'changed' }],
    ['session-a', { ...base, to: 'session-c' }],
    ['session-a', { ...base, notify_when_idle: true }]
  ]) {
    await assert.rejects(service.call('send_message', args, caller), error =>
      error.code === 'REQUEST_ID_CONFLICT' && !JSON.stringify(error).includes('private body'));
  }
  assert.equal(native.sent.length, 1);
});

test('concurrent calls with one request ID share the pending native submission', async t => {
  const { service, native } = fixture(t);
  const entered = gate(), blocked = gate();
  const deliver = native.deliver.bind(native);
  native.deliver = async message => { entered.release(); await blocked.promise; return deliver(message); };
  const args = { to: 'session-b', message: 'pending body', request_id: ids.pending };
  const first = service.call('send_message', args, 'session-a');
  await entered.promise;
  const second = service.call('send_message', args, 'session-a');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(native.sent.length, 0);
  } finally { blocked.release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.messageId, ids.pending);
  assert.equal(b.messageId, ids.pending);
  assert.equal(native.sent.length, 1);
});

for (const [status, nativeError, expectedCode] of [
  ['uncertain', new CrossSessionError('NATIVE_TIMEOUT', 'lost result'), 'DELIVERY_UNCERTAIN'],
  ['failed', new CrossSessionError('NATIVE_REJECTED', 'definite rejection'), 'DELIVERY_FAILED']
]) {
  test(`${status} request IDs return the saved failure state without resubmission`, async t => {
    const { service, native } = fixture(t);
    native.error = nativeError;
    const args = { to: 'session-b', message: `${status} body`, request_id: ids[status] };
    await assert.rejects(service.call('send_message', args, 'session-a'), { code: expectedCode });
    native.error = undefined;
    await assert.rejects(service.call('send_message', args, 'session-a'), error =>
      error.code === expectedCode && error.details.reused === true && error.details.stages.taskCompletion === 'unreported');
    assert.equal(native.sent.length, 1);
  });
}

test('a broker restart preserves uncertain request ID recovery without native resend', async t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  const args = { to: 'session-b', message: 'restart body', request_id: ids.uncertain };
  store.record('message', {
    id: ids.uncertain, kind: 'message', from: { id: 'session-a' }, to: { id: 'session-b' },
    text: args.message, notifyIdle: false, status: 'sending', createdAt: new Date().toISOString()
  });
  store.close();
  store = new Store(root);
  store.recover();
  const after = new FakeNative();
  const service = new MessagingService(store, after);
  await assert.rejects(service.call('send_message', args, 'session-a'), error =>
    error.code === 'DELIVERY_UNCERTAIN' && error.details.reused === true);
  assert.equal(after.sent.length, 0);
});

test('acknowledgement response loss is recovered idempotently and never implies completion', async t => {
  const { service } = fixture(t);
  const sent = await service.call('send_message', { to: 'session-b', message: 'ack body', request_id: ids.accepted }, 'session-a');
  const lost = await service.call('acknowledge', { message_id: sent.messageId }, 'session-b');
  const recovered = await service.call('acknowledge', { message_id: sent.messageId }, 'session-b');
  assert.equal(recovered.acknowledgedAt, lost.acknowledgedAt);
  assert.equal(recovered.stages.recipientReceipt, 'confirmed');
  assert.equal(recovered.stages.taskCompletion, 'unreported');
  assert.equal(recovered.taskCompleted, false);
});

test('reply request IDs preserve the original reference and do not send twice', async t => {
  const { service, native } = fixture(t);
  const original = await service.call('send_message', { to: 'session-b', message: 'question' }, 'session-a');
  const args = { message_id: original.messageId, message: 'answer', request_id: ids.reply };
  const first = await service.call('reply', args, 'session-b');
  const second = await service.call('reply', args, 'session-b');
  assert.equal(first.messageId, ids.reply);
  assert.equal(second.reused, true);
  assert.equal(native.sent.filter(message => message.id === ids.reply).length, 1);
});

test('ambiguous projects never receive a request and an exact UUID still selects one project', async t => {
  const { service, native } = fixture(t);
  native.threads[2].name = 'beta';
  await assert.rejects(service.call('send_message', { to: 'beta', message: 'ambiguous', request_id: ids.failed }, 'session-a'), { code: 'AMBIGUOUS_RECIPIENT' });
  assert.equal(native.sent.length, 0);
  const sent = await service.call('send_message', { to: 'session-b', message: 'exact', request_id: ids.failed }, 'session-a');
  assert.equal(sent.messageId, ids.failed);
  assert.equal(native.sent[0].to.id, 'session-b');
});
