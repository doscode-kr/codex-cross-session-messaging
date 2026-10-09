import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { temporary, FakeNative } from './helpers.mjs';

test('journal body read failure returns an error without stopping the broker', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false, timeoutMs: 2000 });
  const sent = await client.call('send_message', { to: 'session-b', message: 'preserved body' }, 'session-a');
  const error = Object.assign(new Error('Injected journal read failure'), { code: 'EIO' });
  const read = fs.readSync;
  const journalFd = broker.service.store.fd;
  try {
    fs.readSync = (fd, ...args) => { if (fd === journalFd) throw error; return read(fd, ...args); };
    syncBuiltinESMExports();
    await assert.rejects(client.call('get_message', { message_id: sent.messageId }, 'session-a'), { code: 'EIO', message: error.message });
    await assert.rejects(client.call('read_messages', {}, 'session-b'), { code: 'EIO' });
  } finally { fs.readSync = read; syncBuiltinESMExports(); }
  assert.equal((await client.request('/health', {})).instance, config.instance);
  assert.equal(broker.service.store.failure, error);
  await assert.rejects(client.call('send_message', { to: 'session-b', message: 'must not send' }, 'session-a'), { code: 'STORE_UNAVAILABLE' });
  assert.equal(native.sent.length, 1);
  assert.equal((await client.call('get_message', { message_id: sent.messageId }, 'session-a')).text, 'preserved body');
});
