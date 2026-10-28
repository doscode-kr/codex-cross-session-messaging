import { settings } from './client.mjs';
import { CrossSessionError } from './errors.mjs';
import { callerIdentity, validateTool } from './mcp.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { readChainingHooks } from './chaining-diagnostics.mjs';

export const chainingHelp = `Session chaining

  chain link --session UUID --chain-id ID [--source-session-id UUID]
  chain status --session UUID
  chain unlink --session UUID --expected-chain-id ID --expected-checkpoint-id UUID_OR_none
  chain relink --session UUID --tombstone-id UUID --chain-id ID [--source-session-id UUID]
  chain launch --chain-id ID --source-session-id UUID [--codex-js ABSOLUTE_PATH] [--cwd PATH] -- [CODEX_OPTIONS]
  chain doctor [--cwd PATH]

CODEX_THREAD_ID can replace --session, except for launch.
launch is unavailable: the shared daemon cannot receive a child-only ticket.
It returns CHAINING_LAUNCH_UNSUPPORTED without creating a ticket or process.
Use an exact source UUID with a saved checkpoint. Do not put secrets in work state.
`;
const methods = { link: 'link_chain', status: 'get_chain', unlink: 'unlink_chain', relink: 'relink_chain' };
const invalid = message => new CrossSessionError('INVALID_ARGUMENT', message);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const valueOptions = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '--local-provider', '-i', '--image']);
const flagOptions = new Set(['--no-alt-screen', '--no-daemon', '--search', '--oss', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']);
function validateLaunchOptions(tokens) {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], separator = token.indexOf('=');
    const key = separator < 0 ? token : token.slice(0, separator);
    if (flagOptions.has(key) && separator < 0) continue;
    if (!valueOptions.has(key)) throw invalid('Only supported new-session options are allowed after --. Use chain --help.');
    const value = separator < 0 ? tokens[++index] : token.slice(separator + 1);
    if (!value || (separator < 0 && value.startsWith('-'))) throw invalid('The Codex option requires a value.');
  }
}

export async function runChainingCli(tokens, { env = process.env, Chain, diagnose = readChainingHooks } = {}) {
  const [command, ...rest] = tokens;
  if (!command || command === '--help') return { help: chainingHelp };
  if (!Object.hasOwn(methods, command) && !['launch', 'doctor'].includes(command)) throw invalid('Unknown chain command. Use chain --help.');
  const delimiter = rest.indexOf('--');
  if (delimiter >= 0 && command !== 'launch') throw invalid('Only chain launch accepts Codex arguments after --.');
  const options = delimiter < 0 ? rest : rest.slice(0, delimiter);
  const childArgs = delimiter < 0 ? [] : rest.slice(delimiter + 1);
  const { args, sessionId } = parseCliArgs(options, env.CODEX_THREAD_ID);
  if (['launch', 'doctor'].includes(command) && options.some(token => /^--session(?:=|$)/.test(token))) throw invalid('This command does not accept --session.');
  if (command === 'doctor') {
    if (Object.keys(args).some(key => key !== 'cwd')) throw invalid('chain doctor accepts only --cwd.');
    const hooks = await diagnose({ cwd: args.cwd ?? process.cwd() });
    let storage;
    try {
      const config = settings(env, { create: false });
      Chain ??= (await import('./chaining.mjs')).Chaining;
      storage = { status: 'available', ...await new Chain(config.root).usage() };
    } catch (error) {
      storage = error.code === 'ENOENT' ? { status: 'empty' } : { status: 'unavailable', reason: /^CHAINING_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'CHAINING_UNAVAILABLE' };
    }
    return { hooks, storage };
  }
  let caller;
  if (command === 'launch') {
    if (Object.keys(args).some(key => !['chain_id', 'source_session_id', 'codex_js', 'cwd'].includes(key)) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(args.chain_id ?? '') || !uuid(args.source_session_id)) {
      throw invalid('launch requires a chain ID and a full source session UUID.');
    }
    // Check every option so a subcommand cannot follow global options.
    validateLaunchOptions(childArgs);
    throw new CrossSessionError('CHAINING_LAUNCH_UNSUPPORTED', 'The shared Codex daemon does not receive a ticket from the new CLI process environment. No session or ticket was created. See docs/CHAINING.md.');
  } else {
    validateTool(methods[command], args);
    caller = callerIdentity({}, { CODEX_THREAD_ID: sessionId });
    if (!uuid(caller)) throw invalid('Chaining requires a full session UUID.');
    if ((args.chain_id !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(args.chain_id)) ||
        (args.source_session_id !== undefined && !uuid(args.source_session_id)) ||
        (args.tombstone_id !== undefined && !uuid(args.tombstone_id)) ||
        (args.expected_chain_id !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(args.expected_chain_id)) ||
        (args.expected_checkpoint_id !== undefined && args.expected_checkpoint_id !== 'none' && !uuid(args.expected_checkpoint_id))) {
      throw invalid('Use a valid chain ID and full session or checkpoint UUIDs.');
    }
  }
  let config;
  try { config = settings(env, { create: command !== 'status' }); }
  catch (error) {
    if (command === 'status' && error.code === 'ENOENT') return { status: 'unbound', reason: 'STORAGE_NOT_INITIALIZED',
      relationship: { receiving_session_id: caller }, binding: null, tombstone: null };
    throw error;
  }
  Chain ??= (await import('./chaining.mjs')).Chaining;
  const chain = new Chain(config.root);
  const { detail, ...input } = args;
  if (command === 'status') return chain.status(caller);
  if (command === 'link') return chain.bind(caller, input);
  if (command === 'relink') return chain.relink(caller, input);
  if (command === 'unlink') return chain.unlink(caller, { ...input, expected_checkpoint_id: input.expected_checkpoint_id === 'none' ? null : input.expected_checkpoint_id });
}
