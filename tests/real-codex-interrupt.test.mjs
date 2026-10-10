import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, realpath, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';
import { isolatedEnvironment } from '../scripts/evaluate-coordination.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(20); }
  throw new Error('The isolated host condition timed out');
}
async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
  await closed;
  clearTimeout(timer);
}

test('real Codex Interrupt cancels a pending Stop continuation', { skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 90000 }, async t => {
  const base = process.platform === 'win32' ? dirname(tmpdir()) : tmpdir();
  const root = await realpath(await mkdtemp(join(base, 'interrupt-host-')));
  const children = [];
  let server;
  t.after(async () => {
    for (const child of children) await stopChild(child);
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    const actual = await realpath(root), actualBase = await realpath(base);
    assert.equal(actual, join(actualBase, basename(root)), 'Cleanup must target the exact created directory');
    assert.match(basename(actual), /^interrupt-host-[a-zA-Z0-9]+$/);
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let requests = 0;
  server = createServer(async (req, res) => {
    for await (const chunk of req) { /* The fixture does not use model input for its score. */ }
    const id = `response-${++requests}`;
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event({ type: 'response.created', response: { id } });
    event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'fixture stage complete' }] } });
    event({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { model_provider: 'local_mock', model: 'fake-model',
    'model_providers.local_mock.name': 'Local interrupt test only',
    'model_providers.local_mock.base_url': `http://127.0.0.1:${server.address().port}/v1`,
    'model_providers.local_mock.wire_api': 'responses',
    'model_providers.local_mock.requires_openai_auth': false,
    'model_providers.local_mock.supports_websockets': false };
  const bin = resolveCodex();
  for (const interrupted of [false, true]) {
    requests = 0;
    const home = join(root, interrupted ? 'interrupted' : 'baseline'), cwd = join(home, 'work');
    await mkdir(cwd, { recursive: true });
    const log = join(home, 'events.jsonl'), marker = join(home, 'stop-entered'), release = join(home, 'release');
    const fixture = join(home, 'fixture.cjs');
    await writeFile(fixture, `const fs = require('node:fs');
let raw = ''; process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', async () => {
 const input = JSON.parse(raw);
 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: input.hook_event_name, turnId: input.turn_id, active: input.stop_hook_active }) + String.fromCharCode(10));
 if (input.hook_event_name === 'Stop' && input.stop_hook_active === false) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'entered');
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  console.log(JSON.stringify({ decision: 'block', reason: 'Continue only the existing approved fixture once. Respect user stops.' }));
 } else console.log('{}');
});
`);
    const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath.replaceAll('\\', '/')}" "${fixture.replaceAll('\\', '/')}"`;
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(['UserPromptSubmit', 'Stop', 'Interrupt'].map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]])) }));
    await writeFile(join(home, 'config.toml'), '');
    const env = { ...isolatedEnvironment(process.env, home), ...(process.platform === 'win32' ? { USERPROFILE: process.env.USERPROFILE } : {}) };
    async function launch() {
      const child = spawn(bin.command, [...bin.args, 'app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let seq = 0, raw = '';
      const pending = new Map(), notifications = [];
      child.stdout.setEncoding('utf8');
      const rejectPending = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('The isolated app-server closed')); } pending.clear(); };
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.once('error', rejectPending);
      child.once('close', rejectPending);
      child.stdout.on('data', chunk => {
        raw += chunk;
        const lines = raw.split('\n'); raw = lines.pop();
        for (const line of lines) {
          let value;
          try { value = JSON.parse(line); } catch { rejectPending(); continue; }
          if (value.id !== undefined) {
            const entry = pending.get(value.id); pending.delete(value.id); clearTimeout(entry?.timer);
            if (value.error) entry?.reject(new Error('The isolated app-server rejected the fixture request'));
            else entry?.resolve(value.result);
          } else notifications.push(value);
        }
      });
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The isolated fixture RPC timed out')); }, 6000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
      await rpc('initialize', { clientInfo: { name: 'isolated_interrupt_test', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      return { child, rpc, notifications };
    }
    let host = await launch();
    const hooks = (await host.rpc('hooks/list', { cwds: [cwd] })).data.flatMap(entry => entry.hooks);
    assert.equal(hooks.length, 3, 'Only the three vetted fixture hooks can be trusted');
    for (const hook of hooks) {
      assert.equal(hook.command, command);
      assert.equal(hook.source, 'user');
      assert.equal(hook.sourcePath, join(home, 'hooks.json'));
      assert.equal(typeof hook.currentHash, 'string');
      assert.ok(hook.currentHash.length > 0);
    }
    await stopChild(host.child);
    // Trust belongs only to this temporary home and these exact fixture hashes.
    await writeFile(join(home, 'config.toml'), hooks.map(hook => `[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join('\n'));
    host = await launch();
    const trusted = (await host.rpc('hooks/list', { cwds: [cwd] })).data.flatMap(entry => entry.hooks);
    assert.equal(trusted.length, 3);
    assert.ok(trusted.every(hook => hook.trustStatus === 'trusted'));
    const thread = (await host.rpc('thread/start', { cwd, model: 'fake-model', approvalPolicy: 'never', sandbox: 'read-only' })).thread;
    const turn = (await host.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Complete only the approved isolated fixture.' }] })).turn;
    await waitFor(async () => { try { await access(marker); return true; } catch { return false; } });
    if (interrupted) {
      const interruption = host.rpc('turn/interrupt', { threadId: thread.id, turnId: turn.id });
      await pause(100);
      await writeFile(release, 'release after interrupt');
      await interruption;
    } else await writeFile(release, 'release baseline');
    await waitFor(() => host.notifications.some(entry => entry.method === 'turn/completed'));
    await pause(500);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    const completed = host.notifications.find(entry => entry.method === 'turn/completed');
    assert.equal(completed.params.turn.status, interrupted ? 'interrupted' : 'completed');
    assert.equal(requests, interrupted ? 1 : 2, 'An Interrupt must prevent a late Stop block from starting another request');
    assert.equal(events.some(entry => entry.event === 'Interrupt'), interrupted);
    assert.equal(events.some(entry => entry.event === 'Stop' && entry.active === true), !interrupted);
    await stopChild(host.child);
  }
});
