import { resolve } from 'node:path';
import { NativeAdapter } from './native.mjs';

const events = {
  SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', UserPromptSubmit: 'userPromptSubmit',
  Stop: 'stop', Interrupt: 'interrupt', PreCompact: 'preCompact'
};
const pluginId = 'cross-session@cross-session-local';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Ask the host for trust. Do not infer trust from a file or write a trust hash.
export async function readSessionContinuityHooks({ cwd = process.cwd(), native } = {}) {
  const owned = !native;
  native ??= new NativeAdapter();
  try {
    const reply = await native.request('hooks/list', { cwds: [resolve(cwd)] });
    if (!object(reply) || !Array.isArray(reply.data) || reply.data.some(entry => !object(entry) || !Array.isArray(entry.hooks))) {
      return { status: 'unavailable', reason: 'INVALID_HOOK_RESPONSE', execution_confirmed: false, events: [] };
    }
    const hooks = reply.data.flatMap(entry => entry.hooks).filter(hook => object(hook) && hook.pluginId === pluginId);
    const states = Object.entries(events).map(([event, hostEvent]) => {
      const matches = hooks.filter(hook => hook.eventName === hostEvent).map(hook => ({
        key: typeof hook.key === 'string' ? hook.key : null,
        enabled: hook.enabled === true,
        trust_status: typeof hook.trustStatus === 'string' ? hook.trustStatus : 'unknown',
        source_path: typeof hook.sourcePath === 'string' ? hook.sourcePath : null
      }));
      return { event, configured: matches.length > 0, ready: matches.length > 0 && matches.every(hook => hook.enabled && hook.trust_status === 'trusted'), hooks: matches };
    });
    return { status: states.every(state => state.ready) ? 'ready' : 'needs_attention', execution_confirmed: false, events: states };
  } catch (error) {
    const reason = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : 'HOOK_STATUS_UNAVAILABLE';
    return { status: 'unavailable', reason, execution_confirmed: false, events: [] };
  } finally { if (owned) native.close(); }
}

export const readChainingHooks = readSessionContinuityHooks;
