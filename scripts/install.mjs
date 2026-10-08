import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex } from '../plugins/cross-session/src/codex.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'cross-session');
const options = process.argv.slice(2);
const dryRun = options.includes('--dry-run');
const homeIndex = options.indexOf('--home');
const env = { ...process.env };
if (homeIndex >= 0) {
  if (!options[homeIndex + 1]) throw new Error('--home requires a directory');
  env.CODEX_HOME = resolve(options[homeIndex + 1]);
  if (!dryRun) mkdirSync(env.CODEX_HOME, { recursive: true });
}
function npmEntry() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const dir of (process.env.PATH || '').split(delimiter)) candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const entry = candidates.find(file => file && existsSync(file) && file.endsWith('.js'));
  if (entry) return { command: process.execPath, args: [entry] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('Run npm run install:global so npm provides its executable path.');
}
async function run(bin, args) {
  console.log(JSON.stringify({ command: bin.command, args: [...bin.args, ...args] }));
  if (dryRun) return;
  const { stdout, stderr } = await execute(bin.command, [...bin.args, ...args], { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}
try {
  if (!options.includes('--skip-deps')) await run(npmEntry(), ['ci', '--prefix', plugin, '--ignore-scripts', '--no-audit', '--no-fund']);
  const codex = resolveCodex(env);
  await run(codex, ['plugin', 'marketplace', 'add', root, '--json']);
  await run(codex, ['plugin', 'add', 'cross-session@cross-session-local', '--json']);
  console.log('Open a new Codex CLI session. Review this plugin in /hooks and trust its hooks. Then use $cross-session.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
