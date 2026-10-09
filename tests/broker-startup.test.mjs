import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { settings, authToken, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { temporary, FakeNative } from './helpers.mjs';

test('recovery write failure closes its journal and listener before startup rejects', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  authToken(config.root);
  const originalStore = new Store(config.root);
  originalStore.record('message', { id: 'interrupted', from: { id: 'session-a' }, to: { id: 'session-b' }, text: 'preserve', status: 'sending' });
  originalStore.close();
  const error = Object.assign(new Error('Injected recovery fsync failure'), { code: 'EIO' });
  const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  let journalFd;
  try {
    fs.openSync = (file, ...args) => {
      const fd = original.openSync(file, ...args);
      if (file === join(config.root, 'events.jsonl')) journalFd ??= fd;
      return fd;
    };
    fs.fsyncSync = () => { throw error; };
    syncBuiltinESMExports();
    await assert.rejects(startBroker({ config, native: new FakeNative(), intervalMs: 0 }), value => value === error);
  } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  assert.equal(typeof journalFd, 'number');
  try { assert.throws(() => fs.fstatSync(journalFd), { code: 'EBADF' }); }
  finally { try { fs.closeSync(journalFd); } catch { /* Already closed by the broker. */ } }
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  assert.equal(broker.service.store.messages.get('interrupted').status, 'uncertain');
  assert.equal(broker.service.store.messages.get('interrupted').text, 'preserve');
  assert.equal(broker.service.native.sent.length, 0);
  const client = new BrokerClient({ config, autoStart: false });
  assert.equal((await client.request('/health', {})).instance, config.instance);
});

test('invalid journal startup leaves bytes intact and releases its port for recovery', async t => {
  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  const path = join(config.root, 'events.jsonl');
  const invalid = '{invalid journal}\n';
  fs.writeFileSync(path, invalid);
  await assert.rejects(startBroker({ config, native: new FakeNative(), intervalMs: 0 }), SyntaxError);
  assert.equal(fs.readFileSync(path, 'utf8'), invalid);
  // Repair only this isolated fixture. The product never removes invalid events.
  fs.writeFileSync(path, '');
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  assert.equal(broker.service.store.messages.size, 0);
});
