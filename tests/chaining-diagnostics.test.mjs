import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readChainingHooks, readSessionContinuityHooks } from '../plugins/cross-session/src/chaining-diagnostics.mjs';

const fixture = (eventName, extra = {}) => ({ pluginId: 'cross-session@cross-session-local', eventName, enabled: true, trustStatus: 'trusted', key: `plugin:${eventName}:0:0`, sourcePath: 'plugin/hooks/hooks.json', ...extra });
const all = ['sessionStart', 'sessionEnd', 'userPromptSubmit', 'stop', 'interrupt', 'preCompact'];
const native = hooks => ({ async request(method, params) {
  assert.equal(method, 'hooks/list');
  assert.deepEqual(params, { cwds: [resolve('fixture')] });
  return { data: [{ cwd: resolve('fixture'), hooks }] };
} });

test('legacy diagnostic name aliases session-local continuity diagnostics', () => {
  assert.equal(readChainingHooks, readSessionContinuityHooks);
});

test('hook diagnosis distinguishes configured, trusted, disabled and missing hooks', async () => {
  const hooks = [fixture('sessionStart', { trustStatus: 'untrusted' }), fixture('stop', { enabled: false }),
    fixture('preCompact', { command: 'private command', currentHash: 'private hash' }),
    fixture('sessionEnd', { pluginId: 'other-plugin', trustStatus: 'trusted' })];
  const result = await readChainingHooks({ cwd: 'fixture', native: native(hooks) });
  assert.equal(result.status, 'needs_attention');
  const state = event => result.events.find(item => item.event === event);
  assert.equal(state('SessionStart').configured, true);
  assert.equal(state('SessionStart').ready, false);
  assert.equal(state('SessionStart').hooks[0].trust_status, 'untrusted');
  assert.equal(state('Stop').ready, false);
  assert.equal(state('SessionEnd').configured, false);
  assert.equal(state('PreCompact').ready, true);
  assert.equal(result.execution_confirmed, false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('trusted hooks report readiness without claiming that a hook ran', async () => {
  const result = await readChainingHooks({ cwd: 'fixture', native: native(all.map(event => fixture(event))) });
  assert.equal(result.status, 'ready');
  assert.equal(result.execution_confirmed, false);
  assert.equal(result.events.length, 6);
  const changed = await readChainingHooks({ cwd: 'fixture', native: native(all.map(event => fixture(event, event === 'preCompact' ? { trustStatus: 'needsReview' } : {}))) });
  assert.equal(changed.status, 'needs_attention');
});

test('hook diagnosis fails closed on malformed replies and does not expose error bodies', async () => {
  for (const value of [null, {}, { data: [null] }, { data: [{ hooks: null }] }]) {
    const result = await readChainingHooks({ native: { async request() { return value; } } });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'INVALID_HOOK_RESPONSE');
  }
  const result = await readChainingHooks({ native: { async request() { throw Object.assign(new Error('private body'), { code: 'NATIVE_REJECTED' }); } } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'NATIVE_REJECTED');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
