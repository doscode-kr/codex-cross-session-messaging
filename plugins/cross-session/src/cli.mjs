#!/usr/bin/env node
import { BrokerClient } from './client.mjs';
import { NativeAdapter } from './native.mjs';
import { callerIdentity, validateTool } from './mcp.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { errorData } from './errors.mjs';
import { readBrokerStatus } from './diagnostics.mjs';
import { runChainingCli } from './chaining-cli.mjs';

const [command, ...rest] = process.argv.slice(2);
const help = `Cross Session CLI\n\n  doctor                          Check the real daemon without sending messages\n  broker-status                   Inspect the broker without starting it\n  broker-stop                     Stop the local broker (no daemon restart)\n  chain --help                    Connect sessions and inspect handoffs\n  list_agents --session UUID      List sessions\n  claim_leader --session UUID     Claim the single leader role\n  send_message --session UUID --to UUID --message TEXT [--notify-when-idle] [--request-id UUID]\n  reply --session UUID --message-id ID --message TEXT [--request-id UUID]\n\nAny MCP tool name also works here. CODEX_THREAD_ID can replace --session.\nUse the MCP tools inside Codex when possible.\n`;
try {
  if (!command || command === '--help') { console.log(help); }
  else if (command === 'chain') {
    const result = await runChainingCli(rest);
    console.log(result.help ?? JSON.stringify(result, null, 2));
    if (result.exit_code) process.exitCode = result.exit_code;
  } else if (command === 'broker-status') {
    console.log(JSON.stringify(await readBrokerStatus(), null, 2));
  } else if (command === 'doctor') {
    const native = new NativeAdapter();
    try {
      const agents = await native.list();
      console.log(JSON.stringify({ ok: true, transport: 'immediate-only', daemon: native.info, agents: agents.map(t => ({ id: t.id, status: t.status, cwd: t.cwd, acceptsDirectInput: t.canAcceptDirectInput })) }, null, 2));
    } finally { native.close(); }
  } else {
    if (command === 'broker-stop') { console.log(JSON.stringify(await new BrokerClient().request('/shutdown', {}))); }
    else {
      const { args, sessionId } = parseCliArgs(rest, process.env.CODEX_THREAD_ID);
      validateTool(command, args);
      const caller = callerIdentity({}, { CODEX_THREAD_ID: sessionId });
      const { detail, ...brokerArgs } = args;
      const client = new BrokerClient();
      console.log(JSON.stringify(await client.call(command, brokerArgs, caller), null, 2));
    }
  }
} catch (error) { console.error(JSON.stringify(errorData(error), null, 2)); process.exitCode = 1; }
