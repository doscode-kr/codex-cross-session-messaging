import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { BrokerClient, settings } from '../plugins/cross-session/src/client.mjs';
import { temporary, FakeNative } from './helpers.mjs';

const marker = 'private-message-example';

test('unknown event types do not expose journal fields or remove bytes', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  const bytes = Buffer.from(JSON.stringify({ type: marker, value: null }) + '\n{"torn":');
  writeFileSync(path, bytes);
  assert.throws(() => new Store(root), error => {
    assert.equal(error.message.includes(marker), false);
    assert.match(error.message, /unknown event type/);
    return true;
  });
  assert.deepEqual(readFileSync(path), bytes);
});

test('invalid JSON startup keeps bytes and omits source text from stderr', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  const bytes = Buffer.from(`${marker}\n{"torn":`);
  writeFileSync(path, bytes);
  assert.throws(() => new Store(root), error => {
    assert.ok(error instanceof SyntaxError);
    assert.equal(error.message.includes(marker), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.details, undefined);
    return true;
  });
  assert.throws(() => execFileSync(process.execPath, [resolve('plugins/cross-session/src/broker.mjs')], {
    env: { ...process.env, CROSS_SESSION_HOME: root }, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: 'pipe'
  }), error => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.includes(marker), false);
    assert.match(error.stderr, /journal.*invalid JSON/i);
    return true;
  });
  assert.deepEqual(readFileSync(path), bytes);
});

test('lazy JSON failure returns a private error and blocks later writes', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const config = settings({ CROSS_SESSION_HOME: root });
  const native = new FakeNative();
  broker = await startBroker({ config, native, intervalMs: 0 });
  const client = new BrokerClient({ config, autoStart: false });
  const sent = await client.call('send_message', { to: 'session-b', message: 'original body' }, 'session-a');
  const store = broker.service.store;
  const original = readFileSync(store.path);
  const damaged = Buffer.from(marker.padEnd(original.length - 1, ' ') + '\n');
  writeSync(store.fd, damaged, 0, damaged.length, 0);
  await assert.rejects(client.call('get_message', { message_id: sent.messageId }, 'session-a'), error => {
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.match(error.message, /journal.*invalid JSON/i);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  });
  assert.ok(store.failure instanceof SyntaxError);
  assert.equal(store.failure.cause, undefined);
  await assert.rejects(client.call('send_message', { to: 'session-b', message: 'must not send' }, 'session-a'), { code: 'STORE_UNAVAILABLE' });
  assert.equal(native.sent.length, 1);
  assert.equal((await client.request('/health', {})).instance, config.instance);
  assert.deepEqual(readFileSync(store.path), damaged);
});
