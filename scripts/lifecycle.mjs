import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';

export const pluginId = 'cross-session@cross-session-local';
export const marketplaceName = 'cross-session-local';
export const receiptName = '.cross-session-install.json';
const execute = promisify(execFile);

export function options(argv, mode, env = process.env) {
  const result = { dryRun: false, skipDeps: false, purgeRuntime: false, help: false, home: resolve(env.CODEX_HOME || join(homedir(), '.codex')) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--skip-deps' && mode === 'install') result.skipDeps = true;
    else if (arg === '--purge-runtime' && mode === 'uninstall') result.purgeRuntime = true;
    else if (arg === '--home') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--home requires a directory');
      result.home = resolve(argv[++i]);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.home === parse(result.home).root) throw new Error('The Codex home cannot be a filesystem root.');
  return result;
}

// Check each ancestor, including junctions on Windows. Never follow linked trees.
export function safePath(path) {
  const absolute = resolve(path);
  if (process.platform === 'win32' && absolute.startsWith('\\\\?\\')) throw new Error('A Windows path alias is not safe. Use the full directory path.');
  for (let current = absolute; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Linked path is not safe: ${current}`);
      if (process.platform === 'win32' && realpathSync.native(current).toLowerCase() !== current.toLowerCase()) {
        throw new Error(`A Windows path alias is not safe: ${current}. Use the full directory path.`);
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  return absolute;
}

export function safeTree(path) {
  safePath(path);
  if (!existsSync(path)) return;
  if (lstatSync(path).isDirectory()) for (const child of readdirSync(path)) safeTree(join(path, child));
}

export function lifecyclePaths(home) {
  return { cache: join(home, 'plugins', 'cache', marketplaceName, 'cross-session'), receipt: join(home, receiptName), runtime: join(home, 'cross-session') };
}

export function preflight(home) {
  safePath(home);
  if (existsSync(home) && !lstatSync(home).isDirectory()) throw new Error('The Codex home must be a directory.');
  safePath(join(home, 'config.toml'));
  const paths = lifecyclePaths(home);
  safePath(paths.receipt);
  if (existsSync(paths.receipt)) {
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
    if (receipt.product !== 'codex-cross-session' || receipt.pluginId !== pluginId || receipt.schema !== 1) throw new Error('The installation record is not owned by this product.');
  }
  safeTree(paths.cache);
  return paths;
}

export function samePath(a, b) {
  const normalize = p => {
    const value = realpathSync(p).replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  try { return normalize(a) === normalize(b); } catch { return false; }
}

export function ownsPluginSource(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    if (manifest.name !== marketplaceName || !Array.isArray(manifest.plugins)) return false;
    const matches = manifest.plugins.filter(plugin => plugin.name === 'cross-session');
    if (matches.length !== 1) return false;
    const plugin = matches[0];
    if (typeof plugin.source !== 'string') return false;
    const source = resolve(root, plugin.source);
    const rel = relative(resolve(root), source);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    return JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name === 'codex-cross-session-plugin';
  } catch { return false; }
}

export function ownsMarketplace(root) {
  try {
    return ownsPluginSource(root) && JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8')).plugins.length === 1;
  } catch { return false; }
}

export function codexRunner(home, env = process.env) {
  const isolated = { ...env, CODEX_HOME: home };
  const bin = resolveCodex(isolated);
  return async args => {
    const { stdout, stderr } = await execute(bin.command, [...bin.args, ...args], { env: isolated, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (stderr.trim()) console.error(stderr.trim());
    return JSON.parse(stdout);
  };
}

export async function inventory(run, home) {
  try {
    const markets = await run(['plugin', 'marketplace', 'list', '--json']);
    const plugins = await run(['plugin', 'list', '--json']);
    if (!Array.isArray(markets.marketplaces) || !Array.isArray(plugins.installed)) throw new Error('Unsupported Codex plugin inventory.');
    return { marketplace: markets.marketplaces.find(m => m.name === marketplaceName), installed: plugins.installed };
  } catch (error) {
    // A receipt provides diagnostic context, not permission to change a registration.
    let sourceRoot;
    try {
      if (!home) throw new Error('No home was supplied.');
      const file = lifecyclePaths(home).receipt;
      safePath(file);
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      if (receipt.product === 'codex-cross-session' && receipt.schema === 1 && receipt.pluginId === pluginId && receipt.marketplaceName === marketplaceName && typeof receipt.sourceRoot === 'string' && isAbsolute(receipt.sourceRoot) && !existsSync(receipt.sourceRoot)) sourceRoot = receipt.sourceRoot;
    } catch { /* Keep the original inventory error if the record cannot be used. */ }
    if (!sourceRoot) throw error;
    throw new Error(`Codex plugin inventory failed: ${error.message}\nThe recorded marketplace source directory is unavailable: ${JSON.stringify(sourceRoot)}.\nRestore the original source checkout at that path. Use the same Codex home: ${JSON.stringify(home)}. Check codex plugin marketplace list --json and codex plugin list --json before you retry.\nThe installation record does not confirm current marketplace ownership. Do not delete registrations or message data to bypass this error. See docs/OPERATIONS.md and docs/UNINSTALL.md for source recovery.`, { cause: error });
  }
}

export function validateCache(cache) {
  if (!existsSync(cache)) return;
  for (const version of readdirSync(cache)) {
    const file = join(cache, version, 'package.json');
    if (!existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).name !== 'codex-cross-session-plugin') {
      throw new Error(`The cache contains an unrecognized plugin: ${join(cache, version)}`);
    }
  }
}

export async function assertRuntimeSpelling(runtime) {
  if (process.platform !== 'win32') return;
  let short;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CROSS_SESSION_RUNTIME_PATH).ShortPath'], { env: { ...process.env, CROSS_SESSION_RUNTIME_PATH: runtime }, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    short = stdout.trim();
  } catch {
    throw new Error('Windows runtime path aliases cannot be checked. Runtime data was kept. Stop the broker and use the manual uninstall runbook.');
  }
  if (!short || short.toLowerCase() !== realpathSync.native(runtime).toLowerCase()) {
    throw new Error('Windows runtime can use an 8.3 path alias. Runtime data was kept because a legacy broker can use another port. Stop the broker and use the manual uninstall runbook.');
  }
}
