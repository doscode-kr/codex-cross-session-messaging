import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../plugins/cross-session/src/store.mjs';
import { MessagingService } from '../plugins/cross-session/src/service.mjs';
import { WorkState } from '../plugins/cross-session/src/work-state.mjs';
import { runHook } from '../plugins/cross-session/src/hooks.mjs';
import { temporary, FakeNative } from './helpers.mjs';

const env = { CROSS_SESSION_CONTINUATION: '1' };
const request = { action: 'start', expected_revision: 0, objective: 'Finish the requested change', scope: 'The assigned files', completion_criteria: 'Reviewed code and passing checks', next_action: 'Run the checks' };

test('service work reports and packaged hook policy preserve the one-continuation boundary', async t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  const work = new WorkState(root, { enabled: true });
  const service = new MessagingService(store, new FakeNative(), work);
  const client = { hook: (...args) => service.hook(...args) };
  const stop = { session_id: 'session-a', hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false };
  await service.call('set_work_state', request, 'session-a');
  assert.equal((await runHook(stop, client, env)).decision, 'block');
  assert.deepEqual(await runHook({ ...stop, turn_id: 'turn-2', stop_hook_active: true }, client, env), {});
  assert.equal((await service.call('get_work_state', {}, 'session-a')).continuation.used, 1);
  await service.call('set_work_state', { ...request, expected_revision: 1 }, 'session-a');
  assert.deepEqual(await runHook({ ...stop, turn_id: 'turn-3' }, client, env), {});
  await service.call('set_work_state', { action: 'update', expected_revision: 2, status: 'completed', completion_evidence: 'Checks passed and independent review completed' }, 'session-a');
  assert.deepEqual(await runHook(stop, client, env), {});
  assert.equal((await service.call('get_work_state', {}, 'session-b')).state, null);
});

test('a first Interrupt prevents a later initial declaration from blocking Stop', async t => {
  let store;
  const root = temporary(t, () => store?.close());
  store = new Store(root);
  const service = new MessagingService(store, new FakeNative(), new WorkState(root, { enabled: true }));
  const client = { hook: (...args) => service.hook(...args) };
  await runHook({ session_id: 'session-a', hook_event_name: 'Interrupt' }, client, env);
  await service.call('set_work_state', request, 'session-a');
  assert.deepEqual(await runHook({ session_id: 'session-a', hook_event_name: 'Stop', turn_id: 'late-turn', stop_hook_active: false }, client, env), {});
  assert.equal((await service.call('get_work_state', {}, 'session-a')).continuation.revoked, true);
});
