import { BrokerClient, settings } from './client.mjs';
import { CrossSessionError } from './errors.mjs';

const failureCode = /^[A-Z][A-Z0-9_]{0,63}$/;
const countNames = ['messages', 'registeredSessions', 'idleSubscriptions', 'pendingDeliveries', 'pendingIdleChecks'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

function decodeDiagnostics(value) {
  if (value == null) return null;
  if (!isObject(value) || typeof value.stopping !== 'boolean' || !isObject(value.journal) || !isObject(value.counts)
    || !isCount(value.journal.committedBytes)
    || !(value.journal.failureCode === null || (typeof value.journal.failureCode === 'string' && failureCode.test(value.journal.failureCode)))
    || !countNames.every(name => isCount(value.counts[name]))) {
    throw new CrossSessionError('BROKER_RESPONSE_INVALID', 'The broker returned invalid diagnostic metrics.');
  }
  return {
    stopping: value.stopping,
    journal: { committedBytes: value.journal.committedBytes, failureCode: value.journal.failureCode },
    counts: Object.fromEntries(countNames.map(name => [name, value.counts[name]]))
  };
}

export function brokerDiagnostics(service) {
  const { store } = service;
  const code = store.failure?.code;
  return {
    stopping: service.stopping,
    journal: {
      committedBytes: store.offset,
      failureCode: store.failure ? (typeof code === 'string' && failureCode.test(code) ? code : 'STORE_UNAVAILABLE') : null
    },
    counts: {
      messages: store.messages.size,
      registeredSessions: store.sessions.size,
      idleSubscriptions: store.subscriptions.size,
      pendingDeliveries: service.deliveries.size,
      pendingIdleChecks: service.idleChecks.size
    }
  };
}

export async function readBrokerStatus({ env = process.env, timeoutMs = 2000 } = {}) {
  try {
    const config = settings(env, { create: false });
    const client = new BrokerClient({ config, createState: false, autoStart: false, timeoutMs });
    const health = await client.request('/health', { diagnostics: true });
    const diagnostics = decodeDiagnostics(health.diagnostics);
    const status = diagnostics?.stopping ? 'stopping' : diagnostics?.journal?.failureCode ? 'degraded' : 'running';
    return { status, version: health.version, pid: health.pid, diagnostics };
  } catch (error) {
    if (error.code === 'ENOENT' && !(error instanceof CrossSessionError)) return { status: 'offline', reason: 'STATE_MISSING' };
    if (error.code === 'BROKER_OFFLINE' && !error.details?.code) return { status: 'offline', reason: 'BROKER_OFFLINE' };
    throw error;
  }
}
