import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';
import { isolatedEnvironment } from '../scripts/evaluate-coordination.mjs';

test('real Codex Stop uses the product hook and permits one continuation', { skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 60000 }, async t => {
  const children = [];
  let server;
  // Codex cannot create its command helpers under the Windows OS temp directory.
  const base = process.platform === 'win32' ? dirname(tmpdir()) : tmpdir();
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(join(base, 'stop-host-')));
  t.after(async () => {
    for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolveExit => child.once('exit', resolveExit));
    }
    if (server) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
    const actual = await realpath(root), actualBase = await realpath(base), within = relative(actualBase, actual);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Cleanup must stay inside the test directory');
    assert.equal(actual, join(actualBase, basename(root)), 'Cleanup must target the exact created directory');
    assert.match(basename(actual), /^stop-host-[a-zA-Z0-9]+$/);
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let requests = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const id = `response-${requests.length}`;
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event({ type: 'response.created', response: { id } });
    event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'fixture stage complete' }] } });
    event({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const hookSource = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  const config = { model_provider: 'local_mock', model: 'fake-model',
    'model_providers.local_mock.name': 'Local hook test only',
    'model_providers.local_mock.base_url': `http://127.0.0.1:${server.address().port}/v1`,
    'model_providers.local_mock.wire_api': 'responses',
    'model_providers.local_mock.requires_openai_auth': false,
    'model_providers.local_mock.supports_websockets': false };
  const bin = resolveCodex();
  for (const enabled of [false, true]) {
    requests = [];
    const home = join(root, enabled ? 'treatment' : 'baseline');
    const cwd = join(home, 'work');
    await mkdir(cwd, { recursive: true });
    const log = join(home, 'events.jsonl');
    const fixture = join(home, 'fixture.mjs');
    await writeFile(fixture, `import { appendFile } from 'node:fs/promises';
import { runHook } from ${JSON.stringify(hookSource)};
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
await appendFile(${JSON.stringify(log)}, JSON.stringify({ event: input.hook_event_name, turnId: input.turn_id, active: input.stop_hook_active }) + String.fromCharCode(10));
const client = { hook: async () => ({ stopPolicy: { version: 1, decision: 'continue_work', reasonCode: 'WORK_REMAINING', generation: '00000000-0000-4000-8000-000000000001', turnId: input.turn_id } }) };
console.log(JSON.stringify(await runHook(input, client)));
`);
    // PowerShell requires & before a quoted executable path.
    const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath.replaceAll('\\', '/')}" "${fixture.replaceAll('\\', '/')}"`;
    const hooks = Object.fromEntries(['UserPromptSubmit', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]]));
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks }));
    const child = spawn(bin.command, [...bin.args, 'exec', '--json', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--dangerously-bypass-hook-trust', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), '-'], {
      // Keep Windows profile discovery available for host hook execution.
      // CODEX_HOME remains isolated. No authentication file is copied.
      cwd, env: { ...isolatedEnvironment(process.env, home), ...(process.platform === 'win32' ? { USERPROFILE: process.env.USERPROFILE } : {}), CROSS_SESSION_CONTINUATION: enabled ? '1' : '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    children.push(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end('Complete only the approved synthetic fixture. Respect user stops.');
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const code = await new Promise((resolveExit, reject) => { child.once('close', resolveExit); child.once('error', reject); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, 'The isolated Codex invocation must complete');
    let events;
    try { events = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch { assert.fail('The host did not run the vetted fixture hook'); }
    assert.equal(events.filter(event => event.event === 'UserPromptSubmit').length, 1, 'Synthetic continuation must not re-arm UserPromptSubmit');
    const stops = events.filter(event => event.event === 'Stop');
    assert.equal(stops.length, enabled ? 2 : 1);
    assert.equal(stops[0].active, false);
    assert.equal(typeof stops[0].turnId, 'string');
    if (enabled) {
      assert.equal(stops[1].active, true);
      assert.equal(stops[1].turnId, stops[0].turnId);
    }
    assert.equal(requests.length, enabled ? 2 : 1);
    const hasContinuation = requests.some(request => JSON.stringify(request.input).includes('Continue only remaining work within the existing user request and permissions.'));
    assert.equal(hasContinuation, enabled);
  }
});
