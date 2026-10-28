import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runChainingCli } from '../plugins/cross-session/src/chaining-cli.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';

const run = promisify(execFile);
const A = '11111111-0000-4000-8000-000000000001';
const B = '11111111-0000-4000-8000-000000000002';
function temporary(t) {
  const base = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(base, 'chaining-cli-')));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), base);
    assert.match(basename(target), /^chaining-cli-/);
    rmSync(target, { recursive: true, force: true });
  });
  return root;
}

test('chain CLI exposes only session-local status and diagnostics', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const env = { CROSS_SESSION_HOME: home, CODEX_THREAD_ID: A };
  for (const args of [
    ['status', '--target', B], ['status', '--', 'ignored'], ['doctor', '--session', A],
    ['doctor', '--unknown', 'value'], ['status', '--session', '11111111']
  ]) await assert.rejects(runChainingCli(args, { env }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await runChainingCli(['status'], { env }), { mode: 'session_local', owner: A, status: 'absent', reason: 'NO_SESSION', session: null });
  assert.equal(existsSync(home), false);
  const help = (await runChainingCli(['--help'], { env })).help;
  assert.match(help, /Session-local continuity/);
  assert.match(help, /chain status/);
  assert.match(help, /chain doctor/);
  assert.doesNotMatch(help, /chain (?:link|unlink|relink|launch)/);
});

test('legacy chain commands fail before storage or process access', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const env = { CROSS_SESSION_HOME: home, CODEX_THREAD_ID: A, CROSS_SESSION_CHAIN_TICKET: 'private-fixture' };
  class Chain { constructor() { assert.fail('Legacy commands must not access continuity storage.'); } }
  for (const command of ['link', 'unlink', 'relink', 'launch']) {
    await assert.rejects(runChainingCli([command, '--unknown', 'value'], { env, Chain }), error => {
      assert.equal(error.code, 'CHAINING_SESSION_LOCAL_ONLY');
      assert.equal(error.message.includes('private-fixture'), false);
      return true;
    });
  }
  assert.equal(existsSync(home), false);
  assert.equal(env.CROSS_SESSION_CHAIN_TICKET, 'private-fixture');
});

test('chain status uses exact caller identity and read-only status options', async t => {
  const root = temporary(t), calls = [];
  class Chain {
    constructor(path) { assert.equal(path, root); }
    async status(...args) { calls.push(args); return { status: 'active', reason: 'SESSION_ACTIVE', session: { owner: A } }; }
  }
  const result = await runChainingCli(['status', '--session', A, '--detail'], { env: { CROSS_SESSION_HOME: root }, Chain });
  assert.equal(result.status, 'active');
  assert.equal(result.mode, 'session_local');
  assert.equal(result.owner, A);
  assert.deepEqual(calls, [[A, {}]]);
});

test('diagnosis combines host trust and session-local storage use without creating missing state', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const result = await runChainingCli(['doctor', '--cwd', root], {
    env: { CROSS_SESSION_HOME: home }, diagnose: async ({ cwd }) => { assert.equal(cwd, root); return { status: 'needs_attention' }; }
  });
  assert.deepEqual(result, { hooks: { status: 'needs_attention' }, storage: { status: 'empty' } });
  assert.equal(existsSync(home), false);
});

test('MCP status uses call metadata and legacy tools fail before broker access', async () => {
  const data = { mode: 'session_local', owner: A, status: 'active', reason: 'SESSION_ACTIVE', session: { owner: A, latest_checkpoint_id: null } };
  const result = await handleMcp({ method: 'tools/call', params: { name: 'get_chain', arguments: {}, _meta: { sessionId: A } } }, { async call(name, args, owner) {
    assert.equal(owner, A); assert.equal(name, 'get_chain'); assert.deepEqual(args, {});
    return data;
  } });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /session_local: active/);
  assert.match(result.content[0].text, /not user approval or proof of task completion/);
  for (const name of ['link_chain', 'unlink_chain', 'relink_chain']) {
    const bad = await handleMcp({ method: 'tools/call', params: { name, arguments: { session_id: B }, _meta: { sessionId: A } } }, { call() { assert.fail('Unexpected broker access'); } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.code, 'CHAINING_SESSION_LOCAL_ONLY');
  }
});

test('actual CLI help omits legacy usage and absent status stays read-only', async t => {
  const root = temporary(t), env = { ...process.env, CROSS_SESSION_HOME: join(root, 'missing'), CODEX_THREAD_ID: A };
  const help = await run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', '--help'], { env, windowsHide: true });
  assert.match(help.stdout, /Session-local continuity/);
  assert.doesNotMatch(help.stdout, /chain (?:link|unlink|relink|launch)/);
  const status = await run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', 'status'], { env, windowsHide: true });
  assert.deepEqual(JSON.parse(status.stdout), { mode: 'session_local', owner: A, status: 'absent', reason: 'NO_SESSION', session: null });
  assert.equal(existsSync(env.CROSS_SESSION_HOME), false);
});
