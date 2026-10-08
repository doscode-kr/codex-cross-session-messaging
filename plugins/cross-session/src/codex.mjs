import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { CrossSessionError } from './errors.mjs';

const execute = promisify(execFile);
function npmBinary(entry) {
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = process.platform === 'win32' ? `${architecture}-pc-windows-msvc` : process.platform === 'darwin' ? `${architecture}-apple-darwin` : `${architecture}-unknown-linux-musl`;
  const packageName = `@openai/codex-${process.platform}-${process.arch}`;
  const require = createRequire(entry);
  let vendor;
  try { vendor = join(dirname(require.resolve(`${packageName}/package.json`)), 'vendor'); }
  catch { vendor = join(dirname(entry), '..', 'vendor'); }
  const executable = join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  return existsSync(executable) ? { command: executable, args: [] } : null;
}
export function resolveCodex(env = process.env) {
  // Resolve native npm binaries so process shutdown owns the real child.
  // Never put executable paths or message bodies into a shell command.
  if (env.CROSS_SESSION_CODEX_BIN) {
    const file = env.CROSS_SESSION_CODEX_BIN;
    if (!isAbsolute(file) || /\.(cmd|ps1|bat)$/i.test(file)) throw new CrossSessionError('INVALID_CODEX_BIN', 'CROSS_SESSION_CODEX_BIN must be an absolute executable or .js path.');
    return /\.[cm]?js$/i.test(file) ? (npmBinary(file) ?? { command: process.execPath, args: [file] }) : { command: file, args: [] };
  }
  // A copied Windows environment is a case-sensitive JS object with a Path key.
  const searchPath = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const dir of searchPath.split(delimiter).filter(Boolean)) {
    const binary = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(binary)) {
      const actual = realpathSync(binary);
      return /\.[cm]?js$/i.test(actual) ? (npmBinary(actual) ?? { command: binary, args: [] }) : { command: binary, args: [] };
    }
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return npmBinary(entry) ?? { command: process.execPath, args: [entry] };
  }
  const daemonBinary = join(env.CODEX_HOME || join(homedir(), '.codex'), 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (existsSync(daemonBinary)) return { command: daemonBinary, args: [] };
  throw new CrossSessionError('CODEX_NOT_FOUND', 'Install Codex CLI or set CROSS_SESSION_CODEX_BIN.');
}
export async function daemonInfo() {
  const bin = resolveCodex();
  const { stdout } = await execute(bin.command, [...bin.args, 'app-server', 'daemon', 'version'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
