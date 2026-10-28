import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { temporary } from './helpers.mjs';
import { runHook, runChainingHook, writeHookOutput } from '../plugins/cross-session/src/hooks.mjs';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';

const owner = '12345678-0000-4000-8000-000000000001';
function fixture(t, rows = []) {
  const cwd = temporary(t), path = join(cwd, 'transcript.jsonl');
  writeFileSync(path, [JSON.stringify({ type: 'session_meta', payload: { id: owner, cwd } }), ...rows].join('\n') + '\n');
  return { session_id: owner, transcript_path: path, cwd };
}
const user = (text, timestamp = '2026-10-28T00:00:01.000Z') => JSON.stringify({ type: 'response_item', timestamp,
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const broker = { async hook() { return {}; } };
const active = project => ({ status: 'active', reason: 'SESSION_ACTIVE', session: { owner, project, state: 'active', reset_at: null } });
const empty = project => ({ status: 'empty', reason: 'NO_CHECKPOINT', relationship: { receiving_session_id: owner, project }, checkpoint: null, path: null });

test('save hooks register only their verified UUID and project', async t => {
  const input = fixture(t, [user('ORIGINAL_REQUEST')]), saves = [], registrations = [];
  const chaining = {
    status: async (id, { project }) => ({ status: 'absent', reason: 'NO_SESSION', session: null, id, project }),
    ensureOwnSession: async (id, { project }) => { registrations.push({ id, project }); return active(project); },
    checkpoint: async (id, value) => { saves.push({ id, ...value }); return { status: value.event === 'SessionEnd' ? 'closed' : 'saved', warnings: [] }; }
  };
  let gitReads = 0;
  for (const event of ['Stop', 'PreCompact', 'SessionEnd']) {
    await runHook({ ...input, hook_event_name: event, last_assistant_message: 'final turn' }, broker, {}, {
      chaining, resolveProject: async () => input.cwd, readGit: async () => { gitReads++; return null; }
    });
  }
  assert.deepEqual(saves.map(value => value.event), ['Stop', 'PreCompact', 'SessionEnd']);
  assert.ok(saves.every(value => value.id === owner && value.project === input.cwd));
  assert.equal(registrations.length, 3);
  assert.equal(gitReads, 2);
  assert.equal(saves[0].automatic.original_request.text, 'ORIGINAL_REQUEST');
  assert.equal(saves[0].automatic.original_request.provenance, 'observed_user_record');
  assert.equal(saves[2].automatic.git, null);
});

test('closed SessionEnd is not reopened by a duplicate hook', async t => {
  const input = fixture(t), calls = [];
  const chaining = {
    status: async () => ({ status: 'closed', reason: 'SESSION_CLOSED', session: { owner, project: input.cwd, state: 'closed', reset_at: null } }),
    ensureOwnSession: () => assert.fail('a duplicate SessionEnd must not reopen the session'),
    checkpoint: async (id, value) => { calls.push({ id, value }); return { status: 'closed', reason: 'SESSION_ALREADY_CLOSED', warnings: [] }; }
  };
  const result = await runChainingHook({ ...input, hook_event_name: 'SessionEnd' }, {}, { chaining, resolveProject: async () => input.cwd });
  assert.equal(result.status, 'closed');
  assert.equal(calls.length, 1);
});

test('subagent hooks never read, register, restore or save', async () => {
  const fail = () => assert.fail('subagent must return before work');
  for (const event of ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']) {
    assert.deepEqual(await runHook({ hook_event_name: event, agent_id: 'child' }, { hook: fail }, {}, { readTranscript: fail }), {});
  }
});

test('mismatched transcript refuses restore and checkpoint writes', async t => {
  const input = { ...fixture(t), session_id: '12345678-0000-4000-8000-000000000002' };
  const fail = () => assert.fail('identity mismatch must fail before continuity storage');
  for (const event of ['SessionStart', 'Stop', 'PreCompact', 'SessionEnd']) {
    const result = await runChainingHook({ ...input, hook_event_name: event }, {}, { chaining: { ensureOwnSession: fail, status: fail, restore: fail, checkpoint: fail } });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'CHAINING_TRANSCRIPT_MISMATCH');
  }
});

test('a different project is rejected before continuity storage', async t => {
  const input = fixture(t), other = temporary(t);
  const fail = () => assert.fail('project mismatch must fail before continuity storage');
  const result = await runChainingHook({ ...input, cwd: other, hook_event_name: 'SessionStart', source: 'startup' }, {}, {
    chaining: { ensureOwnSession: fail, restore: fail }
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'CHAINING_PROJECT_MISMATCH');
});

test('SessionStart automatically creates and restores only its own session', async t => {
  const input = fixture(t), calls = [];
  const chaining = {
    ensureOwnSession: async (id, args) => { calls.push(['ensure', id, args]); return { status: 'created', reason: 'SESSION_CREATED', session: { owner: id, project: args.project, reset_at: null } }; },
    restore: async (id, args) => { calls.push(['restore', id, args]); return empty(args.project); },
    bind: () => assert.fail('binding must not be used'), claimTicket: () => assert.fail('tickets must not be used')
  };
  const result = await runChainingHook({ ...input, hook_event_name: 'SessionStart', source: 'startup' }, { CROSS_SESSION_CHAIN_TICKET: 'ignored' }, {
    chaining, resolveProject: async () => input.cwd
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.lifecycle, 'startup');
  assert.deepEqual(calls.map(value => value[0]), ['ensure', 'restore']);
  assert.match(result.context, /Cross-session session continuity hook attached/);
  assert.doesNotMatch(JSON.stringify(result), /ignored/);
});

test('clear resets the same session before an empty restore', async t => {
  const input = fixture(t), calls = [];
  const chaining = {
    ensureOwnSession: async () => { calls.push('ensure'); return active(input.cwd); },
    reset: async () => { calls.push('reset'); return { status: 'reset', reason: 'SESSION_RESET', session: { owner, project: input.cwd, reset_at: '2026-10-28T00:00:00.000Z' } }; },
    restore: async () => { calls.push('restore'); return empty(input.cwd); }
  };
  const result = await runChainingHook({ ...input, hook_event_name: 'SessionStart', source: 'clear' }, {}, { chaining, resolveProject: async () => input.cwd });
  assert.deepEqual(calls, ['ensure', 'reset', 'restore']);
  assert.equal(result.reset.reason, 'SESSION_RESET');
  assert.equal(result.reason, 'NO_CHECKPOINT');
});

test('missing storage is initialized without reading legacy bindings or tickets', async t => {
  const input = fixture(t), state = join(input.cwd, 'state'), legacy = join(state, 'chaining-v1');
  mkdirSync(legacy, { recursive: true });
  const legacyPath = join(legacy, 'state.json'), legacyBytes = '{"private":"legacy-binding-ticket"}';
  writeFileSync(legacyPath, legacyBytes);
  const result = await runChainingHook({ ...input, hook_event_name: 'SessionStart', source: 'startup' }, {}, {
    chaining: new SessionContinuity(state), resolveProject: async () => input.cwd
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.registration.status, 'created');
  assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes);
  assert.equal(existsSync(join(state, 'session-continuity-v1', 'state.json')), true);
});

test('restore failure retains only verified receiver and project', async t => {
  const input = fixture(t);
  const result = await runChainingHook({ ...input, hook_event_name: 'SessionStart', source: 'resume' }, {}, { chaining: {
    ensureOwnSession: async () => active(input.cwd),
    restore: async () => { throw Object.assign(Error('private checkpoint content'), { code: 'CHAINING_UNAVAILABLE' }); }
  }, resolveProject: async () => input.cwd });
  assert.deepEqual(result, { status: 'storage_error', reason: 'CHAINING_UNAVAILABLE', lifecycle: 'resume',
    relationship: { receiving_session_id: owner, project: input.cwd } });
});

test('SessionStart displays continuity and project guidance when broker registration fails', async t => {
  const input = fixture(t);
  const result = await runHook({ ...input, hook_event_name: 'SessionStart', source: 'startup' }, { hook: async () => { throw Error('PRIVATE_ERROR'); } }, {}, {
    chaining: { ensureOwnSession: async () => active(input.cwd), restore: async () => empty(input.cwd) },
    resolveProject: async () => input.cwd,
    runProjectGuidance: async () => ({ status: 'loaded', context: '<cross-session-project-guidance>GUIDANCE</cross-session-project-guidance>' })
  });
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /Cross-session session continuity hook attached/);
  assert.match(context, /"status":"empty"/);
  assert.match(context, /GUIDANCE/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
});

test('continuity storage errors do not suppress messaging Stop continuation', async t => {
  const input = { ...fixture(t), hook_event_name: 'Stop', turn_id: 'turn', stop_hook_active: false };
  const result = await runHook(input, { hook: async () => ({ stopPolicy: { version: 1, decision: 'continue_work', reasonCode: 'WORK_REMAINING', generation: owner, turnId: 'turn' } }) }, { CROSS_SESSION_CONTINUATION: '1' }, {
    chaining: { status: async () => active(input.cwd), checkpoint: async () => { throw Error('PRIVATE_PATH'); } },
    resolveProject: async () => input.cwd, readGit: async () => null
  });
  assert.equal(result.decision, 'block');
  assert.ok(!result.reason.includes('PRIVATE_PATH'));
});

test('broker hook calls receive one total budget for their complete request sequence', async t => {
  const input = fixture(t), budgets = [];
  const client = { async hook(_value, _project, options) { budgets.push(options.totalTimeoutMs); return {}; } };
  const chaining = {
    ensureOwnSession: async () => active(input.cwd),
    restore: async () => empty(input.cwd),
    status: async () => active(input.cwd),
    checkpoint: async () => ({ status: 'saved', reason: 'CHECKPOINT_SAVED', warnings: [] })
  };
  const dependencies = { chaining, resolveProject: async () => input.cwd, readGit: async () => null,
    runProjectGuidance: async () => ({ status: 'skipped' }) };
  await runHook({ ...input, hook_event_name: 'SessionStart', source: 'startup' }, client, {}, dependencies);
  await runHook({ ...input, hook_event_name: 'UserPromptSubmit' }, client, {}, dependencies);
  await runHook({ ...input, hook_event_name: 'Stop', turn_id: 'turn', stop_hook_active: false }, client, {}, dependencies);
  assert.deepEqual(budgets, [5000, 3000, 1800]);
});

test('hook command definitions keep all lifecycle events', () => {
  const hooks = JSON.parse(readFileSync('plugins/cross-session/hooks/hooks.json', 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Interrupt', 'PreCompact']);
  const command = `node -e "import(require('node:url').pathToFileURL(require('node:path').join(process.env.PLUGIN_ROOT,'src/hooks.mjs')).href).then(m=>m.main())"`;
  for (const [event, groups] of Object.entries(hooks)) {
    assert.deepEqual(groups, [{ hooks: [{ type: 'command', command, timeout: event === 'SessionStart' ? 10 : 5 }] }]);
  }
});

test('save warnings and refusal codes are visible without private text', async t => {
  const input = { ...fixture(t), hook_event_name: 'PreCompact' }, lines = [];
  t.mock.method(console, 'error', value => lines.push(value));
  for (const result of [{ status: 'saved', warnings: ['PRIVATE_PATH'] }, { status: 'storage_error', reason: 'CHAINING_BUSY' }]) {
    const chaining = { status: async () => active(input.cwd), checkpoint: async () => {
      if (result.reason) throw Object.assign(Error('PRIVATE_PATH'), { code: result.reason });
      return result;
    } };
    assert.deepEqual(await runHook(input, broker, {}, { chaining, resolveProject: async () => input.cwd, readGit: async () => null }), {});
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /checkpoint saved/);
  assert.equal(lines[1], 'cross-session continuity: CHAINING_BUSY.');
  assert.ok(lines.every(line => !line.includes('PRIVATE_PATH')));
});

test('output completion does not mutate restored continuity state', async t => {
  const input = fixture(t), restores = [];
  const chaining = {
    ensureOwnSession: async () => active(input.cwd),
    restore: async () => {
      restores.push('restore');
      return { status: 'restored', reason: 'CHECKPOINT_LOADED', relationship: { receiving_session_id: owner, project: input.cwd },
        checkpoint: { id: 'checkpoint', owner, project: input.cwd, original_request: null, original_request_reason: 'NOT_AVAILABLE', recent_messages: [], git: null, structured: null } };
    },
    confirmRestore: () => assert.fail('session-local restore has no consume confirmation')
  };
  const output = await runHook({ ...input, hook_event_name: 'SessionStart' }, broker, {}, { chaining, resolveProject: async () => input.cwd });
  assert.equal(await writeHookOutput(output, new Writable({ write(chunk, encoding, callback) { callback(); } })), null);
  assert.deepEqual(restores, ['restore']);
});

test('failed output write does not trigger another continuity operation', async t => {
  const input = fixture(t), operations = [];
  const chaining = {
    ensureOwnSession: async () => { operations.push('ensure'); return active(input.cwd); },
    restore: async () => { operations.push('restore'); return empty(input.cwd); }
  };
  const output = await runHook({ ...input, hook_event_name: 'SessionStart' }, broker, {}, { chaining, resolveProject: async () => input.cwd });
  const stream = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(Error('write failed'), { code: 'EPIPE' })); } });
  await assert.rejects(writeHookOutput(output, stream), { code: 'EPIPE' });
  assert.deepEqual(operations, ['ensure', 'restore']);
});
