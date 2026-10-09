import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { validateRuntimeJournal } from '../scripts/runtime-journal.mjs';
import { temporary } from './helpers.mjs';

const marker = 'PRIV42';
const damagedEvents = [
  Buffer.from(`${marker}\n{"torn":`),
  Buffer.from(JSON.stringify({ type: marker }) + '\n{"torn":'),
  Buffer.concat([Buffer.from('{"type":"message","value":{"text":"'), Buffer.from([0xff]), Buffer.from('"}}\n{"torn":')]),
  Buffer.from('null\n{"torn":')
];

test('uninstall refuses damaged complete events without exposing text or changing files', t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const runtime = join(home, 'cross-session');
  fs.mkdirSync(runtime, { recursive: true });
  const token = 'a'.repeat(64);
  fs.writeFileSync(join(runtime, 'auth-token'), token);
  for (const bytes of damagedEvents) {
    const path = join(runtime, 'events.jsonl');
    fs.writeFileSync(path, bytes);
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/uninstall.mjs'), '--home', home, '--dry-run', '--purge-runtime'], {
      env: { ...process.env, CROSS_SESSION_CODEX_BIN: join(root, 'must-not-run-codex') }, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5000
    }), error => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /runtime journal could not be validated/);
      assert.equal(error.stderr.includes(marker), false);
      assert.equal(error.stderr.includes(token), false);
      return true;
    });
    assert.deepEqual(fs.readFileSync(path), bytes);
    assert.equal(fs.readFileSync(join(runtime, 'auth-token'), 'utf8'), token);
    assert.deepEqual(fs.readdirSync(home), ['cross-session']);
  }
});

test('runtime validation closes read-only descriptors after parse and read failures', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  const open = fs.openSync, read = fs.readSync;
  for (const mode of ['parse', 'read']) {
    const bytes = Buffer.from(mode === 'parse' ? marker + '\n' : '{"type":"leader","value":null}\n');
    fs.writeFileSync(path, bytes);
    let fd;
    try {
      fs.openSync = (file, flags, ...rest) => { assert.equal(flags, 'r'); fd = open(file, flags, ...rest); return fd; };
      fs.readSync = (...args) => { if (mode === 'read') throw Object.assign(new Error(marker), { code: 'EIO' }); return read(...args); };
      syncBuiltinESMExports();
      assert.throws(() => validateRuntimeJournal(path), error => {
        assert.match(error.message, /runtime journal could not be validated/);
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.cause, undefined);
        assert.equal(error.details, undefined);
        return true;
      });
    } finally { fs.openSync = open; fs.readSync = read; syncBuiltinESMExports(); }
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.deepEqual(fs.readFileSync(path), bytes);
  }
});

test('runtime validation preserves valid long events, empty lines and an incomplete tail', t => {
  const root = temporary(t);
  const path = join(root, 'events.jsonl');
  const bytes = Buffer.concat([Buffer.from('\n' + JSON.stringify({ type: 'message', value: { text: '한글🙂'.repeat(18000) } }) + '\r\n'), Buffer.from([0xff, 0xe2, 0x82])]);
  fs.writeFileSync(path, bytes);
  validateRuntimeJournal(path);
  assert.deepEqual(fs.readFileSync(path), bytes);
});
