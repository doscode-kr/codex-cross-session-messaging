import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { temporary } from './helpers.mjs';
import { runHook, runChainingHook, writeHookOutput } from '../plugins/cross-session/src/hooks.mjs';

const owner = '12345678-0000-4000-8000-000000000001';
function fixture(t) {
  const path = join(temporary(t), 'transcript.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: owner } }) + '\n');
  return { session_id: owner, transcript_path: path };
}
const broker = { async hook() { return {}; } };
const sink = () => new Writable({ write(chunk, encoding, callback) { callback(); } });

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
    assert.deepEqual(result, { status: 'rejected', reason: 'CHAINING_TICKET_REJECTED', ticket_status: status,
      lifecycle: 'unknown', relationship: { receiving_session_id: owner } });
  }
});

test('missing storage is not a failed restore unless an explicit ticket requires it', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart', source: 'startup' };
  const env = { ...process.env, CROSS_SESSION_HOME: join(temporary(t), 'absent') };
  delete env.CROSS_SESSION_CHAIN_TICKET;
  const normal = await runChainingHook(input, env);
  assert.equal(normal.status, 'unbound');
  assert.equal(normal.reason, 'STORAGE_NOT_INITIALIZED');
  assert.equal(normal.lifecycle, 'startup');
  assert.equal(normal.relationship.receiving_session_id, owner);
  const expected = await runChainingHook(input, { ...env, CROSS_SESSION_CHAIN_TICKET: 'private-ticket' });
  assert.equal(expected.status, 'rejected');
  assert.equal(expected.reason, 'CHAINING_TICKET_STORE_MISSING');
  assert.ok(!JSON.stringify(expected).includes('private-ticket'));
  const invalid = await runChainingHook({ ...input, session_id: 'not-a-uuid' }, env);
  assert.equal(invalid.status, 'rejected');
  assert.equal(invalid.reason, 'CHAINING_INVALID_SESSION');
  assert.equal(invalid.relationship, undefined);
});

test('restore failure retains only verified receiver identity and lifecycle', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart', source: 'resume' };
  const result = await runChainingHook(input, {}, { chaining: {
    restore: async () => { throw Object.assign(Error('private checkpoint content'), { code: 'CHAINING_UNAVAILABLE' }); }
  } });
  assert.deepEqual(result, { status: 'storage_error', reason: 'CHAINING_UNAVAILABLE', lifecycle: 'resume',
    relationship: { receiving_session_id: owner } });
});

test('resume without a binding reports absence without inventing a recovery failure', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart', source: 'resume' };
  const result = await runChainingHook(input, {}, { chaining: {
    restore: async () => ({ status: 'unbound', reason: 'NO_BINDING', relationship: { receiving_session_id: owner } })
  } });
  assert.equal(result.status, 'unbound');
  assert.equal(result.reason, 'NO_BINDING');
  assert.equal(result.lifecycle, 'resume');
  assert.match(result.context, /"reason":"NO_BINDING"/);
});

test('context formatting failure carries its reason outside the rendered context', async t => {
  const result = await runChainingHook({ ...fixture(t), hook_event_name: 'SessionStart' }, {}, { chaining: {
    restore: async () => ({ status: 'restored', reason: 'CHECKPOINT_LOADED', path: 'x'.repeat(9000) })
  } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'CHAINING_CONTEXT_TOO_LARGE');
  assert.equal(result.confirmation, undefined);
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

test('pending restore confirms the exact binding only after output completion', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' }, confirmations = [];
  const restored = { status: 'restored', binding: { id: 'binding-id', restore_pending: true },
    checkpoint: { id: 'checkpoint-id', structured: { objective: 'SOURCE_MARKER' } }, path: '/checkpoint' };
  const chaining = {
    restore: async () => restored,
    confirmRestore: async (id, args) => {
      confirmations.push({ id, ...args });
      restored.checkpoint.structured.objective = 'CHANGED_AFTER_PREPARATION';
      return { status: 'confirmed' };
    }
  };
  const result = await runHook(input, broker, {}, { chaining });
  assert.equal(confirmations.length, 0);
  let written;
  const stream = new Writable({ write(chunk, encoding, callback) { written = callback; } });
  const completion = writeHookOutput(result, stream, {}, { chaining });
  assert.equal(confirmations.length, 0);
  written();
  assert.equal((await completion).status, 'confirmed');
  assert.deepEqual(confirmations, [{ id: owner, expected_binding_id: 'binding-id', expected_checkpoint_id: 'checkpoint-id' }]);
  assert.match(result.hookSpecificOutput.additionalContext, /SOURCE_MARKER/);
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /CHANGED_AFTER_PREPARATION/);
});

test('formatting refusal and failure leave the source restore pending', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' };
  const deep = {};
  let entry = deep;
  for (let index = 0; index < 5000; index++) { entry.child = {}; entry = entry.child; }
  for (const malformed of [{ path: 'x'.repeat(9000) }, { checkpoint: { id: 'checkpoint-id', structured: deep } }]) {
    const chaining = {
      restore: async () => ({ status: 'restored', binding: { id: 'binding-id', restore_pending: true },
        checkpoint: { id: 'checkpoint-id', structured: { objective: 'SOURCE_MARKER' } }, ...malformed }),
      confirmRestore: () => assert.fail('unusable context must not consume the pending source')
    };
    const result = await runHook(input, broker, {}, { chaining });
    assert.equal(await writeHookOutput(result, sink(), {}, { chaining }), null);
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /"status":"(?:rejected|storage_error)"/);
    assert.doesNotMatch(context, /SOURCE_MARKER|"status":"restored"/);
  }
});

test('post-output confirmation errors remain visible without an automatic retry', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' };
  for (const code of ['CHAINING_CONFLICT', 'CHAINING_BUSY', null]) {
    let attempts = 0;
    const chaining = {
      restore: async () => ({ status: 'restored', binding: { id: 'binding-id', restore_pending: true },
        checkpoint: { id: 'checkpoint-id', structured: { objective: 'SOURCE_MARKER' } } }),
      confirmRestore: async () => {
        attempts++;
        if (code) throw Object.assign(Error('PRIVATE_CONFIRM_ERROR'), { code });
        return { status: 'unexpected' };
      }
    };
    const result = await runHook(input, broker, {}, { chaining });
    const confirmation = await writeHookOutput(result, sink(), {}, { chaining });
    assert.equal(attempts, 1);
    assert.equal(confirmation.status, code ? 'storage_error' : 'uncertain');
    assert.equal(confirmation.reason, code ?? 'CHAINING_UNAVAILABLE');
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /SOURCE_MARKER/);
    assert.doesNotMatch(context, /PRIVATE_CONFIRM_ERROR/);
  }
});

test('a failed output write does not confirm the prepared restore', async t => {
  const input = { ...fixture(t), hook_event_name: 'SessionStart' };
  const chaining = {
    restore: async () => ({ status: 'restored', binding: { id: 'binding-id', restore_pending: true },
      checkpoint: { id: 'checkpoint-id', structured: { objective: 'SOURCE_MARKER' } } }),
    confirmRestore: () => assert.fail('failed output must not consume the pending source')
  };
  const output = await runHook(input, broker, {}, { chaining });
  const stream = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(Error('write failed'), { code: 'EPIPE' })); } });
  await assert.rejects(writeHookOutput(output, stream, {}, { chaining }), { code: 'EPIPE' });
});
