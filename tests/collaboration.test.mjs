import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';

test('all peers exchange messages without a leader and keep replies with their sender', async t => {
  const { service, native, store } = fixture(t);
  const peers = ['session-a', 'session-b', 'session-c'];
  for (let index = 0; index < peers.length; index++) {
    const from = peers[index];
    const to = peers[(index + 1) % peers.length];
    const request = await service.call('send_message', { to, message: `Question from ${from}` }, from);
    const reply = await service.call('reply', { message_id: request.messageId, message: `Answer from ${to}` }, to);
    assert.equal(store.messages.get(reply.messageId).to.id, from);
    assert.equal(store.messages.get(reply.messageId).replyTo, request.messageId);
  }
  assert.equal(store.leader, null);
  assert.equal(native.sent.length, 6);
  assert.deepEqual(native.sent.map(message => [message.from.id, message.to.id]), [
    ['session-a', 'session-b'], ['session-b', 'session-a'],
    ['session-b', 'session-c'], ['session-c', 'session-b'],
    ['session-c', 'session-a'], ['session-a', 'session-c']
  ]);
});

test('workers report an agreement without giving the leader access to private peer messages', async t => {
  const { service, store } = fixture(t);
  const client = { call: (...args) => service.call(...args) };
  const call = async (id, name, args = {}) => handleMcp({ method: 'tools/call', params: {
    name, arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: id } }
  } }, client);
  const success = async (id, name, args) => {
    const result = await call(id, name, args);
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  await success('session-c', 'claim_leader');
  const request = await success('session-a', 'send_message', { to: 'session-b', message: 'Can you check this interface?' });
  const reply = await success('session-b', 'reply', { message_id: request.messageId, message: 'The interface can remain unchanged.' });
  assert.equal((await success('session-c', 'read_messages', { direction: 'both' })).messages.length, 0);
  for (const name of ['get_message', 'acknowledge', 'reply']) {
    const result = await call('session-c', name, { message_id: request.messageId, ...(name === 'reply' ? { message: 'Forged reply' } : {}) });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'MESSAGE_NOT_FOUND');
  }
  const forged = await call('session-b', 'send_message', { to: 'leader', message: 'Report', reply_to: request.messageId });
  assert.equal(forged.isError, true);
  assert.equal(forged.structuredContent.code, 'INVALID_REPLY');
  const report = await success('session-b', 'send_message', { to: 'leader', message: 'We agreed to keep the interface.' });
  assert.equal(report.status, 'accepted');
  assert.equal(report.acknowledged, false);
  assert.equal(report.taskCompleted, false);
  const inbox = await success('session-c', 'read_messages');
  assert.deepEqual(inbox.messages.map(message => message.id), [report.messageId]);
  assert.equal(store.messages.size, 3);
  assert.equal(store.messages.get(reply.messageId).to.id, 'session-a');
  assert.equal(store.messages.get(request.messageId).acknowledgedAt, undefined);
});
