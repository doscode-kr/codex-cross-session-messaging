import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.mjs';
import { options, safeTree, preflight, ownsMarketplace, lifecyclePaths, receiptName, pluginId } from '../scripts/lifecycle.mjs';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';

const execute = promisify(execFile);
const repository = resolve('.');
const runScript = (script, args, env = {}) => execute(process.execPath, [join(repository, 'scripts', script), ...args], { env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 });
async function shortPath(path) {
  if (process.platform !== 'win32') return path;
  return (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CROSS_SESSION_ALIAS_TEST).ShortPath'], { env: { ...process.env, CROSS_SESSION_ALIAS_TEST: path }, windowsHide: true, timeout: 10000 })).stdout.trim();
}
async function hasRuntimeAlias(path) { return (await shortPath(path)).toLowerCase() !== realpathSync.native(path).toLowerCase(); }

function mockCodex(root) {
  const file = join(root, 'fake-codex.mjs');
  writeFileSync(file, `
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const home=process.env.CODEX_HOME;
const file=join(home,'mock-state.json');
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{marketplaces:[],installed:[]};
const args=process.argv.slice(2);
const id='cross-session@cross-session-local';
const save=()=>writeFileSync(file,JSON.stringify(state));
const market=args[1]==='marketplace';
const command=market?args[2]:args[1];
const cache=join(home,'plugins','cache','cross-session-local','cross-session');
if(command==='list'&&market&&process.env.FAKE_BROKER_BARRIER&&!existsSync(process.env.FAKE_BROKER_BARRIER)){
 writeFileSync(process.env.FAKE_BROKER_BARRIER,'inventory reached');
 while(!existsSync(process.env.FAKE_BROKER_BARRIER+'.release')) await new Promise(resolve=>setTimeout(resolve,10));
}
if(command==='list'){console.log(JSON.stringify(market?{marketplaces:state.marketplaces}:{installed:state.installed}));}
else if(market&&command==='add'){state.marketplaces.push({name:'cross-session-local',root:args[3]});save();console.log('{}');}
else if(!market&&command==='add'){
 if(process.env.FAKE_INSTALL_FAIL==='1'){console.error('fixture install failure');process.exit(2);}
 state.installed.push({pluginId:id,marketplaceName:'cross-session-local'});
 mkdirSync(join(cache,'0.1.0'),{recursive:true});
 writeFileSync(join(cache,'0.1.0','package.json'),JSON.stringify({name:'codex-cross-session-plugin'}));
 save();console.log(JSON.stringify({pluginId:id}));
}
else if(market&&command==='remove'){state.marketplaces=state.marketplaces.filter(m=>m.name!=='cross-session-local');save();console.log('{}');}
else if(!market&&command==='remove'){state.installed=state.installed.filter(p=>p.pluginId!==id);rmSync(cache,{recursive:true,force:true});save();console.log('{}');}
else{throw new Error('Unexpected fixture command: '+args.join(' '));}
`);
  return { CROSS_SESSION_CODEX_BIN: file };
}

function runtime(home) {
  const path = lifecyclePaths(home).runtime;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'auth-token'), 'a'.repeat(64));
  writeFileSync(join(path, 'events.jsonl'), JSON.stringify({ type: 'leader', value: null }) + '\n');
  return path;
}

test('lifecycle options reject unknown arguments and missing home', () => {
  assert.throws(() => options(['--unknown'], 'uninstall'), /Unknown option/);
  assert.throws(() => options(['--home', '--dry-run'], 'install'), /requires a directory/);
  assert.throws(() => options(['--purge-runtime'], 'install'), /Unknown option/);
  assert.equal(options(['--purge-runtime'], 'uninstall').purgeRuntime, true);
  assert.equal(ownsMarketplace(repository), true);
});

test('dry runs do not create a home or call Codex', async t => {
  const root = temporary(t);
  const home = join(root, 'missing-home');
  const env = { CROSS_SESSION_CODEX_BIN: join(root, 'missing.js') };
  await runScript('install.mjs', ['--home', home, '--dry-run'], env);
  await runScript('uninstall.mjs', ['--home', home, '--dry-run', '--purge-runtime'], env);
  assert.equal(existsSync(home), false);
});

test('linked home and linked cache children are rejected before removal', async t => {
  const root = temporary(t);
  const target = join(root, 'target');
  mkdirSync(target);
  const link = join(root, 'linked');
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('The host cannot create test links.'); return; } throw error; }
  assert.throws(() => preflight(link), /Linked path/);
  const cache = lifecyclePaths(root).cache;
  mkdirSync(cache, { recursive: true });
  symlinkSync(target, join(cache, 'version'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeTree(cache), /Linked path/);
  await assert.rejects(runScript('uninstall.mjs', ['--home', root]), /Linked path/);
  assert.equal(existsSync(target), true);
});

test('Windows 8.3 home spelling cannot bypass an active broker check', { skip: process.platform !== 'win32' }, async t => {
  const root = temporary(t);
  const home = join(root, 'long-runtime-home');
  const data = runtime(home);
  const alias = await shortPath(home);
  if (alias.toLowerCase() === home.toLowerCase()) { t.skip('This filesystem does not expose an 8.3 alias.'); return; }
  const canonical = data.toLowerCase();
  const hash = createHash('sha256').update(canonical).digest('hex');
  const port = 10000 + (parseInt(hash.slice(0, 8), 16) % 30000);
  const server = createServer((req, res) => { res.end('{}'); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await assert.rejects(runScript('uninstall.mjs', ['--home', alias, '--purge-runtime'], mockCodex(root)), /Windows path alias is not safe/);
  assert.equal(readFileSync(join(data, 'auth-token'), 'utf8'), 'a'.repeat(64));
  assert.equal(existsSync(join(data, 'events.jsonl')), true);
  assert.equal(existsSync(join(home, 'mock-state.json')), false);
});

test('install, remove, and repeated remove preserve unrelated state and runtime', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = mockCodex(root);
  writeFileSync(join(home, 'config.toml'), '# keep this configuration\nmodel = "my-model"\n');
  writeFileSync(join(home, 'mock-state.json'), JSON.stringify({ marketplaces: [{ name: 'other', root }], installed: [{ pluginId: 'other@other', marketplaceName: 'other' }] }));
  const data = runtime(home);
  await runScript('install.mjs', ['--home', home, '--skip-deps'], env);
  assert.equal(existsSync(join(home, receiptName)), true);
  const before = readFileSync(join(data, 'events.jsonl'), 'utf8');
  await runScript('uninstall.mjs', ['--home', home, '--dry-run'], env);
  assert.equal(existsSync(lifecyclePaths(home).cache), true);
  await runScript('uninstall.mjs', ['--home', home], env);
  await runScript('uninstall.mjs', ['--home', home], env);
  const state = JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8'));
  assert.deepEqual(state.installed, [{ pluginId: 'other@other', marketplaceName: 'other' }]);
  assert.deepEqual(state.marketplaces, [{ name: 'other', root }]);
  assert.equal(existsSync(lifecyclePaths(home).cache), false);
  assert.equal(existsSync(join(home, receiptName)), false);
  assert.equal(readFileSync(join(data, 'events.jsonl'), 'utf8'), before);
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), '# keep this configuration\nmodel = "my-model"\n');
});

test('purge removes only confirmed runtime files and retains custom runtime', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const data = runtime(home);
  writeFileSync(join(data, 'keep.txt'), 'unrelated');
  const custom = join(root, 'custom');
  mkdirSync(custom);
  writeFileSync(join(custom, 'keep.txt'), 'custom');
  const env = { ...mockCodex(root), CROSS_SESSION_HOME: custom };
  if (await hasRuntimeAlias(data)) {
    await assert.rejects(runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], env), /8.3 path alias/);
    assert.equal(existsSync(join(data, 'events.jsonl')), true);
    assert.equal(existsSync(join(data, 'auth-token')), true);
    assert.equal(readFileSync(join(data, 'keep.txt'), 'utf8'), 'unrelated');
    assert.equal(readFileSync(join(custom, 'keep.txt'), 'utf8'), 'custom');
    return;
  }
  await runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], env);
  assert.equal(existsSync(join(data, 'events.jsonl')), false);
  assert.equal(existsSync(join(data, 'auth-token')), false);
  assert.equal(readFileSync(join(data, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(readFileSync(join(custom, 'keep.txt'), 'utf8'), 'custom');
  await runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], env);
  assert.equal(readFileSync(join(data, 'keep.txt'), 'utf8'), 'unrelated');
});

test('a marketplace shared with another plugin is kept after product removal', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const source = join(root, 'source');
  mkdirSync(join(source, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(source, 'plugins', 'cross-session'), { recursive: true });
  writeFileSync(join(source, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'cross-session-local', plugins: [{ name: 'cross-session', source: './plugins/cross-session' }, { name: 'other', source: './plugins/other' }] }));
  writeFileSync(join(source, 'plugins', 'cross-session', 'package.json'), JSON.stringify({ name: 'codex-cross-session-plugin' }));
  const other = { pluginId: 'other@cross-session-local', marketplaceName: 'cross-session-local' };
  writeFileSync(join(home, 'mock-state.json'), JSON.stringify({ marketplaces: [{ name: 'cross-session-local', root: source }], installed: [{ pluginId, marketplaceName: 'cross-session-local' }, other] }));
  await runScript('uninstall.mjs', ['--home', home], mockCodex(root));
  const after = JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8'));
  assert.deepEqual(after.installed, [other]);
  assert.deepEqual(after.marketplaces, [{ name: 'cross-session-local', root: source }]);
});

test('an active broker blocks purge before a plugin is removed', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const data = runtime(home);
  const canonical = process.platform === 'win32' ? data.toLowerCase() : data;
  const hash = createHash('sha256').update(canonical).digest('hex');
  const port = 10000 + (parseInt(hash.slice(0, 8), 16) % 30000);
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await assert.rejects(runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], mockCodex(root)), /service is active|8.3 path alias/);
  assert.equal(existsSync(join(data, 'events.jsonl')), true);
  assert.equal(existsSync(join(home, 'mock-state.json')), false);
});

test('a broker that starts during inventory prevents runtime purge', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const data = runtime(home);
  if (await hasRuntimeAlias(data)) { t.skip('Windows alias safety refuses this runtime before inventory.'); return; }
  const canonical = process.platform === 'win32' ? data.toLowerCase() : data;
  const hash = createHash('sha256').update(canonical).digest('hex');
  const port = 10000 + (parseInt(hash.slice(0, 8), 16) % 30000);
  const marker = join(root, 'broker-barrier');
  const originalEvents = readFileSync(join(data, 'events.jsonl'), 'utf8');
  writeFileSync(join(home, 'mock-state.json'), JSON.stringify({ marketplaces: [{ name: 'cross-session-local', root: repository }], installed: [{ pluginId, marketplaceName: 'cross-session-local' }] }));
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], { ...mockCodex(root), FAKE_BROKER_BARRIER: marker });
  const rejection = assert.rejects(result, /service is active/);
  const deadline = Date.now() + 5000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('The inventory barrier was not reached.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  writeFileSync(marker + '.release', 'resume inventory');
  await rejection;
  assert.equal(readFileSync(join(data, 'events.jsonl'), 'utf8'), originalEvents);
  assert.equal(readFileSync(join(data, 'auth-token'), 'utf8'), 'a'.repeat(64));
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8')).installed, []);
});

test('a legacy short-path broker is protected when purge uses the long home path', { skip: process.platform !== 'win32' }, async t => {
  const root = temporary(t);
  const home = join(root, 'long-legacy-runtime-home');
  const data = runtime(home);
  const short = await shortPath(data);
  if (short.toLowerCase() === data.toLowerCase()) { t.skip('This filesystem does not expose an 8.3 alias.'); return; }
  const legacy = realpathSync(short).toLowerCase();
  const hash = createHash('sha256').update(legacy).digest('hex');
  const port = 10000 + (parseInt(hash.slice(0, 8), 16) % 30000);
  const server = createServer((req, res) => { res.end('{}'); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await assert.rejects(runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], mockCodex(root)), /8.3 path alias/);
  assert.equal(readFileSync(join(data, 'auth-token'), 'utf8'), 'a'.repeat(64));
  assert.equal(existsSync(join(data, 'events.jsonl')), true);
  assert.equal(existsSync(join(home, 'mock-state.json')), false);
});

test('purge rejects unknown runtime ownership before any plugin change', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const path = lifecyclePaths(home).runtime;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'events.jsonl'), 'not product data');
  await assert.rejects(runScript('uninstall.mjs', ['--home', home, '--purge-runtime'], mockCodex(root)), /ownership cannot be confirmed/);
  assert.equal(existsSync(join(home, 'mock-state.json')), false);
});

test('failed install rolls back only new registrations and reports failure', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const env = { ...mockCodex(root), FAKE_INSTALL_FAIL: '1' };
  await assert.rejects(runScript('install.mjs', ['--home', home, '--skip-deps'], env), /Installation failed/);
  const state = JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8'));
  assert.deepEqual(state, { marketplaces: [], installed: [] });
  assert.equal(existsSync(join(home, receiptName)), false);
});

test('failed reinstall retains prior marketplace and plugin registrations', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const state = { marketplaces: [{ name: 'cross-session-local', root: repository }], installed: [{ pluginId, marketplaceName: 'cross-session-local' }] };
  writeFileSync(join(home, 'mock-state.json'), JSON.stringify(state));
  await assert.rejects(runScript('install.mjs', ['--home', home, '--skip-deps'], { ...mockCodex(root), FAKE_INSTALL_FAIL: '1' }), /Installation failed/);
  const after = JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8'));
  assert.deepEqual(after.installed, state.installed);
  assert.ok(after.marketplaces.some(m => m.name === 'cross-session-local'));
});

test('unknown cache and installation receipt are rejected before Codex writes', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  const cache = lifecyclePaths(home).cache;
  mkdirSync(join(cache, 'alien'), { recursive: true });
  writeFileSync(join(cache, 'alien', 'package.json'), JSON.stringify({ name: 'unrelated' }));
  await assert.rejects(runScript('uninstall.mjs', ['--home', home], mockCodex(root)), /unrecognized plugin/);
  assert.equal(existsSync(join(home, 'mock-state.json')), false);
  const otherHome = join(root, 'other-home');
  mkdirSync(otherHome);
  writeFileSync(join(otherHome, receiptName), JSON.stringify({ product: 'unrelated' }));
  await assert.rejects(runScript('uninstall.mjs', ['--home', otherHome], mockCodex(root)), /record is not owned/);
  assert.equal(existsSync(join(otherHome, 'mock-state.json')), false);
});

test('an unknown source with the same marketplace name is not overwritten', async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const state = { marketplaces: [{ name: 'cross-session-local', root }], installed: [] };
  writeFileSync(join(home, 'mock-state.json'), JSON.stringify(state));
  await assert.rejects(runScript('install.mjs', ['--home', home, '--skip-deps'], mockCodex(root)), /belongs to another source/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'mock-state.json'), 'utf8')), state);
});

test('real Codex installation and removal preserve another plugin and configuration', { skip: process.env.CROSS_SESSION_REAL_CODEX_TEST !== '1', timeout: 45000 }, async t => {
  const root = temporary(t);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), '# preserved user setting\nmodel = "saved-model"\n');
  const other = join(root, 'other-source');
  mkdirSync(join(other, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(other, 'plugins', 'other'), { recursive: true });
  writeFileSync(join(other, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'other-market', plugins: [{ name: 'other', source: './plugins/other' }] }));
  writeFileSync(join(other, 'plugins', 'other', 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
  mkdirSync(join(other, 'plugins', 'other', '.codex-plugin'));
  writeFileSync(join(other, 'plugins', 'other', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'other', version: '1.0.0', description: 'Isolated test fixture.' }));
  const bin = resolveCodex();
  const env = { ...process.env, CODEX_HOME: home };
  const codex = async args => JSON.parse((await execute(bin.command, [...bin.args, ...args], { env, windowsHide: true, timeout: 15000 })).stdout);
  await codex(['plugin', 'marketplace', 'add', other, '--json']);
  await codex(['plugin', 'add', 'other@other-market', '--json']);
  const otherCache = join(home, 'plugins', 'cache', 'other-market', 'other', '1.0.0', 'package.json');
  const unchanged = readFileSync(otherCache, 'utf8');
  const data = runtime(home);
  await runScript('install.mjs', ['--home', home, '--skip-deps']);
  assert.equal(existsSync(lifecyclePaths(home).cache), true);
  await runScript('uninstall.mjs', ['--home', home, '--dry-run']);
  assert.equal(existsSync(lifecyclePaths(home).cache), true);
  await runScript('uninstall.mjs', ['--home', home]);
  await runScript('uninstall.mjs', ['--home', home]);
  assert.equal(existsSync(lifecyclePaths(home).cache), false);
  assert.equal(existsSync(join(home, 'plugins', 'cache', 'cross-session-local')), false);
  assert.equal(readFileSync(otherCache, 'utf8'), unchanged);
  assert.match(readFileSync(join(home, 'config.toml'), 'utf8'), /model = "saved-model"/);
  assert.deepEqual((await codex(['plugin', 'marketplace', 'list', '--json'])).marketplaces.map(m => m.name), ['other-market']);
  assert.deepEqual((await codex(['plugin', 'list', '--json'])).installed.map(p => p.pluginId), ['other@other-market']);
  assert.equal(existsSync(join(data, 'events.jsonl')), true);
  if (await hasRuntimeAlias(data)) {
    await assert.rejects(runScript('uninstall.mjs', ['--home', home, '--purge-runtime']), /8.3 path alias/);
    assert.equal(existsSync(join(data, 'events.jsonl')), true);
  } else {
    await runScript('uninstall.mjs', ['--home', home, '--purge-runtime']);
    assert.equal(existsSync(data), false);
  }
});
