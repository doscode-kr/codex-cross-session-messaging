import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { temporary } from './helpers.mjs';

test('invalid UTF-8 in a complete event rejects startup without removing its torn tail', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  for (const invalid of [[0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
    const bytes = Buffer.concat([
      Buffer.from('{"type":"leader","value":null}\n{"type":"message","value":{"id":"a","text":"'),
      Buffer.from(invalid), Buffer.from('"}}\n{"torn":')
    ]);
    writeFileSync(path, bytes);
    assert.throws(() => { const unexpected = new Store(root); unexpected.close(); }, { code: 'STORE_READ_FAILED' });
    assert.deepEqual(readFileSync(path), bytes);
  }
});

test('lazy body corruption fails closed without writing replacement characters', t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  store.record('message', { id: 'one', text: 'unique-body-한국어🙂' });
  const original = readFileSync(store.path);
  const offset = original.indexOf(Buffer.from('unique-body'));
  assert.ok(offset >= 0);
  writeSync(store.fd, Buffer.from([0xff]), 0, 1, offset);
  const corrupted = readFileSync(store.path);
  assert.throws(() => store.messages.get('one').text, { code: 'STORE_READ_FAILED' });
  assert.equal(store.failure.code, 'STORE_READ_FAILED');
  assert.throws(() => store.record('leader', 'someone'), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(readFileSync(store.path), corrupted);
  writeSync(store.fd, original, 0, original.length, 0);
  assert.equal(store.messages.get('one').text, 'unique-body-한국어🙂');
  assert.throws(() => store.record('leader', 'someone'), { code: 'STORE_UNAVAILABLE' });
});

test('strict UTF-8 keeps the existing BOM rejection and torn-tail repair rules', t => {
  let store;
  const root = temporary(t, () => store?.close());
  const path = join(root, 'events.jsonl');
  const complete = Buffer.from('{"type":"message","value":{"id":"one","text":"한글🙂"}}\n');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), complete]);
  writeFileSync(path, bom);
  assert.throws(() => new Store(root), SyntaxError);
  assert.deepEqual(readFileSync(path), bom);
  writeFileSync(path, Buffer.concat([complete, Buffer.from([0xff, 0xe2, 0x82])]));
  store = new Store(root);
  assert.equal(store.messages.get('one').text, '한글🙂');
  assert.deepEqual(readFileSync(path), complete);
});
