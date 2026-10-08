#!/usr/bin/env node
import { BrokerClient } from './client.mjs';
import { NativeAdapter } from './native.mjs';
import { validateTool } from './mcp.mjs';
import { errorData } from './errors.mjs';

const [command, ...rest] = process.argv.slice(2);
const help = `Cross Session CLI\n\n  doctor                          Check the real daemon without sending messages\n  broker-stop                     Stop the local broker (no daemon restart)\n  list_agents --session UUID      List sessions\n  claim_leader --session UUID     Claim the single leader role\n  send_message --session UUID --to UUID --message TEXT [--notify-when-idle]\n  reply --session UUID --message-id ID --message TEXT\n\nAny MCP tool name also works here. CODEX_THREAD_ID can replace --session.\nUse the MCP tools inside Codex when possible.\n`;
try {
  if (!command || command === '--help') { console.log(help); }
  else if (command === 'doctor') {
    const native = new NativeAdapter();
    try {
      const agents = await native.list();
      console.log(JSON.stringify({ ok: true, transport: 'immediate-only', daemon: native.info, agents: agents.map(t => ({ id: t.id, status: t.status, cwd: t.cwd, acceptsDirectInput: t.canAcceptDirectInput })) }, null, 2));
    } finally { native.close(); }
  } else {
    const client = new BrokerClient();
    if (command === 'broker-stop') { console.log(JSON.stringify(await client.request('/shutdown', {}))); }
    else {
      const args = {};
      let sessionId = process.env.CODEX_THREAD_ID;
      for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith('--')) throw new Error(`Expected an option, got ${rest[i]}`);
        const key = rest[i].slice(2).replaceAll('-', '_');
        const value = ['notify_when_idle', 'unacknowledged_only', 'detail'].includes(key) ? true : rest[++i];
        if (key === 'session') sessionId = value;
        else args[key] = key === 'limit' ? Number(value) : value;
      }
      validateTool(command, args);
      const { detail, ...brokerArgs } = args;
      console.log(JSON.stringify(await client.call(command, brokerArgs, sessionId), null, 2));
    }
  }
} catch (error) { console.error(JSON.stringify(errorData(error), null, 2)); process.exitCode = 1; }
