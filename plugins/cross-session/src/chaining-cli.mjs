import { settings } from './client.mjs';
import { CrossSessionError } from './errors.mjs';
import { callerIdentity, validateTool } from './mcp.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { readSessionContinuityHooks } from './chaining-diagnostics.mjs';

export const chainingHelp = `Session-local continuity

  chain status --session UUID
  chain doctor [--cwd PATH]

CODEX_THREAD_ID can replace --session for status.
Continuity saves and restores only the calling session.
Manual link, relink, unlink, and launch commands are unavailable.
`;
const legacyCommands = new Set(['link', 'unlink', 'relink', 'launch']);
const invalid = message => new CrossSessionError('INVALID_ARGUMENT', message);
const sessionLocalOnly = () => new CrossSessionError('CHAINING_SESSION_LOCAL_ONLY', 'Session continuity only saves and restores the calling session. Manual linking and launch are unavailable.');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export async function runChainingCli(tokens, { env = process.env, Chain, diagnose = readSessionContinuityHooks } = {}) {
  const [command, ...rest] = tokens;
  if (!command || command === '--help') return { help: chainingHelp };
  if (legacyCommands.has(command)) throw sessionLocalOnly();
  if (!['status', 'doctor'].includes(command)) throw invalid('Unknown chain command. Use chain --help.');
  if (rest.includes('--')) throw invalid('Session-local continuity commands do not accept arguments after --.');
  const { args, sessionId } = parseCliArgs(rest, env.CODEX_THREAD_ID);
  if (command === 'doctor') {
    if (rest.some(token => /^--session(?:=|$)/.test(token))) throw invalid('chain doctor does not accept --session.');
    if (Object.keys(args).some(key => key !== 'cwd')) throw invalid('chain doctor accepts only --cwd.');
    const hooks = await diagnose({ cwd: args.cwd ?? process.cwd() });
    let storage;
    try {
      const config = settings(env, { create: false });
      Chain ??= (await import('./chaining.mjs')).SessionContinuity;
      storage = { status: 'available', ...await new Chain(config.root).usage() };
    } catch (error) {
      storage = error.code === 'ENOENT' ? { status: 'empty' } : { status: 'unavailable', reason: /^CHAINING_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'CHAINING_UNAVAILABLE' };
    }
    return { hooks, storage };
  }
  validateTool('get_chain', args);
  const caller = callerIdentity({}, { CODEX_THREAD_ID: sessionId });
  if (!uuid(caller)) throw invalid('Session continuity requires a full session UUID.');
  let config;
  try { config = settings(env, { create: false }); }
  catch (error) {
    if (error.code === 'ENOENT') return { mode: 'session_local', owner: caller, status: 'absent', reason: 'NO_SESSION', session: null };
    throw error;
  }
  Chain ??= (await import('./chaining.mjs')).SessionContinuity;
  return { ...await new Chain(config.root).status(caller, {}), mode: 'session_local', owner: caller };
}
