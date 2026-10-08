import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';

export function temporary(t, beforeCleanup = () => {}) {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'codex-cross-session-test-')));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith('codex-cross-session-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}
export class FakeNative {
  constructor() {
    this.threads = [
      { id: 'session-a', name: 'alpha', cwd: 'C:/project-a', status: { type: 'active', activeFlags: [] } },
      { id: 'session-b', name: 'beta', cwd: 'C:/project-b', status: { type: 'idle' } },
      { id: 'session-c', name: 'gamma', cwd: 'C:/project-a', status: { type: 'idle' } }
    ];
    this.sent = [];
    this.info = { status: 'running', appServerVersion: 'fake' };
  }
  async list() { return this.threads; }
  async turnFinished(id) { return this.threads.find(thread => thread.id === id)?.status.type === 'idle'; }
  async deliver(message) {
    this.sent.push(message);
    if (this.error) throw this.error;
    const thread = this.threads.find(t => t.id === message.to.id);
    const method = thread.status.type === 'active' ? 'turn/steer' : 'turn/start';
    thread.status = { type: 'active', activeFlags: [] };
    return { accepted: true, method, turnId: 'fake-turn' };
  }
  close() {}
}
export function fixture(t) {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  const native = new FakeNative();
  return { root, store, native, service: new MessagingService(store, native) };
}
