import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { fixture, temporary } from './helpers.mjs';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { CrossSessionError } from '../plugins/cross-session/src/errors.mjs';

test('simultaneous leader claims allow exactly one leader across projects', async t => {
  const { service, store } = fixture(t);
  const results = await Promise.allSettled(['session-a', 'session-b', 'session-c'].map(id => service.call('claim_leader', {}, id)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(store.leader, 'session-a');
  assert.equal(results[1].reason.code, 'LEADER_EXISTS');
  await assert.rejects(service.call('transfer_leader', { to: 'session-c' }, 'session-b'), { code: 'NOT_LEADER' });
  await service.call('transfer_leader', { to: 'session-b' }, 'session-a');
  assert.equal(store.leader, 'session-b');
  await service.call('release_leader', {}, 'session-b');
  assert.equal(store.leader, null);
});

test('same project comes first but sending to another project is allowed', async t => {
  const { service, native } = fixture(t);
  const list = await service.call('list_agents', {}, 'session-a');
  assert.deepEqual(list.agents.map(a => a.id), ['session-a', 'session-c', 'session-b']);
  const result = await service.call('send_message', { to: 'beta', message: '다른 프로젝트에도 전달합니다.' }, 'session-a');
  assert.equal(result.delivery.method, 'turn/start');
  assert.equal(result.acknowledged, false);
  assert.equal(result.taskCompleted, false);
  assert.equal(native.sent[0].to.id, 'session-b');
});

test('replies use the original sender and only the recipient can acknowledge', async t => {
  const { service, native } = fixture(t);
  const sent = await service.call('send_message', { to: 'session-b', message: 'check evidence' }, 'session-a');
  await assert.rejects(service.call('acknowledge', { message_id: sent.messageId }, 'session-c'), { code: 'MESSAGE_NOT_FOUND' });
  const ack = await service.call('acknowledge', { message_id: sent.messageId }, 'session-b');
  assert.equal(ack.taskCompleted, false);
  await service.call('reply', { message_id: sent.messageId, message: 'evidence: report.txt' }, 'session-b');
  assert.equal(native.sent[1].to.id, 'session-a');
  assert.equal(native.sent[1].replyTo, sent.messageId);
  await assert.rejects(service.call('get_message', { message_id: sent.messageId }, 'session-c'), { code: 'MESSAGE_NOT_FOUND' });
});

test('delivery rejection is recorded and never placed in a completion queue', async t => {
  const { service, native, store } = fixture(t);
  native.error = new CrossSessionError('NATIVE_REJECTED', 'cannot steer a compact turn');
  await assert.rejects(service.call('send_message', { to: 'session-b', message: 'hello' }, 'session-a'), error => error.code === 'DELIVERY_FAILED' && error.details.queued === false);
  assert.equal([...store.messages.values()][0].status, 'failed');
  assert.equal(native.sent.length, 1);
});

test('uncertain delivery is durable and is not retried by monitoring', async t => {
  const { service, native, store } = fixture(t);
  native.error = new CrossSessionError('NATIVE_TIMEOUT', 'reply lost');
  await assert.rejects(service.call('send_message', { to: 'session-b', message: 'hello' }, 'session-a'), { code: 'DELIVERY_UNCERTAIN' });
  assert.equal([...store.messages.values()][0].status, 'uncertain');
  const outbox = await service.call('read_messages', { direction: 'outbox' }, 'session-a');
  assert.equal(outbox.messages[0].status, 'uncertain');
  assert.equal((await service.call('read_messages', {}, 'session-a')).messages.length, 0);
  await service.tick();
  assert.equal(native.sent.length, 1);
});

test('idle notification is immediate, one shot, and not task completion', async t => {
  const { service, native, store } = fixture(t);
  await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  native.threads[1].status = { type: 'idle' };
  await service.tick();
  await service.tick();
  assert.equal(native.sent.length, 2);
  assert.equal(native.sent[1].kind, 'idle-notification');
  assert.equal(native.sent[1].to.id, 'session-a');
  assert.equal([...store.messages.values()][1].delivery.method, 'turn/steer');
  assert.equal(store.subscriptions.size, 0);
});

test('subscription created while idle waits for a later active-to-idle transition', async t => {
  const { service, native } = fixture(t);
  await service.call('notify_when_idle', { to: 'session-b' }, 'session-a');
  await service.tick();
  assert.equal(native.sent.length, 0);
  native.threads[1].status = { type: 'active' };
  await service.tick();
  native.threads[1].status = { type: 'idle' };
  await service.tick();
  assert.equal(native.sent.length, 1);
});

test('old idle status cannot announce completion before a newly accepted turn finishes', async t => {
  const { service, native } = fixture(t);
  await service.call('send_message', { to: 'session-b', message: 'work', notify_when_idle: true }, 'session-a');
  native.threads[1].status = { type: 'idle' };
  native.turnFinished = async () => false;
  await service.tick();
  assert.equal(native.sent.length, 1);
  native.turnFinished = async () => true;
  await service.tick();
  assert.equal(native.sent.length, 2);
});

test('leadership is released when its exact thread leaves the daemon', async t => {
  const { service, native, store } = fixture(t);
  await service.call('claim_leader', {}, 'session-a');
  native.threads = native.threads.filter(t => t.id !== 'session-a');
  await service.call('list_agents', {}, 'session-b');
  assert.equal(store.leader, null);
  await service.call('claim_leader', {}, 'session-b');
  assert.equal(store.leader, 'session-b');
});

test('worktree hooks group projects without assigning a leader', async t => {
  const { service, store } = fixture(t);
  await service.hook({ session_id: 'session-a', hook_event_name: 'SessionStart', permission_mode: 'default' }, 'C:/repo/.git');
  await service.hook({ session_id: 'session-b', hook_event_name: 'SessionStart' }, 'C:/repo/.git');
  const list = await service.call('list_agents', {}, 'session-a');
  assert.equal(list.agents.find(t => t.id === 'session-b').sameProject, true);
  assert.equal(store.leader, null);
  await service.hook({ session_id: 'session-a', agent_id: 'child', hook_event_name: 'SessionEnd' });
  assert.equal(store.sessions.size, 2);
});

test('restart preserves leader and inbox, marks interrupted send uncertain, and repairs torn tail', t => {
  const root = temporary(t);
  let store = new Store(root);
  store.record('leader', 'session-a');
  store.record('message', { id: 'm1', status: 'sending', from: { id: 'session-a' }, to: { id: 'session-b' }, text: 'hello' });
  store.close();
  appendFileSync(store.path, '{"type":"incomplete');
  store = new Store(root);
  store.recover();
  assert.equal(store.leader, 'session-a');
  assert.equal(store.messages.get('m1').status, 'uncertain');
  assert.ok(readFileSync(store.path, 'utf8').endsWith('\n'));
  store.close();
});

test('ambiguous names and absent caller identity cannot target a different session', async t => {
  const { service, native } = fixture(t);
  native.threads[2].name = 'beta';
  await assert.rejects(service.call('send_message', { to: 'beta', message: 'hello' }, 'session-a'), { code: 'AMBIGUOUS_RECIPIENT' });
  await assert.rejects(service.call('send_message', { to: 'session-b', message: 'hello' }, 'dead-session'), { code: 'SESSION_NOT_LIVE' });
  assert.equal(native.sent.length, 0);
});
