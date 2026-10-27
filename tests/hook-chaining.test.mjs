import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { runHook, runChainingHook } from '../plugins/cross-session/src/hooks.mjs';

const owner = '12345678-0000-4000-8000-000000000001';
function fixture(t) {
  const path = join(temporary(t), 'transcript.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: owner } }) + '\n');
  return { session_id: owner, transcript_path: path };
}
const broker = { async hook() { return {}; } };

test('each save hook saves only verified identity and SessionEnd skips git and cleanup', async t => {
  const input = fixture(t), saves = [];
  const chaining = { checkpoint: async (id, value) => { saves.push({ id, ...value }); return { status: 'saved' }; } };
  let gitReads = 0;
  for (const event of ['Stop', 'PreCompact', 'SessionEnd']) {
    await runHook({ ...input, hook_event_name: event, last_assistant_message: 'final turn' }, broker, {}, { chaining, readGit: async () => { gitReads++; return null; } });
  }
  assert.deepEqual(saves.map(value => value.event), ['Stop', 'PreCompact', 'SessionEnd']);
  assert.ok(saves.every(value => value.id === owner));
  assert.equal(gitReads, 2);
  assert.equal(saves[2].skip_cleanup, true);
  assert.deepEqual(saves[0].automatic.messages, [{ role: 'assistant', text: 'final turn' }]);
});

test('subagent hooks never read, claim, restore or save', async () => {
  const fail = () => assert.fail('subagent must return before work');
  for (const event of ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']) {
    assert.deepEqual(await runHook({ hook_event_name: event, agent_id: 'child' }, { hook: fail }, {}, { readTranscript: fail }), {});
  }
});

test('mismatched transcript refuses source injection and checkpoint writes', async t => {
  const input = { ...fixture(t), session_id: '12345678-0000-4000-8000-000000000002' };
  const fail = () => assert.fail('identity mismatch must fail closed');
  const chaining = { claimTicket: fail, restore: fail, checkpoint: fail };
  for (const event of ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']) {
    const result = await runChainingHook({ ...input, hook_event_name: event }, { CROSS_SESSION_CHAIN_TICKET: 'ticket' }, { chaining });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'CHAINING_TRANSCRIPT_MISMATCH');
  }
});

test('ticket denials never restore source context', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' };
  for (const status of ['expired', 'consumed', 'mismatch', 'missing_ticket', 'invalid_ticket']) {
    const result = await runChainingHook(input, { CROSS_SESSION_CHAIN_TICKET: 'ticket' }, { chaining: {
      claimTicket: async () => ({ status }), restore: () => assert.fail('denied ticket must not restore')
    } });
    assert.deepEqual(result, { status: 'rejected', ticket_status: status });
  }
});

test('SessionStart always displays attachment and status even when the broker is unavailable', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' };
  for (const status of ['unbound', 'bound_no_notes', 'restored', 'unlinked']) {
    const result = await runHook(input, { hook: async () => { throw Error('PRIVATE_ERROR'); } }, {}, { chaining: { restore: async () => ({ status }) } });
    assert.match(result.hookSpecificOutput.additionalContext, /Cross-session chaining hook attached/);
    assert.match(result.hookSpecificOutput.additionalContext, new RegExp(status));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
  }
});

test('chaining storage errors do not suppress existing messaging or Stop continuation', async t => {
  const input = { ...fixture(t), hook_event_name: 'Stop', turn_id: 'turn', stop_hook_active: false };
  const result = await runHook(input, { hook: async () => ({ stopPolicy: { version: 1, decision: 'continue_work', reasonCode: 'WORK_REMAINING', generation: owner, turnId: 'turn' } }) }, { CROSS_SESSION_CONTINUATION: '1' }, {
    chaining: { checkpoint: async () => { throw Error('PRIVATE_PATH'); } }, readGit: async () => null
  });
  assert.equal(result.decision, 'block');
  assert.ok(!result.reason.includes('PRIVATE_PATH'));
});

test('new hook event is appended without changing existing command definitions or positions', () => {
  const hooks = JSON.parse(readFileSync('plugins/cross-session/hooks/hooks.json', 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Interrupt', 'PreCompact']);
  const command = `node -e "import(require('node:url').pathToFileURL(require('node:path').join(process.env.PLUGIN_ROOT,'src/hooks.mjs')).href).then(m=>m.main())"`;
  for (const [event, groups] of Object.entries(hooks)) {
    assert.deepEqual(groups, [{ hooks: [{ type: 'command', command, timeout: event === 'SessionStart' ? 10 : 3 }] }]);
  }
});

test('save warnings and refusal codes are visible without private text', async t => {
  const input = { ...fixture(t), hook_event_name: 'PreCompact' }, lines = [];
  t.mock.method(console, 'error', value => lines.push(value));
  for (const result of [{ status: 'saved', warnings: ['PRIVATE_PATH'] }, { status: 'storage_error', reason: 'CHAINING_BUSY' }]) {
    const chaining = { checkpoint: async () => {
      if (result.reason) throw Object.assign(Error('PRIVATE_PATH'), { code: result.reason });
      return result;
    } };
    assert.deepEqual(await runHook(input, broker, {}, { chaining, readGit: async () => null }), {});
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /checkpoint saved; retention/);
  assert.equal(lines[1], 'cross-session chaining: CHAINING_BUSY.');
  assert.ok(lines.every(line => !line.includes('PRIVATE_PATH')));
});
