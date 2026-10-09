import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, preflight, samePath, safePath, codexRunner, inventory, pluginId, marketplaceName, validateCache } from './lifecycle.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'cross-session');

function npmEntry() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const search = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of search.split(delimiter)) candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const entry = candidates.find(file => file && existsSync(file) && file.endsWith('.js'));
  if (entry) return { command: process.execPath, args: [entry] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('Run npm run install:global so npm supplies its executable path.');
}

async function install() {
  const opt = options(process.argv.slice(2), 'install');
  if (opt.help) { console.log('Usage: node scripts/install.mjs [--home DIR] [--dry-run] [--skip-deps]'); return; }
  const paths = preflight(opt.home);
  validateCache(paths.cache);
  if (opt.dryRun) {
    console.log(JSON.stringify({ dryRun: true, home: opt.home, dependencies: !opt.skipDeps, commands: [['plugin', 'marketplace', 'add', root, '--json'], ['plugin', 'add', pluginId, '--json']] }, null, 2));
    return;
  }
  mkdirSync(opt.home, { recursive: true });
  const temporary = `${paths.receipt}.${process.pid}.tmp`;
  const checkPaths = () => { preflight(opt.home); validateCache(paths.cache); safePath(temporary); };
  const invoke = codexRunner(opt.home);
  const run = async args => {
    checkPaths();
    const result = await invoke(args);
    checkPaths();
    return result;
  };
  const before = await inventory(run, opt.home);
  if (before.marketplace && !samePath(before.marketplace.root, root)) throw new Error('The marketplace name belongs to another source. Keep that source or remove it yourself.');
  if (!opt.skipDeps) {
    const npm = npmEntry();
    const { stdout, stderr } = await execute(npm.command, [...npm.args, 'ci', '--prefix', plugin, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    checkPaths();
  }
  const hadPlugin = before.installed.some(p => p.pluginId === pluginId);
  let marketAttempted = false, pluginAttempted = false;
  try {
    marketAttempted = true;
    await run(['plugin', 'marketplace', 'add', root, '--json']);
    pluginAttempted = true;
    const result = await run(['plugin', 'add', pluginId, '--json']);
    if (result.pluginId !== pluginId) throw new Error('Codex did not confirm the expected plugin installation.');
    writeFileSync(temporary, JSON.stringify({ product: 'codex-cross-session', schema: 1, pluginId, marketplaceName, sourceRoot: root }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, paths.receipt);
    console.log('Installed cross-session. Open a new Codex CLI session. Review the plugin in /hooks and trust its hooks. Use $cross-session.');
  } catch (error) {
    const failures = [];
    if (pluginAttempted && !hadPlugin) {
      try { preflight(opt.home); validateCache(paths.cache); await run(['plugin', 'remove', pluginId, '--json']); } catch (rollback) { failures.push(rollback.message); }
    }
    if (marketAttempted && !before.marketplace) {
      try {
        preflight(opt.home);
        const current = await inventory(run, opt.home);
        if (current.marketplace && !samePath(current.marketplace.root, root)) throw new Error('The marketplace source changed during installation.');
        if (current.installed.some(p => p.marketplaceName === marketplaceName)) throw new Error('An installed plugin still uses the marketplace.');
        if (current.marketplace) await run(['plugin', 'marketplace', 'remove', marketplaceName, '--json']);
      } catch (rollback) { failures.push(rollback.message); }
    }
    try { checkPaths(); if (existsSync(temporary)) rmSync(temporary); }
    catch (cleanup) { failures.push(cleanup.message); }
    throw new Error(`Installation failed: ${error.message}${failures.length ? ` Rollback failed: ${failures.join('; ')}. Run uninstall:global after you inspect the home.` : ''}`);
  }
}

try { await install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
