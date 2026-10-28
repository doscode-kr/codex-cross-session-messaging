import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, FakeNative } from './helpers.mjs';
import { settings } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../plugins/cross-session/src/cli.mjs', import.meta.url));
async function cli(root, args, caller = '') {
  try {
    const result = await execute(process.execPath, [entry, ...args], { env: { ...process.env, CROSS_SESSION_HOME: root, CODEX_HOME: join(root, 'codex-home'), CODEX_THREAD_ID: caller }, windowsHide: true, timeout: 5000 });
    return { exit: 0, ...result };
  } catch (error) { return { exit: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test('the CLI rejects a missing message before another option without delivery', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const config = settings({ CROSS_SESSION_HOME: root });
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  let requests = 0;
  broker.server.on('request', () => requests++);
  const result = await cli(root, ['send_message', '--session', 'session-a', '--to', 'session-b', '--message', '--notify-when-idle']);
  assert.equal(result.exit, 1);
  assert.equal(JSON.parse(result.stderr).code, 'INVALID_ARGUMENT');
  assert.equal(requests, 0);
  assert.equal(native.sent.length, 0);
  assert.equal(broker.service.store.subscriptions.size, 0);
});

test('invalid CLI input and missing identity do not create message state', async t => {
  const parent = temporary(t);
  const root = join(parent, 'missing', 'state');
  const cases = [
    ['send_message', '--session', 'session-a', '--to', 'session-b', '--message'],
    ['send_message', '--session', 'session-a', '--to', '--message=body'],
    ['send_message', '--session', '--to=session-b', '--message=body'],
    ['send_message', '--session=', '--to=session-b', '--message=body'],
    ['send_message', '--session=session-a', '--to=session-b', '--message='],
    ['read_messages', '--session=session-a', '--limit', '--direction=inbox'],
    ['read_messages', '--session=session-a', '--limit=bad'],
    ['read_messages', '--session=session-a', '--detail=bad'],
    ['read_messages', '--session=session-a', '--unknown=value'],
    ['read_messages', '--session=session-a', '--__proto__=value'],
    ['read_messages', '--session=session-a', 'unexpected'],
  ];
  for (const args of cases) {
    const result = await cli(root, args);
    assert.equal(result.exit, 1);
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_ARGUMENT');
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(parent, 'missing')), false);
  }
  const unknown = await cli(root, ['unknown_tool', '--session=session-a']);
  assert.equal(unknown.exit, 1);
  assert.equal(JSON.parse(unknown.stderr).code, 'UNKNOWN_TOOL');
  assert.equal(existsSync(join(parent, 'missing')), false);
  for (const command of ['link_chain', 'unlink_chain', 'relink_chain']) {
    const legacy = await cli(root, [command, '--session=session-a', '--arbitrary=value']);
    assert.equal(legacy.exit, 1);
    assert.equal(JSON.parse(legacy.stderr).code, 'CHAINING_SESSION_LOCAL_ONLY');
    assert.equal(existsSync(join(parent, 'missing')), false);
  }
  const missingIdentity = await cli(root, ['list_agents']);
  assert.equal(missingIdentity.exit, 1);
  assert.equal(JSON.parse(missingIdentity.stderr).code, 'IDENTITY_MISSING');
  assert.equal(existsSync(join(parent, 'missing')), false);
});

test('the actual CLI preserves explicit values, booleans, history, replies and environment identity', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const config = settings({ CROSS_SESSION_HOME: root });
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  async function call(args, caller) {
    const result = await cli(root, args, caller);
    assert.equal(result.exit, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const registered = await call(['register_session', '--name=alpha'], 'session-a');
  assert.equal(registered.name, 'alpha');
  const listed = await call(['list_agents', '--session=session-a', '--detail']);
  assert.equal(listed.self, 'session-a');
  assert.equal(listed.agents.length, 3);
  const invalidId = await cli(root, ['send_message', '--session=session-a', '--to=session-b', '--message=invalid-id', '--request-id=short']);
  assert.equal(invalidId.exit, 1);
  assert.equal(JSON.parse(invalidId.stderr).code, 'INVALID_ARGUMENT');
  assert.equal(native.sent.length, 0);
  const requestId = '66666666-6666-4666-8666-666666666666';
  const firstArgs = ['send_message', '--session=session-a', '--to=session-b', '--message=--notify-when-idle', '--notify-when-idle=false', `--request-id=${requestId}`];
  const first = await call(firstArgs);
  assert.equal(first.status, 'accepted');
  assert.equal(first.messageId, requestId);
  assert.equal(native.sent[0].text, '--notify-when-idle');
  assert.equal(broker.service.store.subscriptions.size, 0);
  const repeated = await call(firstArgs);
  assert.equal(repeated.reused, true);
  assert.equal(native.sent.length, 1);
  const text = '한글😀=first\nsecond';
  const second = await call(['send_message', '--session', 'session-a', '--to', 'session-b', '--message=discarded', `--message=${text}`, '--notify_when_idle']);
  assert.equal(second.status, 'accepted');
  assert.equal(native.sent[1].text, text);
  assert.equal(broker.service.store.subscriptions.size, 1);
  const history = await call(['read_messages', '--session=session-b', '--direction=inbox', '--limit=1', '--unacknowledged-only=true', '--detail=false']);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, text);
  assert.equal(history.nextCursor, second.messageId);
  const older = await call(['read_messages', '--session=session-b', '--direction=inbox', '--limit', '1', `--before-message-id=${history.nextCursor}`]);
  assert.equal(older.messages[0].id, first.messageId);
  assert.equal(older.messages[0].text, '--notify-when-idle');
  const ack = await call(['acknowledge', '--session=session-b', `--message-id=${second.messageId}`]);
  assert.equal(ack.id, second.messageId);
  const replyId = '77777777-7777-4777-8777-777777777777';
  const replyArgs = ['reply', '--session=session-b', `--message-id=${second.messageId}`, '--message=--answer=value', `--request-id=${replyId}`];
  const reply = await call(replyArgs);
  assert.equal(reply.status, 'accepted');
  assert.equal(reply.messageId, replyId);
  const repeatedReply = await call(replyArgs);
  assert.equal(repeatedReply.reused, true);
  assert.equal(broker.service.store.messages.get(replyId).replyTo, second.messageId);
  assert.equal(native.sent.length, 3);
  assert.equal(native.sent[2].text, '--answer=value');
  const [sub] = broker.service.store.subscriptions.values();
  await call(['cancel_idle_notification', '--session=session-a', `--subscription-id=${sub.id}`]);
  assert.equal(broker.service.store.subscriptions.size, 0);
});
