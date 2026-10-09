import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';
import { preflight, validateCache, lifecyclePaths, pluginId, receiptName } from '../scripts/lifecycle.mjs';

const execute = promisify(execFile);
const repository = resolve('.');
const marker = 'PRV81';
const receiptError = 'The installation record has invalid JSON. Keep the file and inspect it before you retry.';
const cacheError = 'A cached plugin package file has invalid JSON. Keep the cache and inspect it before you retry.';

function snapshot(root) {
  const entries = [];
  function visit(folder, prefix = '') {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) { entries.push([relative, 'directory']); visit(join(folder, entry.name), relative + '/'); }
      else entries.push([relative, readFileSync(join(folder, entry.name)).toString('hex')]);
    }
  }
  visit(root);
  return entries;
}

for (const kind of ['receipt', 'cache']) for (const script of ['install.mjs', 'uninstall.mjs']) {
  test(`${script} rejects malformed ${kind} without exposing contents or changing files`, async t => {
    const root = temporary(t), home = join(root, 'home'), paths = lifecyclePaths(home);
    mkdirSync(join(paths.cache, '0.1.0'), { recursive: true });
    mkdirSync(paths.runtime);
    writeFileSync(join(home, 'config.toml'), '# unrelated configuration\n');
    writeFileSync(join(paths.runtime, 'events.jsonl'), '{"type":"leader","value":null}\n');
    writeFileSync(join(paths.runtime, 'auth-token'), 'a'.repeat(64));
    writeFileSync(paths.receipt, JSON.stringify({ product: 'codex-cross-session', pluginId, schema: 1 }));
    const cacheFile = join(paths.cache, '0.1.0', 'package.json');
    writeFileSync(cacheFile, JSON.stringify({ name: 'codex-cross-session-plugin' }));
    writeFileSync(kind === 'receipt' ? paths.receipt : cacheFile, marker + ' broken fixture');
    const called = join(root, 'codex-called'), mock = join(root, 'fixture-codex.mjs');
    writeFileSync(mock, `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE_CALLED, 'called'); console.log('{}');`);
    const before = snapshot(home);
    await assert.rejects(execute(process.execPath, [join(repository, 'scripts', script), '--home', home, '--dry-run'], {
      env: { ...process.env, CROSS_SESSION_CODEX_BIN: mock, FIXTURE_CALLED: called }, windowsHide: true, timeout: 10000
    }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.trim(), kind === 'receipt' ? receiptError : cacheError);
      assert.ok(!error.stderr.includes(marker));
      return true;
    });
    assert.equal(existsSync(called), false);
    assert.deepEqual(snapshot(home), before);
  });
}

test('parse errors do not retain raw data in cause, details, or stack', t => {
  const home = temporary(t), paths = lifecyclePaths(home);
  mkdirSync(join(paths.cache, '0.1.0'), { recursive: true });
  writeFileSync(paths.receipt, marker + ' broken fixture');
  writeFileSync(join(paths.cache, '0.1.0', 'package.json'), marker + ' broken fixture');
  for (const action of [() => preflight(home), () => validateCache(paths.cache)]) {
    assert.throws(action, error => {
      assert.equal(error.cause, undefined);
      assert.equal(error.details, undefined);
      assert.ok(!error.stack.includes(marker));
      assert.ok(!JSON.stringify(error).includes(marker));
      return true;
    });
  }
});

test('valid JSON with no product ownership is rejected with ownership diagnostics', t => {
  const home = temporary(t), paths = lifecyclePaths(home);
  mkdirSync(join(paths.cache, '0.1.0'), { recursive: true });
  for (const value of [null, false, 42, marker, [], {}, { product: 'other', name: 'other' }]) {
    writeFileSync(paths.receipt, JSON.stringify(value));
    assert.throws(() => preflight(home), /The installation record is not owned by this product/);
    writeFileSync(join(paths.cache, '0.1.0', 'package.json'), JSON.stringify(value));
    assert.throws(() => validateCache(paths.cache), /The cache contains an unrecognized plugin/);
  }
});

test('normal product ownership checks and file read errors remain available', t => {
  const home = temporary(t), paths = lifecyclePaths(home);
  mkdirSync(join(paths.cache, '0.1.0'), { recursive: true });
  writeFileSync(paths.receipt, JSON.stringify({ product: 'codex-cross-session', pluginId, schema: 1 }));
  writeFileSync(join(paths.cache, '0.1.0', 'package.json'), JSON.stringify({ name: 'codex-cross-session-plugin' }));
  assert.deepEqual(preflight(home), paths);
  assert.doesNotThrow(() => validateCache(paths.cache));
  const otherHome = join(home, 'read-error');
  mkdirSync(join(otherHome, receiptName), { recursive: true });
  assert.throws(() => preflight(otherHome), { code: 'EISDIR' });
});

test('uninstall keeps a receipt damaged after inventory without exposing its contents', async t => {
  const root = temporary(t), home = join(root, 'home'), paths = lifecyclePaths(home);
  mkdirSync(paths.runtime, { recursive: true });
  writeFileSync(paths.receipt, JSON.stringify({ product: 'codex-cross-session', pluginId, schema: 1 }));
  writeFileSync(join(home, 'config.toml'), '# keep configuration\n');
  writeFileSync(join(paths.runtime, 'events.jsonl'), '{"type":"leader","value":null}\n');
  const beforeConfig = readFileSync(join(home, 'config.toml'));
  const beforeJournal = readFileSync(join(paths.runtime, 'events.jsonl'));
  const mock = join(root, 'fixture-codex.mjs'), calls = join(root, 'calls.jsonl');
  writeFileSync(mock, `
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args)+'\\n');
if(args[1]==='marketplace'&&args[2]==='list') console.log('{"marketplaces":[]}');
else if(args[1]==='list') console.log('{"installed":[]}');
else if(args[1]==='remove') {
 writeFileSync(join(process.env.CODEX_HOME,'.cross-session-install.json'),'PRV81 broken fixture');
 console.log('{}');
} else throw new Error('Unexpected fixture command');
`);
  await assert.rejects(execute(process.execPath, [join(repository, 'scripts/uninstall.mjs'), '--home', home], {
    env: { ...process.env, CROSS_SESSION_CODEX_BIN: mock, FIXTURE_CALLS: calls }, windowsHide: true, timeout: 10000
  }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr.trim(), receiptError);
    assert.ok(!error.stderr.includes(marker));
    return true;
  });
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), [
    ['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json'], ['plugin', 'remove', pluginId, '--json']
  ]);
  assert.equal(readFileSync(paths.receipt, 'utf8'), marker + ' broken fixture');
  assert.deepEqual(readFileSync(join(home, 'config.toml')), beforeConfig);
  assert.deepEqual(readFileSync(join(paths.runtime, 'events.jsonl')), beforeJournal);
});
