import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';
import { isolatedEnvironment } from '../scripts/evaluate-coordination.mjs';

const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function waitFor(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error('The isolated project guidance host timed out.');
}
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timer);
}

test('real Codex puts project guidance in developer context after startup, compact, and resume', {
  skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 120000
}, async t => {
  const base = process.platform === 'win32' ? dirname(tmpdir()) : tmpdir();
  const root = await realpath(await mkdtemp(join(base, 'project-guidance-host-')));
  const children = [];
  let server;
  t.after(async () => {
    for (const child of children) await stopChild(child);
    if (server) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
    const actual = await realpath(root), parent = await realpath(base);
    assert.equal(actual, join(parent, basename(root)));
    assert.match(basename(actual), /^project-guidance-host-[a-zA-Z0-9]+$/);
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const home = join(root, 'codex-home'), project = join(root, 'project'), state = join(root, 'state');
  await Promise.all([mkdir(home), mkdir(project), mkdir(state)]);
  const agents = join(project, 'AGENTS.md');
  const bodyMarkers = {
    startup: 'PROJECT_GUIDANCE_STARTUP_MARKER_83',
    compact: 'PROJECT_GUIDANCE_COMPACT_MARKER_83',
    resume: 'PROJECT_GUIDANCE_RESUME_MARKER_83'
  };
  await writeFile(agents, `${bodyMarkers.startup}: follow the isolated startup rule.\n`);
  const git = spawn('git', ['-C', project, 'init', '--quiet'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolveExit, rejectExit) => {
    git.once('error', rejectExit);
    git.once('close', code => code === 0 ? resolveExit() : rejectExit(new Error(`git init exited ${code}`)));
  });

  const requests = [];
  let regular = 0;
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const serialized = JSON.stringify(request.input);
    const compact = req.url.endsWith('/compact') || /CONTEXT CHECKPOINT COMPACTION|concise (?:context|checkpoint) summary|summariz.*conversation/i.test(serialized);
    requests.push({ request, compact });
    const id = `guidance-${requests.length}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id } });
    if (compact) {
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text: 'Continue the isolated test after compaction.' }] } });
    } else if (++regular === 1) {
      await writeFile(agents, `${bodyMarkers.compact}: follow the isolated compact rule.\n`);
      event({ type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: `call-${id}`, arguments: JSON.stringify({ cmd: 'echo guidance-fixture', max_output_tokens: 40 }) } });
    } else {
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${id}`, content: [{ type: 'output_text', text: 'PROJECT_GUIDANCE_TEST_COMPLETE' }] } });
    }
    const tokens = !compact && regular === 1 ? 20000 : 0;
    event({ type: 'response.completed', response: { id, usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens, input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));

  const log = join(root, 'hook-events.jsonl'), wrapper = join(home, 'project-guidance-wrapper.mjs');
  const hookSource = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  await writeFile(wrapper, `import { appendFile } from 'node:fs/promises';
import { runHook, writeHookOutput } from ${JSON.stringify(hookSource)};
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const dependencies = {
  readTranscript: () => ({ sessionId: input.session_id }),
  chaining: { restore: async () => ({ status: 'empty', relationship: { receiving_session_id: input.session_id } }) }
};
const output = await runHook(input, { hook: async () => ({}) }, process.env, dependencies);
await appendFile(${JSON.stringify(log)}, JSON.stringify({ event: input.hook_event_name, source: input.source, output }) + '\\n');
await writeHookOutput(output);
`);
  const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath.replaceAll('\\', '/')}" "${wrapper.replaceAll('\\', '/')}"`;
  await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
  } }));

  const config = `model_provider = "local_mock"
model = "fake-model"
model_auto_compact_token_limit = 10000
[model_providers.local_mock]
name = "Local project guidance test"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`;
  await writeFile(join(home, 'config.toml'), config);
  const bin = resolveCodex();
  const env = { ...isolatedEnvironment(process.env, home), CROSS_SESSION_HOME: state };
  if (process.platform === 'win32') env.USERPROFILE = process.env.USERPROFILE;

  async function launch() {
    const child = spawn(bin.command, [...bin.args, 'app-server'], { cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let sequence = 0, raw = '';
    const pending = new Map(), notifications = [];
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const rejectPending = () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The isolated project guidance host closed.')); }
      pending.clear();
    };
    child.once('error', rejectPending);
    child.once('close', rejectPending);
    child.stdout.on('data', chunk => {
      raw += chunk;
      const lines = raw.split('\n'); raw = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id !== undefined) {
          const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item?.timer);
          if (value.error) item?.reject(new Error(value.error.message)); else item?.resolve(value.result);
        } else notifications.push(value);
      }
    });
    const rpc = (method, params) => new Promise((resolveRpc, rejectRpc) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); rejectRpc(new Error(`Fixture RPC timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    await rpc('initialize', { clientInfo: { name: 'project-guidance-test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return { child, rpc, notifications };
  }

  let host = await launch();
  const definitions = (await host.rpc('hooks/list', { cwds: [project] })).data.flatMap(value => value.hooks);
  assert.equal(definitions.length, 2);
  await stopChild(host.child);
  await writeFile(join(home, 'config.toml'), config + definitions.map(hook => `[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join(''));
  host = await launch();
  assert.ok((await host.rpc('hooks/list', { cwds: [project] })).data.flatMap(value => value.hooks).every(hook => hook.trustStatus === 'trusted'));

  let thread = (await host.rpc('thread/start', { cwd: project, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' })).thread;
  async function turn(prompt) {
    const before = host.notifications.length;
    await host.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
    await waitFor(() => host.notifications.slice(before).some(value => value.method === 'turn/completed'));
  }
  await turn('Run the isolated project guidance test.');
  const compactIndex = requests.findIndex(value => value.compact);
  assert.ok(compactIndex >= 0, 'The fixture must compact.');
  const hasHookDeveloperContext = (value, marker) => value?.request?.input?.some(message =>
    message?.role === 'developer' && JSON.stringify(message).includes('<cross-session-project-guidance>') && JSON.stringify(message).includes(marker));
  const startupRequest = requests.find(value => !value.compact);
  const compactRequest = requests.slice(compactIndex + 1).find(value => !value.compact);
  assert.ok(hasHookDeveloperContext(startupRequest, bodyMarkers.startup), 'The first startup model request must contain current hook project guidance.');
  assert.ok(hasHookDeveloperContext(compactRequest, bodyMarkers.compact), 'The first model request after compact must contain current hook project guidance.');

  await writeFile(agents, `${bodyMarkers.resume}: follow the isolated resume rule.\n`);
  await stopChild(host.child);
  host = await launch();
  thread = (await host.rpc('thread/resume', { threadId: thread.id })).thread;
  const resumeIndex = requests.length;
  await turn('Run one turn after resume.');
  const resumeRequest = requests.slice(resumeIndex).find(value => !value.compact);
  assert.ok(hasHookDeveloperContext(resumeRequest, bodyMarkers.resume), 'The first model request after resume must contain current hook project guidance.');

  const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const source of ['startup', 'compact', 'resume']) {
    const record = records.find(value => value.event === 'SessionStart' && value.source === source);
    assert.ok(record, `SessionStart ${source} must run.`);
    assert.match(record.output.hookSpecificOutput.additionalContext, /<cross-session-project-guidance>/);
    assert.match(record.output.hookSpecificOutput.additionalContext, new RegExp(bodyMarkers[source]));
  }
  const ordinary = records.filter(value => value.event === 'UserPromptSubmit');
  assert.ok(ordinary.length >= 2);
  assert.ok(ordinary.every(value => Object.values(bodyMarkers).every(marker => !JSON.stringify(value.output).includes(marker))));
});
