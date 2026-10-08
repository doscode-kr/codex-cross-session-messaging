import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { temporary, FakeNative } from './helpers.mjs';

function withFs(overrides, action) {
  const original = {};
  for (const [name, value] of Object.entries(overrides)) {
    original[name] = fs[name];
    fs[name] = value;
  }
  syncBuiltinESMExports();
  try { return action(); }
  finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
}
function ioError() { return Object.assign(new Error('Injected storage failure.'), { code: 'EIO' }); }
function setup(t) {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  store.record('leader', 'session-a');
  return { root, get store() { return store; }, reopen() { store.close(); store = new Store(root); return store; } };
}
const message = () => ({ id: 'message-1', status: 'sending', from: { id: 'session-a' }, to: { id: 'session-b' }, text: '한글 '.repeat(100) });

test('fsync failure blocks later writes and preserves the complete event for restart', t => {
  const state = setup(t);
  const error = ioError();
  withFs({ fsyncSync: () => { throw error; } }, () => {
    assert.throws(() => state.store.record('message', message()), value => value === error);
  });
  const failedBytes = fs.readFileSync(state.store.path);
  assert.equal(state.store.messages.size, 0);
  assert.throws(() => state.store.record('leader', null), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(state.store.path), failedBytes);
  const reopened = state.reopen();
  reopened.recover();
  assert.equal(reopened.leader, 'session-a');
  assert.equal(reopened.messages.get('message-1').text, message().text);
  assert.equal(reopened.messages.get('message-1').status, 'uncertain');
});

test('partial write failure blocks later writes and restart removes only the torn event', t => {
  const state = setup(t);
  const complete = fs.readFileSync(state.store.path);
  const write = fs.writeSync;
  let calls = 0;
  withFs({ writeSync: (fd, bytes, offset, length, position) => {
    if (++calls === 1) return write(fd, bytes, offset, 47, position);
    throw ioError();
  } }, () => assert.throws(() => state.store.record('message', message()), { code: 'EIO' }));
  const failedBytes = fs.readFileSync(state.store.path);
  assert.equal(failedBytes.length, complete.length + 47);
  assert.throws(() => state.store.record('leader', null), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(state.store.path), failedBytes);
  const reopened = state.reopen();
  assert.equal(reopened.leader, 'session-a');
  assert.equal(reopened.messages.size, 0);
  assert.deepEqual(fs.readFileSync(reopened.path), complete);
  reopened.record('message', message());
  assert.equal(state.reopen().messages.get('message-1').status, 'sending');
});

test('zero progress write fails once and blocks later writes', t => {
  const state = setup(t);
  const complete = fs.readFileSync(state.store.path);
  let calls = 0;
  withFs({ writeSync: () => { calls++; return 0; } }, () => {
    assert.throws(() => state.store.record('message', message()), { code: 'STORE_WRITE_FAILED' });
  });
  assert.equal(calls, 1);
  assert.throws(() => state.store.record('leader', null), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(state.store.path), complete);
});

test('short successful writes produce a complete replayable event', t => {
  const state = setup(t);
  const write = fs.writeSync;
  withFs({ writeSync: (fd, bytes, offset, length, position) => write(fd, bytes, offset, Math.min(length, 13), position) }, () => {
    state.store.record('message', message());
  });
  assert.equal(state.reopen().messages.get('message-1').text, message().text);
});

test('journal replay failure closes the constructor file descriptor', t => {
  const root = temporary(t);
  const path = `${root}/events.jsonl`;
  fs.writeFileSync(path, '{invalid json}\n');
  const open = fs.openSync, close = fs.closeSync;
  let opened;
  const closed = [];
  withFs({
    openSync: (...args) => { const fd = open(...args); opened ??= fd; return fd; },
    closeSync: fd => { closed.push(fd); return close(fd); }
  }, () => assert.throws(() => new Store(root), SyntaxError));
  assert.ok(closed.includes(opened));
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  assert.equal(fs.readFileSync(path, 'utf8'), '{invalid json}\n');
});

test('failed journal blocks later service delivery and does not resend a recovered message', async t => {
  const state = setup(t);
  withFs({ fsyncSync: () => { throw ioError(); } }, () => {
    assert.throws(() => state.store.record('message', message()), { code: 'EIO' });
  });
  const native = new FakeNative();
  const service = new MessagingService(state.store, native);
  await assert.rejects(service.call('send_message', { to: 'session-b', message: 'new message' }, 'session-a'), { code: 'STORE_UNAVAILABLE' });
  assert.equal(native.sent.length, 0);
  const reopened = state.reopen();
  reopened.recover();
  const restored = new MessagingService(reopened, native);
  await restored.tick();
  assert.equal(native.sent.length, 0);
  assert.equal(reopened.messages.get('message-1').status, 'uncertain');
});
