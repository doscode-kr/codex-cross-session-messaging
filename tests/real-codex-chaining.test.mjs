import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';
import { Chaining } from '../plugins/cross-session/src/chaining.mjs';
import { WorkState } from '../plugins/cross-session/src/work-state.mjs';
import { isolatedEnvironment } from '../scripts/evaluate-coordination.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  throw Error('The isolated chaining host condition timed out.');
}
async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed; clearTimeout(timer);
}

test('real Codex trust and automatic compaction preserve a verified handoff', { skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 120000 }, async t => {
  const base = process.platform === 'win32' ? dirname(tmpdir()) : tmpdir();
  const root = await realpath(await mkdtemp(join(base, 'chaining-host-'))), children = [];
  let server;
  t.after(async () => {
    for (const child of children) await stopChild(child);
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    const actual = await realpath(root), parent = await realpath(base);
    assert.equal(actual, join(parent, basename(root)));
    assert.match(basename(actual), /^chaining-host-[a-zA-Z0-9]+$/);
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const marker = 'CHAINING_HOST_MARKER_71';
  let requests = [], regular = 0, compactions = 0;
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), serialized = JSON.stringify(request.input);
    const compact = req.url.endsWith('/compact') || /CONTEXT CHECKPOINT COMPACTION|concise (?:context|checkpoint) summary|summariz.*conversation/i.test(serialized);
    requests.push({ request, compact });
    const id = `response-${requests.length}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id } });
    if (compact) {
      compactions++;
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'The fixture is in progress. No handoff marker is in this summary.' }] } });
    } else if (++regular === 1) {
      const name = request.tools?.some(tool => tool.name === 'update_plan') ? 'update_plan' : 'exec_command';
      const args = name === 'update_plan' ? { plan: [{ step: 'Complete the isolated fixture', status: 'in_progress' }] } : { cmd: 'echo chaining-fixture', max_output_tokens: 50 };
      event({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: `call-${id}`, arguments: JSON.stringify(args) } });
    } else {
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: serialized.includes(marker) ? marker : 'NO_HANDOFF_MARKER' }] } });
    }
    const tokens = !compact && regular === 1 ? 20000 : 0;
    event({ type: 'response.completed', response: { id, usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens, input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { model_provider: 'local_mock', model: 'fake-model', model_auto_compact_token_limit: 10000,
    'model_providers.local_mock.name': 'Local chaining test only',
    'model_providers.local_mock.base_url': `http://127.0.0.1:${server.address().port}/v1`,
    'model_providers.local_mock.wire_api': 'responses', 'model_providers.local_mock.requires_openai_auth': false,
    'model_providers.local_mock.supports_websockets': false };
  const bin = resolveCodex(), source = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  for (const trusted of [false, true]) {
    requests = []; regular = 0; compactions = 0;
    const home = join(root, trusted ? 'trusted' : 'untrusted'), cwd = join(home, 'work'), state = join(home, 'cross-session');
    await mkdir(cwd, { recursive: true }); await mkdir(state);
    const log = join(home, 'hooks.jsonl'), fixture = join(home, 'fixture.mjs');
    await writeFile(fixture, `import { appendFile } from 'node:fs/promises';
import { runHook, writeHookOutput } from ${JSON.stringify(source)};
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw), started = Date.now();
const output = await runHook(input, { hook: async () => ({}) });
await appendFile(${JSON.stringify(log)}, JSON.stringify({ event: input.hook_event_name, source: input.source, session: input.session_id, elapsed: Date.now()-started, output }) + '\\n');
await writeHookOutput(output);
`);
    const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath.replaceAll('\\', '/')}" "${fixture.replaceAll('\\', '/')}"`;
    const events = ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd'];
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: event === 'SessionStart' ? 10 : 3 }] }]])) }));
    await writeFile(join(home, 'config.toml'), '');
    const env = { ...isolatedEnvironment(process.env, home), ...(process.platform === 'win32' ? { USERPROFILE: process.env.USERPROFILE } : {}), CROSS_SESSION_HOME: state };
    async function launch() {
      const child = spawn(bin.command, [...bin.args, 'app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let seq = 0, raw = '';
      const pending = new Map(), notifications = [];
      child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
      const rejectPending = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(Error('The isolated chaining host closed.')); } pending.clear(); };
      child.once('error', rejectPending); child.once('close', rejectPending);
      child.stdout.on('data', chunk => {
        raw += chunk; const lines = raw.split('\n'); raw = lines.pop();
        for (const line of lines) {
          let value; try { value = JSON.parse(line); } catch { continue; }
          if (value.id !== undefined) {
            const entry = pending.get(value.id); pending.delete(value.id); clearTimeout(entry?.timer);
            if (value.error) entry?.reject(Error(`Fixture RPC rejected: ${value.error.message}`)); else entry?.resolve(value.result);
          } else notifications.push(value);
        }
      });
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`Fixture RPC timed out: ${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
      await rpc('initialize', { clientInfo: { name: 'isolated_chaining_test', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      return { child, rpc, notifications };
    }
    let host = await launch();
    const definitions = (await host.rpc('hooks/list', { cwds: [cwd] })).data.flatMap(value => value.hooks);
    assert.equal(definitions.length, events.length);
    assert.ok(definitions.every(hook => hook.command === command && hook.sourcePath === join(home, 'hooks.json') && hook.trustStatus !== 'trusted'));
    if (trusted) {
      await stopChild(host.child);
      await writeFile(join(home, 'config.toml'), definitions.map(hook => `[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join('\n'));
      host = await launch();
      assert.ok((await host.rpc('hooks/list', { cwds: [cwd] })).data.flatMap(value => value.hooks).every(hook => hook.trustStatus === 'trusted'));
    }
    const thread = (await host.rpc('thread/start', { cwd, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' })).thread;
    const chain = new Chaining(state);
    await chain.bind(thread.id, { chain_id: 'fixture' });
    new WorkState(state).set(thread.id, { action: 'start', expected_revision: 0, objective: marker, scope: 'Isolated host fixture', completion_criteria: 'Read the marker after compact', next_action: 'Report the fixture marker', checklist: [{ title: 'Complete the fixture', expected_result: 'The marker is restored', verification_method: 'Read model input' }] });
    await chain.checkpoint(thread.id, { event: 'Stop', automatic: { messages: [], git: null } });
    await host.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Complete the isolated fixture. Use one tool, then report the handoff marker if one is present.' }] });
    await waitFor(() => host.notifications.some(value => value.method === 'turn/completed'), 30000);
    const completed = host.notifications.find(value => value.method === 'turn/completed');
    assert.equal(completed.params.turn.status, 'completed');
    await host.rpc('thread/archive', { threadId: thread.id });
    await pause(300);
    let records = []; try { records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(compactions > 0, 'The real host must compact during the fixture turn.');
    const final = requests.filter(value => !value.compact).at(-1);
    assert.equal(JSON.stringify(final.request.input).includes('Cross-session chaining hook attached.'), trusted);
    assert.equal(JSON.stringify(final.request.input).includes(marker), trusted);
    if (trusted) {
      assert.ok(records.some(value => value.event === 'SessionStart' && value.source === 'compact'));
      assert.ok(records.some(value => value.event === 'SessionStart' && value.output.hookSpecificOutput?.additionalContext.includes('"status":"restored"')));
      const paths = await readdir(join(state, 'chaining-v1', 'checkpoints'));
      const checkpoints = await Promise.all(paths.map(path => readFile(join(state, 'chaining-v1', 'checkpoints', path), 'utf8').then(JSON.parse)));
      for (const event of ['Stop', 'PreCompact', 'SessionEnd']) assert.ok(checkpoints.some(value => value.event === event), `${event} must save a checkpoint`);
      assert.ok(records.find(value => value.event === 'SessionEnd').elapsed < 3000);
    } else assert.equal(records.length, 0, 'Untrusted hooks must not run or inject context.');
    t.diagnostic(`${trusted ? 'trusted' : 'untrusted'}: ${regular} model requests, ${compactions} compactions, ${records.length} hooks`);
    await stopChild(host.child);
  }
});
