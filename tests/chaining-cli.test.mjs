import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
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

test('launch starts one child with an environment-only ticket and an absolute JS entry', async t => {
  const root = temporary(t), script = join(root, 'codex entry.js');
  writeFileSync(script, '');
  const env = { CROSS_SESSION_HOME: root, CODEX_THREAD_ID: A, CROSS_SESSION_CHAIN_TICKET: 'old-ticket' };
  let spawns = 0, tickets = 0;
  class Chain {
    async createTicket(args) {
      tickets++;
      assert.deepEqual(args, { chain_id: 'work', source_session_id: A });
      return { ticket: 'secret-ticket', chain_id: 'work', source_session_id: A, pinned_checkpoint_id: C };
    }
  }
  const result = await runChainingCli(['launch', '--chain-id', 'work', '--source-session-id', A, '--codex-js', script, '--cwd', root, '--', '--model', 'fixture'], {
    env, Chain, spawnImpl(command, args, options) {
      spawns++;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [script, '--model', 'fixture']);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.cwd, root);
      assert.equal(options.env.CROSS_SESSION_CHAIN_TICKET, 'secret-ticket');
      assert.equal(options.env.CODEX_THREAD_ID, undefined);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 7, null));
      return child;
    }
  });
  assert.equal(spawns, 1); assert.equal(tickets, 1);
  assert.equal(result.exit_code, 7);
  assert.equal(JSON.stringify(result).includes('secret-ticket'), false);
  assert.equal(env.CODEX_THREAD_ID, A);
  assert.equal(env.CROSS_SESSION_CHAIN_TICKET, 'old-ticket');
  assert.deepEqual(readdirSync(root), ['codex entry.js']);
});

test('launch does not retry a failed process and does not print the ticket', async t => {
  const root = temporary(t), script = join(root, 'codex.js'); writeFileSync(script, '');
  let attempts = 0;
  class Chain { async createTicket() { return { ticket: 'secret-ticket' }; } }
  await assert.rejects(runChainingCli(['launch', '--chain-id', 'work', '--source-session-id', A, '--codex-js', script], {
    env: { CROSS_SESSION_HOME: root }, Chain, spawnImpl() { attempts++; throw new Error('private error secret-ticket'); }
  }), error => error.code === 'CHAINING_LAUNCH_FAILED' && !error.message.includes('secret-ticket'));
  assert.equal(attempts, 1);
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
