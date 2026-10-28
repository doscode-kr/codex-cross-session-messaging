import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';
import { WorkState } from '../plugins/cross-session/src/work-state.mjs';
import { isolatedEnvironment } from '../scripts/evaluate-coordination.mjs';

const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function waitFor(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error('The isolated session continuity host timed out.');
}
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timer);
}
async function initGit(cwd) {
  const child = spawn('git', ['-C', cwd, 'init', '--quiet'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', code => code === 0 ? resolveExit() : rejectExit(new Error(`git init exited ${code}`)));
  });
}
function requestMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('\n');
}
function continuityData(message) {
  const text = requestMessageText(message);
  const match = text.match(/<cross-session-continuity>\n([\s\S]+)\n<\/cross-session-continuity>/u);
  assert.ok(match, 'Continuity developer context must contain one structured payload.');
  return JSON.parse(match[1]);
}

test('real Codex compaction restores only each session own request and reported work', {
  skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 180000
}, async t => {
  const base = process.platform === 'win32' ? dirname(tmpdir()) : tmpdir();
  const root = await realpath(await mkdtemp(join(base, 'continuity-host-')));
  const children = [];
  let server;
  t.after(async () => {
    for (const child of children) await stopChild(child);
    if (server) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
    const actual = await realpath(root), parent = await realpath(base);
    assert.equal(actual, join(parent, basename(root)));
    assert.match(basename(actual), /^continuity-host-[a-zA-Z0-9]+$/);
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const home = join(root, 'codex-home'), state = join(root, 'state');
  const sharedProject = join(root, 'shared-project'), otherProject = join(root, 'other-project');
  await Promise.all([mkdir(home), mkdir(state), mkdir(sharedProject), mkdir(otherProject)]);
  await Promise.all([initGit(sharedProject), initGit(otherProject)]);
  const agents = {
    sharedProject: join(sharedProject, 'AGENTS.md'),
    otherProject: join(otherProject, 'AGENTS.md')
  };
  const guidance = {
    sharedStartup: 'AGENTS_SHARED_STARTUP_91', sharedCompact: 'AGENTS_SHARED_COMPACT_91',
    otherStartup: 'AGENTS_OTHER_STARTUP_91', otherCompact: 'AGENTS_OTHER_COMPACT_91'
  };
  await Promise.all([
    writeFile(agents.sharedProject, `${guidance.sharedStartup}: initial shared project rule.\n`),
    writeFile(agents.otherProject, `${guidance.otherStartup}: initial other project rule.\n`)
  ]);

  const fixtures = {
    A: { project: sharedProject, original: 'OWN_REQUEST_A_91', completed: 'REPORTED_COMPLETE_A_91', remaining: 'REMAINING_A_91' },
    B: { project: sharedProject, original: 'OWN_REQUEST_B_91', completed: 'REPORTED_COMPLETE_B_91', remaining: 'REMAINING_B_91' },
    C: { project: otherProject, original: 'OWN_REQUEST_C_91', completed: 'REPORTED_COMPLETE_C_91', remaining: 'REMAINING_C_91' }
  };
  const requests = [], regular = new Map(), compactCounts = new Map();
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), serialized = JSON.stringify(request.input);
    const key = Object.keys(fixtures).find(name => serialized.includes(fixtures[name].original));
    const compact = req.url.endsWith('/compact') || /CONTEXT CHECKPOINT COMPACTION|concise (?:context|checkpoint) summary|summariz.*conversation/i.test(serialized);
    requests.push({ key, compact, request });
    const id = `continuity-${requests.length}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id } });
    if (compact) {
      if (key) compactCounts.set(key, (compactCounts.get(key) ?? 0) + 1);
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${id}`,
        content: [{ type: 'output_text', text: 'Continue after compaction. The summary intentionally omits all fixture markers.' }] } });
    } else {
      const count = (regular.get(key) ?? 0) + 1;
      regular.set(key, count);
      if (count === 1) {
        if (key === 'A') await writeFile(agents.sharedProject, `${guidance.sharedCompact}: updated shared project rule.\n`);
        if (key === 'C') await writeFile(agents.otherProject, `${guidance.otherCompact}: updated other project rule.\n`);
        event({ type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: `call-${id}`,
          arguments: JSON.stringify({ cmd: `echo continuity-${key}`, max_output_tokens: 40 }) } });
      } else {
        event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${id}`,
          content: [{ type: 'output_text', text: `SESSION_${key}_COMPLETE` }] } });
      }
    }
    const tokens = !compact && regular.get(key) === 1 ? 20000 : 0;
    event({ type: 'response.completed', response: { id, usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens,
      input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));

  const log = join(root, 'hook-events.jsonl'), wrapper = join(home, 'continuity-wrapper.mjs');
const hookSource = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  await writeFile(wrapper, `import { appendFile } from 'node:fs/promises';
import { runHook, writeHookOutput } from ${JSON.stringify(hookSource)};
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw), started = Date.now();
await appendFile(${JSON.stringify(log)}, JSON.stringify({ phase: 'started', event: input.hook_event_name, source: input.source, session: input.session_id }) + '\\n');
const output = await runHook(input, { hook: async () => ({}) });
await appendFile(${JSON.stringify(log)}, JSON.stringify({ phase: 'completed', event: input.hook_event_name, source: input.source, session: input.session_id, elapsed: Date.now()-started, output }) + '\\n');
await writeHookOutput(output);
`);
  const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath.replaceAll('\\', '/')}" "${wrapper.replaceAll('\\', '/')}"`;
  const events = ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd'];
  await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event =>
    [event, [{ hooks: [{ type: 'command', command, timeout: event === 'SessionStart' ? 10 : 5 }] }]])) }));
  const config = `model_provider = "local_mock"
model = "fake-model"
model_auto_compact_token_limit = 10000
[model_providers.local_mock]
name = "Local continuity test"
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
    const child = spawn(bin.command, [...bin.args, 'app-server'], { cwd: sharedProject, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let sequence = 0, raw = '';
    const pending = new Map(), notifications = [];
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const rejectPending = () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The isolated continuity host closed.')); }
      pending.clear();
    };
    child.once('error', rejectPending); child.once('close', rejectPending);
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
    await rpc('initialize', { clientInfo: { name: 'session-continuity-test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return { child, rpc, notifications };
  }

  let host = await launch();
  const definitions = (await host.rpc('hooks/list', { cwds: [sharedProject, otherProject] })).data.flatMap(value => value.hooks);
  assert.ok(definitions.length >= events.length);
  await stopChild(host.child);
  const uniqueDefinitions = [...new Map(definitions.map(hook => [hook.key, hook])).values()];
  await writeFile(join(home, 'config.toml'), config + uniqueDefinitions.map(hook =>
    `[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join(''));
  host = await launch();
  assert.ok((await host.rpc('hooks/list', { cwds: [sharedProject, otherProject] })).data.flatMap(value => value.hooks)
    .filter(hook => hook.command === command).every(hook => hook.trustStatus === 'trusted'));

  for (const [key, fixture] of Object.entries(fixtures)) {
    fixture.thread = (await host.rpc('thread/start', { cwd: fixture.project, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' })).thread;
    const work = new WorkState(state, { enabled: false });
    let report = work.set(fixture.thread.id, {
      action: 'start', expected_revision: 0, objective: `OBJECTIVE_${key}_91`, scope: `SCOPE_${key}_91`,
      completion_criteria: `CRITERIA_${key}_91`, next_action: fixture.remaining,
      checklist: [
        { title: fixture.completed, expected_result: `completed result ${key}`, verification_method: `completed evidence ${key}` },
        { title: fixture.remaining, expected_result: `remaining result ${key}`, verification_method: `remaining evidence ${key}` }
      ]
    });
    const completedId = report.state.checklist[0].item_id;
    report = work.set(fixture.thread.id, { action: 'attempt_start', expected_revision: report.revision, item_id: completedId });
    work.set(fixture.thread.id, { action: 'attempt_result', expected_revision: report.revision, item_id: completedId,
      attempt_number: 1, outcome: 'success', evidence: `reported evidence ${key}` });
  }

  for (const [key, fixture] of Object.entries(fixtures)) {
    const before = host.notifications.length;
    await host.rpc('turn/start', { threadId: fixture.thread.id, input: [{ type: 'text', text: `${fixture.original}: continue this session own task.` }] });
    await waitFor(() => host.notifications.slice(before).some(value => value.method === 'turn/completed'));
    assert.ok((compactCounts.get(key) ?? 0) > 0, `Session ${key} must compact.`);
    const compactIndex = requests.findIndex(value => value.key === key && value.compact);
    const final = requests.slice(compactIndex + 1).find(value => value.key === key && !value.compact);
    assert.ok(final, `Session ${key} must make a model request after compaction.`);
    const continuityMessage = final.request.input.find(message => message?.role === 'developer'
      && JSON.stringify(message).includes('<cross-session-continuity>'));
    assert.ok(continuityMessage, `Session ${key} must receive continuity developer context after compaction.`);
    const restored = continuityData(continuityMessage);
    assert.equal(restored.checkpoint.original_request.text, `${fixture.original}: continue this session own task.`);
    assert.equal(restored.checkpoint.original_request.provenance, 'observed_user_record');
    const continuityContext = JSON.stringify(continuityMessage);
    assert.match(continuityContext, new RegExp(fixture.original));
    assert.match(continuityContext, new RegExp(fixture.completed));
    assert.match(continuityContext, new RegExp(fixture.remaining));
    const currentGuidance = fixture.project === sharedProject ? guidance.sharedCompact : guidance.otherCompact;
    const guidanceMessage = final.request.input.find(message => message?.role === 'developer'
      && JSON.stringify(message).includes('<cross-session-project-guidance>'));
    assert.ok(guidanceMessage, `Session ${key} must receive project guidance developer context after compaction.`);
    assert.match(JSON.stringify(guidanceMessage), new RegExp(currentGuidance));
    for (const [otherKey, other] of Object.entries(fixtures)) {
      if (otherKey === key) continue;
      assert.equal(continuityContext.includes(other.original), false);
      assert.equal(continuityContext.includes(other.completed), false);
      assert.equal(continuityContext.includes(other.remaining), false);
    }
  }

  for (const fixture of Object.values(fixtures)) {
    await host.rpc('thread/archive', { threadId: fixture.thread.id });
    await waitFor(async () => {
      try {
        const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
        return records.some(value => value.phase === 'started' && value.event === 'SessionEnd' && value.session === fixture.thread.id);
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    await waitFor(async () => {
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      return records.some(value => value.phase === 'completed' && value.event === 'SessionEnd' && value.session === fixture.thread.id);
    });
  }
  const continuity = new SessionContinuity(state);
  for (const fixture of Object.values(fixtures)) {
    assert.equal((await continuity.status(fixture.thread.id, { project: fixture.project })).status, 'closed');
  }
  const stateFile = JSON.parse(await readFile(join(state, 'session-continuity-v1', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(stateFile.sessions).sort(), Object.values(fixtures).map(value => value.thread.id).sort());
  const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const fixture of Object.values(fixtures)) {
    assert.ok(records.some(value => value.phase === 'completed' && value.session === fixture.thread.id && value.event === 'SessionStart' && value.source === 'compact'
      && value.output.hookSpecificOutput?.additionalContext.includes('"status":"restored"')));
  }
  t.diagnostic(`A/B/C: ${requests.length} model requests, ${records.filter(value => value.phase === 'completed').length} completed hook records, ${compactCounts.size} compacted sessions`);
  await stopChild(host.child);
});
