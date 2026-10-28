import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { chainingError } from './chaining-store.mjs';

const execute = promisify(execFile);
const notRepository = 'fatal: not a git repository (or any of the parent directories): .git';

function gitEnvironment(env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/iu.test(key) && !/^(LC_ALL|LANG|LANGUAGE)$/iu.test(key))),
    LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C'
  };
}

function inside(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

async function locate(cwd, env) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw chainingError('PROJECT_UNAVAILABLE', 'The session project path must be absolute.');
  let actual;
  try { actual = await realpath(cwd); }
  catch { throw chainingError('PROJECT_UNAVAILABLE', 'The session project path is not available.'); }
  try {
    const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: actual, env: gitEnvironment(env), windowsHide: true, timeout: 1200, maxBuffer: 64 * 1024
    });
    const value = stdout.trim();
    if (!isAbsolute(value)) throw chainingError('PROJECT_UNAVAILABLE', 'Git returned an invalid worktree root.');
    const project = await realpath(value);
    if (!inside(project, actual)) throw chainingError('PROJECT_UNAVAILABLE', 'Git returned a worktree root outside the session path.');
    return { kind: 'git', cwd: actual, project };
  } catch (error) {
    if (error?.code?.startsWith?.('CHAINING_')) throw error;
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.stderr?.toString('utf8') ?? '';
    if (error.code === 128 && stderr.trim().split(/\r?\n/u, 1)[0] === notRepository) return { kind: 'directory', cwd: actual, project: actual };
    throw chainingError('PROJECT_UNAVAILABLE', 'The session project could not be verified.');
  }
}

export async function resolveSessionProject(inputCwd, transcriptCwd, env = process.env) {
  const [input, transcript] = await Promise.all([locate(inputCwd, env), locate(transcriptCwd, env)]);
  const same = process.platform === 'win32'
    ? input.project.toLowerCase() === transcript.project.toLowerCase()
    : input.project === transcript.project;
  if (input.kind !== transcript.kind || !same) throw chainingError('PROJECT_MISMATCH', 'The hook and transcript do not identify the same project.');
  if (input.kind === 'directory') {
    const sameDirectory = process.platform === 'win32'
      ? input.cwd.toLowerCase() === transcript.cwd.toLowerCase()
      : input.cwd === transcript.cwd;
    if (!sameDirectory) throw chainingError('PROJECT_MISMATCH', 'Non-Git session paths must identify the same directory.');
  }
  return input.project;
}
