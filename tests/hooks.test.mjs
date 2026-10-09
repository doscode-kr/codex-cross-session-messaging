import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { temporary } from './helpers.mjs';

test('packaged hook command supports plugin paths with spaces and ignores subagent parent IDs', async t => {
  const root = temporary(t);
  const plugin = join(root, 'plugin with spaces');
  cpSync(resolve('plugins/cross-session'), plugin, { recursive: true });
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8'));
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const state = join(root, 'unused-state');
  const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, PLUGIN_ROOT: plugin, CROSS_SESSION_HOME: state } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'parent', agent_id: 'child' }));
  const exit = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(exit, 0);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {});
  assert.equal(existsSync(state), false);
});
