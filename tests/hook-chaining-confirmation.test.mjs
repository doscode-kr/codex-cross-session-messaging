import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { Chaining } from '../plugins/cross-session/src/chaining.mjs';

test('restore preparation and confirmation survive child IPC failures without a retry', { timeout: 15000 }, async t => {
  const source = '12345678-0000-4000-8000-000000000001', owner = '12345678-0000-4000-8000-000000000002';
  const module = pathToFileURL(resolve('plugins/cross-session/src/hooks.mjs')).href;
  for (const mode of ['prepare_crash', 'confirm_crash', 'success']) {
    const root = temporary(t), chain = new Chaining(root), trace = join(root, 'confirmation.log');
    await chain.bind(source, { chain_id: 'ipc-fixture' });
    const checkpoint = await chain.checkpoint(source, { event: 'Stop', automatic: { messages: [{ role: 'assistant', text: 'IPC_SOURCE_MARKER' }], git: null } });
    await chain.bind(owner, { chain_id: 'ipc-fixture', source_session_id: source });
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: owner } }) + '\n');
    const preload = join(root, 'ipc-failure.mjs');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
if (process.argv[2] === '--chaining-child') {
 const original = process.send.bind(process);
 process.send = (value, ...args) => {
  if (value?.status === 'restored' && ${JSON.stringify(mode)} === 'prepare_crash') process.exit(86);
  if (['confirmed', 'already_confirmed'].includes(value?.status)) {
   appendFileSync(${JSON.stringify(trace)}, value.status + '\\n');
   if (${JSON.stringify(mode)} === 'confirm_crash') process.exit(87);
  }
  return original(value, ...args);
 };
}
`);
    const fixture = join(root, 'fixture.mjs');
    writeFileSync(fixture, `import { runHook, writeHookOutput } from ${JSON.stringify(module)};
const input = ${JSON.stringify({ session_id: owner, transcript_path: transcript, hook_event_name: 'SessionStart' })};
await writeHookOutput(await runHook(input, { hook: async () => ({}) }));
`);
    const env = { ...process.env, CROSS_SESSION_HOME: root };
    delete env.CROSS_SESSION_CHAIN_TICKET;
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fixture], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise((resolveExit, rejectExit) => { child.once('close', resolveExit); child.once('error', rejectExit); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, errors);
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    const status = await chain.status(owner);
    assert.equal(status.binding.restore_pending, mode === 'prepare_crash');
    if (mode === 'prepare_crash') {
      assert.doesNotMatch(context, /IPC_SOURCE_MARKER/);
      assert.equal((await chain.checkpoint(owner, { event: 'Stop' })).status, 'awaiting_restore');
      assert.equal((await chain.restore(owner)).checkpoint.id, checkpoint.checkpoint_id);
    } else {
      assert.match(context, /IPC_SOURCE_MARKER/);
      assert.equal(readFileSync(trace, 'utf8'), 'confirmed\n');
      if (mode === 'confirm_crash') assert.match(errors, /confirmation is uncertain; no retry was made/);
      else assert.equal(errors, '');
    }
  }
});
