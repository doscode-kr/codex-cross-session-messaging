import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runChainingCli } from '../plugins/cross-session/src/chaining-cli.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';

const run = promisify(execFile);
const A = '11111111-0000-4000-8000-000000000001';
const B = '11111111-0000-4000-8000-000000000002';
const C = '22222222-0000-4000-8000-000000000001';
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

test('chain CLI validates options and UUIDs before it creates state', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const env = { CROSS_SESSION_HOME: home, CODEX_THREAD_ID: A };
  for (const args of [
    ['link', '--chain-id', '../bad'], ['link', '--chain-id', 'work', '--source-session-id', '11111111'],
    ['link', '--chain-id', 'work', '--session', '11111111'], ['status', '--target', B],
    ['unlink', '--expected-chain-id', 'work', '--expected-checkpoint-id', 'bad'],
    ['relink', '--chain-id', 'work', '--tombstone-id', 'bad'], ['status', '--', 'ignored'],
    ['doctor', '--session', A], ['launch', '--session', A], ['launch', '--chain-id', 'work'],
    ['status', '--session', 'AAAAAAAA-0000-4000-8000-000000000001'],
    ...[['resume'], ['-c', 'model="fixture"', 'resume', '--help'], ['--profile', 'fixture', 'fork'], ['--model=fixture', 'exec']]
      .map(child => ['launch', '--chain-id', 'work', '--source-session-id', A, '--', ...child])
  ]) await assert.rejects(runChainingCli(args, { env }), { code: 'INVALID_ARGUMENT' });
  assert.equal(existsSync(home), false);
  assert.deepEqual(await runChainingCli(['status'], { env }), { status: 'unbound', binding: null, tombstone: null });
  assert.equal(existsSync(home), false);
});

test('chain CLI uses exact caller identity and compare values for unlink and relink', async t => {
  const root = temporary(t), calls = [];
  class Chain {
    constructor(path) { assert.equal(path, root); }
    async bind(...args) { calls.push(['bind', ...args]); return { status: 'bound_no_notes' }; }
    async unlink(...args) { calls.push(['unlink', ...args]); return { status: 'unlinked' }; }
    async relink(...args) { calls.push(['relink', ...args]); return { status: 'bound' }; }
  }
  const options = { env: { CROSS_SESSION_HOME: root, CODEX_THREAD_ID: A }, Chain };
  await runChainingCli(['link', '--chain-id', 'work', '--source-session-id', B], options);
  await runChainingCli(['unlink', '--expected-chain-id', 'work', '--expected-checkpoint-id', 'none'], options);
  await runChainingCli(['relink', '--session', B, '--chain-id', 'work', '--tombstone-id', C, '--detail'], options);
  assert.deepEqual(calls, [
    ['bind', A, { chain_id: 'work', source_session_id: B }],
    ['unlink', A, { expected_chain_id: 'work', expected_checkpoint_id: null }],
    ['relink', B, { chain_id: 'work', tombstone_id: C }]
  ]);
});

test('launch fails before storage access for every process mode', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const env = { CROSS_SESSION_HOME: home, CODEX_THREAD_ID: A, CROSS_SESSION_CHAIN_TICKET: 'private-fixture' };
  class Chain { constructor() { assert.fail('Unsupported launch must not access storage'); } }
  for (const extra of [[], ['--codex-js', join(root, 'codex.js')], ['--', '--no-daemon'], ['--', '-c', 'model="fixture"']]) {
    await assert.rejects(runChainingCli(['launch', '--chain-id', 'work', '--source-session-id', A, ...extra], { env, Chain }), error => {
      assert.equal(error.code, 'CHAINING_LAUNCH_UNSUPPORTED');
      assert.equal(error.message.includes('private-fixture'), false);
      return true;
    });
  }
  assert.equal(existsSync(home), false);
  assert.equal(env.CROSS_SESSION_CHAIN_TICKET, 'private-fixture');
  assert.deepEqual(readdirSync(root), []);
});

test('diagnosis combines host trust and storage use without creating missing state', async t => {
  const root = temporary(t), home = join(root, 'missing');
  const result = await runChainingCli(['doctor', '--cwd', root], {
    env: { CROSS_SESSION_HOME: home }, diagnose: async ({ cwd }) => { assert.equal(cwd, root); return { status: 'needs_attention' }; }
  });
  assert.deepEqual(result, { hooks: { status: 'needs_attention' }, storage: { status: 'empty' } });
  assert.equal(existsSync(home), false);
});

test('MCP chain tools use call metadata and reject caller identity arguments', async () => {
  const params = { name: 'link_chain', arguments: { chain_id: 'work', source_session_id: B }, _meta: { sessionId: A } };
  const result = await handleMcp({ method: 'tools/call', params }, { async call(name, args, owner) {
    assert.equal(owner, A); assert.equal(name, 'link_chain'); assert.equal(args.source_session_id, B);
    return { status: 'bound', binding: { chain_id: 'work', latest_checkpoint_id: null, pinned_checkpoint_id: C } };
  } });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /not user approval/);
  for (const name of ['link_chain', 'get_chain', 'unlink_chain', 'relink_chain']) {
    const bad = await handleMcp({ method: 'tools/call', params: { name, arguments: { session_id: B } } }, { call() { assert.fail('Unexpected broker access'); } });
    assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 'INVALID_ARGUMENT');
  }
});

test('actual CLI displays chain help and reports absent bindings without a broker', async t => {
  const root = temporary(t), env = { ...process.env, CROSS_SESSION_HOME: join(root, 'missing'), CODEX_THREAD_ID: A };
  const help = await run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', '--help'], { env, windowsHide: true });
  assert.match(help.stdout, /chain launch/);
  const status = await run(process.execPath, ['plugins/cross-session/src/cli.mjs', 'chain', 'status'], { env, windowsHide: true });
  assert.equal(JSON.parse(status.stdout).status, 'unbound');
  assert.equal(existsSync(env.CROSS_SESSION_HOME), false);
});
