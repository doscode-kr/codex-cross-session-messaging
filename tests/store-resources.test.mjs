import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { temporary, fixture } from './helpers.mjs';

function withFs(overrides, action) {
  const original = {};
  for (const [key, value] of Object.entries(overrides)) { original[key] = fs[key]; fs[key] = value; }
  syncBuiltinESMExports();
  try { return action(); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}
const event = (type, value) => JSON.stringify({ type, value, at: 'saved-time' });
const message = (id, text = '한국어🙂') => ({ id, text, status: 'sending', from: { id: 'a' }, to: { id: 'b' }, createdAt: 'saved-time' });
function setup(t) {
  let store;
  const root = temporary(t, () => store?.close());
  return { root, open() { store?.close(); store = new Store(root); return store; } };
}

test('streaming replay preserves UTF8 boundaries, long lines, CRLF and empty lines', t => {
  const state = setup(t);
  const text = '한국어🙂'.repeat(18000);
  const path = join(state.root, 'events.jsonl');
  fs.writeFileSync(path, `\n${event('message', message('one', text))}\r\n${event('message', message('two', '끝🙂'))}\n\n{"torn":`);
  const store = state.open();
  assert.equal(store.messages.get('one').text, text);
  assert.equal(store.messages.get('two').text, '끝🙂');
  assert.deepEqual([...store.messages.keys()], ['one', 'two']);
  const bytes = fs.readFileSync(path);
  assert.equal(bytes.at(-1), 10);
  assert.equal(bytes.includes(Buffer.from('{"torn":')), false);
  assert.equal(state.open().messages.get('one').text, text);
});

test('malformed complete lines preserve the original file including a torn tail', t => {
  const state = setup(t);
  const path = join(state.root, 'events.jsonl');
  const bytes = Buffer.from(`${event('leader', 'a')}\n{invalid}\n{"torn":`);
  fs.writeFileSync(path, bytes);
  assert.throws(() => state.open(), SyntaxError);
  assert.deepEqual(fs.readFileSync(path), bytes);
});

test('short reads preserve byte offsets and lazy body reads', t => {
  const state = setup(t);
  fs.writeFileSync(join(state.root, 'events.jsonl'), `${event('message', message('one', '한국어🙂'.repeat(900)))}\n`);
  const read = fs.readSync;
  withFs({ readSync: (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 17), position) }, () => {
    const store = state.open();
    assert.equal(store.messages.get('one').text, '한국어🙂'.repeat(900));
  });
});

test('read errors and zero progress do not truncate a torn tail and close the failed descriptor', t => {
  for (const mode of ['throw', 'zero']) {
    const root = temporary(t);
    const path = join(root, 'events.jsonl');
    const bytes = Buffer.from(`${event('message', message('one', 'x'.repeat(80000)))}\n{"torn":`);
    fs.writeFileSync(path, bytes);
    const open = fs.openSync, read = fs.readSync;
    let fd, calls = 0;
    withFs({
      openSync: (...args) => { fd = open(...args); return fd; },
      readSync: (...args) => {
        if (++calls === 2) {
          if (mode === 'zero') return 0;
          throw Object.assign(new Error('Injected read failure'), { code: 'EIO' });
        }
        return read(...args);
      }
    }, () => assert.throws(() => new Store(root), { code: mode === 'zero' ? 'STORE_READ_FAILED' : 'EIO' }));
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.deepEqual(fs.readFileSync(path), bytes);
  }
});

test('lazy text keeps the original message identity and metadata operations do not read bodies', t => {
  const state = setup(t);
  const store = state.open();
  const original = message('one');
  store.record('message', original);
  assert.equal(store.messages.get('one'), original);
  const descriptor = Object.getOwnPropertyDescriptor(original, 'text');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, true);
  let reads = 0;
  const read = fs.readSync;
  withFs({ readSync: (...args) => { reads++; return read(...args); } }, () => {
    store.record('ack', { id: 'one', at: 'received-time' });
    store.recover();
    store.record('delivery', { id: 'one', status: 'uncertain', error: { code: 'BROKER_RESTARTED', message: 'The broker stopped before saving the native result. Do not resend automatically.' } });
    assert.equal(original.acknowledgedAt, 'received-time');
    assert.equal(original.status, 'uncertain');
    assert.equal(reads, 0);
    assert.equal(JSON.parse(JSON.stringify(original)).text, '한국어🙂');
    assert.equal(reads, 1);
    assert.equal(original.text, '한국어🙂');
    assert.equal(reads, 2);
  });
  const restored = state.open().messages.get('one');
  assert.equal(restored.text, '한국어🙂');
  assert.equal(restored.acknowledgedAt, 'received-time');
  assert.equal(restored.status, 'uncertain');
});

test('body lookup fails closed on a truncated file and prevents later writes', t => {
  const state = setup(t);
  const store = state.open();
  store.record('message', message('one'));
  fs.truncateSync(store.path, 10);
  assert.throws(() => store.messages.get('one').text, { code: 'STORE_READ_FAILED' });
  assert.throws(() => store.record('leader', null), { code: 'STORE_UNAVAILABLE' });
  assert.equal(fs.statSync(store.path).size, 10);
});

test('a lazy disk read error is reported and blocks even an unchanged write', t => {
  const state = setup(t);
  const store = state.open();
  store.record('leader', 'a');
  store.record('message', message('one'));
  const before = fs.readFileSync(store.path);
  withFs({ readSync: () => { throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' }); } }, () => {
    assert.throws(() => store.messages.get('one').text, { code: 'EIO' });
  });
  assert.throws(() => store.record('leader', 'a'), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(store.path), before);
});

test('lazy lookup after close reports STORE_CLOSED', t => {
  const state = setup(t);
  const store = state.open();
  store.record('message', message('one'));
  const saved = store.messages.get('one');
  store.close();
  assert.throws(() => saved.text, { code: 'STORE_CLOSED' });
  assert.throws(() => store.record('leader', 'a'), { code: 'STORE_CLOSED' });
});

test('identical metadata events avoid writes while timestamp changes remain durable', t => {
  const state = setup(t);
  const store = state.open();
  const events = [
    ['leader', 'a'], ['session', { id: 'a', name: 'Alice', updatedAt: 'first' }],
    ['message', message('one')], ['delivery', { id: 'one', status: 'accepted', delivery: { accepted: true, method: 'turn/start', turnId: 'turn' } }],
    ['ack', { id: 'one', at: 'received' }], ['subscription', { id: 'sub', from: 'a', to: 'b', turnId: 'turn', sawActive: true }]
  ];
  for (const [type, value] of events) store.record(type, value);
  const before = fs.readFileSync(store.path);
  withFs({ readSync: () => { throw new Error('Metadata comparison read a body'); } }, () => {
    for (const [type, value] of events) if (type !== 'message') store.record(type, value);
  });
  assert.deepEqual(fs.readFileSync(store.path), before);
  store.record('session', { id: 'a', updatedAt: 'second' });
  store.record('ack', { id: 'one', at: 'later' });
  assert.ok(fs.statSync(store.path).size > before.length);
  store.record('subscription_done', 'sub');
  const done = fs.readFileSync(store.path);
  store.record('subscription_done', 'sub');
  assert.deepEqual(fs.readFileSync(store.path), done);
  store.failure = new Error('Injected failure');
  assert.throws(() => store.record('leader', 'a'), { code: 'STORE_UNAVAILABLE' });
  const restored = state.open();
  assert.equal(restored.sessions.get('a').updatedAt, 'second');
  assert.equal(restored.messages.get('one').acknowledgedAt, 'later');
  assert.equal(restored.messages.get('one').status, 'accepted');
  assert.equal(restored.messages.get('one').text, '한국어🙂');
  assert.equal(restored.subscriptions.size, 0);
});

test('same ID replacement, body updates and insertion order survive restart', t => {
  const state = setup(t);
  const store = state.open();
  const first = message('one', 'original');
  const replacement = message('one', 'replacement🙂');
  store.record('message', first);
  store.record('message', message('two'));
  store.record('message', replacement);
  assert.equal(store.messages.get('one'), replacement);
  assert.equal(first.text, 'original');
  store.record('delivery', { id: 'one', status: 'accepted', text: 'changed한글', replyTo: 'two', error: { code: 'saved' } });
  store.record('subscription', { id: 'sub', from: 'a', to: 'b', turnId: 'turn', sawActive: true });
  const restored = state.open();
  assert.deepEqual([...restored.messages.keys()], ['one', 'two']);
  assert.equal(restored.messages.get('one').text, 'changed한글');
  assert.equal(restored.messages.get('one').replyTo, 'two');
  assert.deepEqual(restored.messages.get('one').error, { code: 'saved' });
  assert.equal(restored.subscriptions.get('sub').turnId, 'turn');
});

test('bounded history reads only returned bodies and keeps direction and privacy filters', async t => {
  const { service, store } = fixture(t);
  for (let index = 0; index < 250; index++) {
    const foreign = index % 7 === 0;
    const outgoing = index % 3 === 0;
    const value = { ...message(`message-${index}`, '한글🙂'.repeat(1000)),
      from: { id: foreign ? 'session-c' : outgoing ? 'session-a' : 'session-b' },
      to: { id: foreign ? 'foreign' : outgoing ? 'session-b' : 'session-a' },
      status: 'accepted' };
    store.record('message', value);
    if (index % 4 === 0) store.record('ack', { id: value.id, at: 'received' });
  }
  const read = store.readEvent.bind(store);
  let reads = 0;
  store.readEvent = location => { reads++; return read(location); };
  for (const direction of ['inbox', 'outbox', 'both']) {
    for (const unacknowledged_only of [false, true]) {
      const expected = [...store.messages.values()].filter(value =>
        ((direction !== 'outbox' && value.to.id === 'session-a') || (direction !== 'inbox' && value.from.id === 'session-a')) &&
        (!unacknowledged_only || !value.acknowledgedAt)).slice(-7).map(value => value.id);
      const before = reads;
      const result = await service.call('read_messages', { direction, unacknowledged_only, limit: 7 }, 'session-a');
      assert.equal(reads, before);
      assert.deepEqual(result.messages.map(value => value.id), expected);
      JSON.stringify(result);
      assert.equal(reads - before, expected.length);
    }
  }
});

test('large journal replays under a small heap and preserves every body hash', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  const hash = createHash('sha256');
  const body = 'x'.repeat(15990) + '한글🙂';
  for (let index = 0; index < 6000; index++) {
    const text = `${index}:${body}`;
    hash.update(text);
    fs.appendFileSync(path, event('message', message(`message-${index}`, text)) + '\n');
  }
  const code = `
    import { Store } from './plugins/cross-session/src/store.mjs';
    import { createHash } from 'node:crypto';
    const store = new Store(process.argv[1]);
    const hash = createHash('sha256');
    for (const message of store.messages.values()) hash.update(message.text);
    const result = { count: store.messages.size, hash: hash.digest('hex') };
    store.close();
    process.stdout.write(JSON.stringify(result));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', code, root], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  assert.equal(result.count, 6000);
  assert.equal(result.hash, hash.digest('hex'));
});
