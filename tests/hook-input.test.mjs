import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput, runHook } from '../plugins/cross-session/src/hooks.mjs';
import { temporary } from './helpers.mjs';

test('hook input preserves Korean and emoji at every byte boundary', async () => {
  const input = { hook_event_name: 'SessionStart', session_id: 'session', cwd: 'C:/한글 프로젝트/🛰️', permission_mode: 'default' };
  const bytes = Buffer.from(JSON.stringify(input));
  for (let cut = 1; cut < bytes.length; cut++) {
    const parsed = await readHookInput(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]));
    assert.deepEqual(parsed, input, `byte boundary ${cut}`);
  }
  let received;
  const parsed = await readHookInput(Readable.from([...bytes].map(byte => Buffer.from([byte]))));
  await runHook(parsed, { async hook(value, projectRoot) { received = { value, projectRoot }; } });
  assert.equal(received.projectRoot, input.cwd);
  assert.equal(received.value.session_id, input.session_id);
});

test('hook input measures the existing 128 KiB limit in bytes', async () => {
  const bytes = Buffer.from(JSON.stringify({ cwd: '한글 🛰️' }));
  const exact = Buffer.concat([bytes, Buffer.alloc(131072 - bytes.length, 32)]);
  assert.deepEqual(await readHookInput(Readable.from([exact.subarray(0, 3), exact.subarray(3)])), { cwd: '한글 🛰️' });
  await assert.rejects(readHookInput(Readable.from([exact, Buffer.from(' ')])), /exceeds 128 KiB/);
});

test('invalid JSON and input stream failure cannot produce a partial hook payload', async () => {
  await assert.rejects(readHookInput(Readable.from([Buffer.from('{"cwd":"한글"')])), SyntaxError);
  const failure = new Error('input failed');
  async function* broken() { yield Buffer.from('{'); throw failure; }
  await assert.rejects(readHookInput(broken()), error => error === failure);
});

test('ignored and invalid hook inputs do not create a broker state directory', async t => {
  const root = temporary(t);
  for (const [label, input, stderrPattern] of [
    ['unsupported', JSON.stringify({ hook_event_name: 'Unknown', session_id: 'session' }), /^$/],
    ['invalid', '{', /^cross-session hook:/],
    ['oversized', JSON.stringify({ agent_id: 'child', padding: 'x'.repeat(131072) }), /Hook input exceeds 128 KiB/]
  ]) {
    const state = join(root, label);
    const child = spawn(process.execPath, ['plugins/cross-session/src/hooks.mjs'], { windowsHide: true, env: { ...process.env, CROSS_SESSION_HOME: state } });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    child.stdin.end(input);
    assert.equal(await done, 0);
    assert.deepEqual(JSON.parse(stdout), {});
    assert.match(stderr, stderrPattern);
    assert.equal(existsSync(state), false);
  }
});
