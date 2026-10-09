import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';

const execute = promisify(execFile);

test('installation stops after a home link replacement at each Codex response boundary', async t => {
  const normal = ['market-list', 'plugin-list', 'market-add', 'plugin-add'];
  const cases = normal.map((phase, index) => [phase, normal.slice(0, index + 1)]);
  cases.push(['plugin-add-failure', normal], ['npm', normal.slice(0, 2)],
    ['rollback-market-list', [...normal, 'plugin-remove', 'market-list']],
    ['rollback-plugin-list', [...normal, 'plugin-remove', 'market-list', 'plugin-list']]);
  for (const [phase, expected] of cases) {
    await t.test(phase, async t => {
      const root = temporary(t);
      const home = join(root, 'home'), other = join(root, 'other'), saved = join(root, 'saved-home');
      mkdirSync(home); mkdirSync(other);
      writeFileSync(join(home, 'config.toml'), '# original config\n');
      writeFileSync(join(other, 'sentinel'), 'keep other directory');
      const log = join(root, 'calls.jsonl');
      const fixture = join(root, 'codex.mjs');
      writeFileSync(fixture, `
import { appendFileSync, renameSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const market = args[1] === 'marketplace';
const operation = market ? args[2] : args[1];
const phase = (market ? 'market-' : 'plugin-') + operation;
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(phase) + '\\n');
const requested = process.env.FIXTURE_PHASE;
const rollback = requested.startsWith('rollback-') && readFileSync(process.env.FIXTURE_LOG, 'utf8').includes('plugin-add');
if (phase === requested || (requested === 'plugin-add-failure' && phase === 'plugin-add') || (rollback && requested === 'rollback-' + phase)) {
  renameSync(process.env.CODEX_HOME, process.env.FIXTURE_SAVED);
  symlinkSync(process.env.FIXTURE_OTHER, process.env.CODEX_HOME, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(process.env.FIXTURE_OTHER, '.cross-session-install.json.' + process.ppid + '.tmp'), 'keep temporary names in another directory');
}
if (phase === 'plugin-add' && (requested.startsWith('rollback-') || requested === 'plugin-add-failure')) process.exit(2);
console.log(JSON.stringify(operation === 'list' ? (market ? { marketplaces: [] } : { installed: [] }) : market ? {} : { pluginId: 'cross-session@cross-session-local' }));
`);
      const npmFixture = join(root, 'npm-fixture.js');
      writeFileSync(npmFixture, `
const fs = require('node:fs');
const path = require('node:path');
fs.renameSync(process.env.CODEX_HOME, process.env.FIXTURE_SAVED);
fs.symlinkSync(process.env.FIXTURE_OTHER, process.env.CODEX_HOME, process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(process.env.FIXTURE_OTHER, '.cross-session-install.json.' + process.ppid + '.tmp'), 'keep temporary names in another directory');
`);
      try {
        await assert.rejects(execute(process.execPath, [resolve('scripts/install.mjs'), '--home', home, ...(phase === 'npm' ? [] : ['--skip-deps'])], {
          env: { ...process.env, CODEX_HOME: home, npm_execpath: npmFixture, CROSS_SESSION_CODEX_BIN: fixture, FIXTURE_LOG: log, FIXTURE_PHASE: phase, FIXTURE_SAVED: saved, FIXTURE_OTHER: other },
          windowsHide: true, timeout: 15000
        }), error => { assert.equal(error.code, 1); assert.match(error.stderr, /Linked path is not safe/); return true; });
        assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), expected);
        assert.equal(readFileSync(join(saved, 'config.toml'), 'utf8'), '# original config\n');
        assert.deepEqual(readdirSync(saved), ['config.toml']);
        assert.equal(readFileSync(join(other, 'sentinel'), 'utf8'), 'keep other directory');
        const names = readdirSync(other);
        assert.equal(names.length, 2);
        const temporaryName = names.find(name => name.endsWith('.tmp'));
        assert.ok(temporaryName);
        assert.equal(readFileSync(join(other, temporaryName), 'utf8'), 'keep temporary names in another directory');
      } finally {
        if (lstatSync(home).isSymbolicLink()) unlinkSync(home);
      }
    });
  }
});
