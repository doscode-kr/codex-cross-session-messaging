import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { options, preflight, safePath, safeTree, lifecyclePaths, codexRunner, inventory, pluginId, marketplaceName, ownsMarketplace, ownsPluginSource, validateCache, assertRuntimeSpelling } from './lifecycle.mjs';

async function runtimePlan(home, dryRun) {
  const runtime = lifecyclePaths(home).runtime;
  safeTree(runtime);
  if (!existsSync(runtime)) return [];
  const tokenFile = join(runtime, 'auth-token');
  const eventFile = join(runtime, 'events.jsonl');
  if (!existsSync(tokenFile) && !existsSync(eventFile)) return [];
  if (!existsSync(tokenFile) || !/^[a-f0-9]{64}$/.test(readFileSync(tokenFile, 'utf8')) || !existsSync(eventFile)) {
    throw new Error('Runtime ownership cannot be confirmed. Keep the runtime files and inspect them yourself.');
  }
  const types = new Set(['session', 'leader', 'message', 'delivery', 'ack', 'subscription', 'subscription_done']);
  const raw = readFileSync(eventFile, 'utf8');
  // A crash can leave an incomplete final append. Validate only complete lines.
  for (const line of raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
    if (!types.has(JSON.parse(line).type)) throw new Error('The runtime journal contains an unrecognized event.');
  }
  await assertRuntimeSpelling(runtime);
  if (!dryRun) {
    const root = realpathSync(runtime);
    const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
    const instance = createHash('sha256').update(canonical).digest('hex');
    const port = 10000 + (parseInt(instance.slice(0, 8), 16) % 30000);
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(tokenFile, 'utf8')}`, 'content-type': 'application/json' }, body: JSON.stringify({ instance }), signal: AbortSignal.timeout(1500) });
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return [tokenFile, eventFile];
      throw new Error('The broker state is unknown. Stop the broker before you purge runtime data.');
    }
    throw new Error('A service is active on the broker port. Stop the broker before you purge runtime data.');
  }
  return [tokenFile, eventFile];
}

async function uninstall() {
  const opt = options(process.argv.slice(2), 'uninstall');
  if (opt.help) { console.log('Usage: node scripts/uninstall.mjs [--home DIR] [--dry-run] [--purge-runtime]\nRuntime data is kept by default. Stop the broker before --purge-runtime. Windows runtime paths with 8.3 aliases require manual removal. Custom CROSS_SESSION_HOME paths are not removed.'); return; }
  const paths = preflight(opt.home);
  validateCache(paths.cache);
  const runtimeFiles = opt.purgeRuntime ? await runtimePlan(opt.home, opt.dryRun) : [];
  if (opt.dryRun) {
    console.log(JSON.stringify({ dryRun: true, home: opt.home, plugin: pluginId, cache: paths.cache, marketplace: 'Remove only if this product owns the source and no other installed plugin uses it.', removeReceipt: paths.receipt, runtime: runtimeFiles, customRuntime: 'Custom CROSS_SESSION_HOME paths are not removed.' }, null, 2));
    return;
  }
  if (!existsSync(opt.home)) { console.log('Cross-session is not installed in this home.'); return; }
  const run = codexRunner(opt.home);
  const before = await inventory(run, opt.home);
  const installed = before.installed.find(p => p.pluginId === pluginId);
  if (installed && before.marketplace && !ownsPluginSource(before.marketplace.root)) throw new Error('The marketplace source is not this product. No plugin was removed.');
  preflight(opt.home);
  await run(['plugin', 'remove', pluginId, '--json']);
  if (existsSync(paths.cache)) throw new Error('Codex left the plugin cache in place. Inspect the cache before you remove it.');
  const otherPlugins = before.installed.filter(p => p.pluginId !== pluginId && p.marketplaceName === marketplaceName);
  if (before.marketplace && ownsMarketplace(before.marketplace.root) && !otherPlugins.length) {
    preflight(opt.home);
    await run(['plugin', 'marketplace', 'remove', marketplaceName, '--json']);
  } else if (before.marketplace) console.log('Kept the marketplace because its source is unknown or another plugin uses it.');
  const marketCache = join(opt.home, 'plugins', 'cache', marketplaceName);
  safePath(marketCache);
  if (existsSync(marketCache) && readdirSync(marketCache).length === 0) rmdirSync(marketCache);
  if (existsSync(paths.receipt)) {
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
    if (receipt.product === 'codex-cross-session' && receipt.pluginId === pluginId) { safePath(paths.receipt); rmSync(paths.receipt); }
    else console.log('Kept an unrecognized installation record.');
  }
  const confirmedFiles = runtimeFiles.length ? await runtimePlan(opt.home, false) : [];
  for (const file of confirmedFiles) { safePath(file); rmSync(file); }
  if (runtimeFiles.length && readdirSync(paths.runtime).length === 0) rmdirSync(paths.runtime);
  console.log('Removed cross-session. Existing sessions can retain the loaded plugin. Open new sessions to use the new configuration.');
  console.log(opt.purgeRuntime ? 'Removed the confirmed runtime files. Custom runtime paths were kept.' : `Kept runtime data: ${paths.runtime}`);
}

try { await uninstall(); } catch (error) { console.error(error.message); process.exitCode = 1; }
