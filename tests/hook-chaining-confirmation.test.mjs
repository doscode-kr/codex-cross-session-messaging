import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { temporary } from './helpers.mjs';
import { SessionContinuity } from '../plugins/cross-session/src/chaining.mjs';
import { runHook, writeHookOutput } from '../plugins/cross-session/src/hooks.mjs';

const owner = '12345678-0000-4000-8000-000000000001';

test('writing restored context never confirms, consumes, or deletes the own-session checkpoint', async t => {
  const project = temporary(t);
  const state = temporary(t);
  const transcript = join(project, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: owner, cwd: project } }) + '\n');

  const continuity = new SessionContinuity(state);
  await continuity.ensureOwnSession(owner, { project });
  const saved = await continuity.checkpoint(owner, {
    project,
    event: 'PreCompact',
    automatic: {
      original_request: {
        role: 'user',
        text: 'OWN_SESSION_MARKER',
        provenance: 'observed_user_record',
        observed_at: '2026-10-28T00:00:01.000Z'
      },
      original_request_reason: 'OBSERVED',
      recent_messages: [],
      git: null
    }
  });
  const input = { session_id: owner, transcript_path: transcript, cwd: project, hook_event_name: 'SessionStart', source: 'compact' };
  const output = await runHook(input, { async hook() { return {}; } }, {}, {
    chaining: continuity,
    resolveProject: async () => project,
    runProjectGuidance: async () => ({ status: 'skipped' })
  });
  assert.match(output.hookSpecificOutput.additionalContext, /OWN_SESSION_MARKER/);

  const failed = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('closed'), { code: 'EPIPE' })); } });
  await assert.rejects(writeHookOutput(output, failed), { code: 'EPIPE' });
  const afterFailure = await continuity.restore(owner, { project });
  assert.equal(afterFailure.relationship.checkpoint_id, saved.checkpoint_id);

  let written = '';
  const success = new Writable({ write(chunk, encoding, callback) { written += chunk; callback(); } });
  await writeHookOutput(output, success);
  assert.match(written, /OWN_SESSION_MARKER/);
  const afterSuccess = await continuity.restore(owner, { project });
  assert.equal(afterSuccess.relationship.checkpoint_id, saved.checkpoint_id);
});
