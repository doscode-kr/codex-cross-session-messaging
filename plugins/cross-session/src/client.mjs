import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CrossSessionError } from './errors.mjs';

function requestAbort(external, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return { signal: timeout, dispose() {} };
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([external, timeout]), dispose() {} };
  const controller = new AbortController(), sources = [external, timeout];
  const abort = event => controller.abort(event.target.reason);
  for (const signal of sources) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose() { for (const signal of sources) signal.removeEventListener('abort', abort); } };
}

export function settings(env = process.env, { create = true } = {}) {
  const requested = resolve(env.CROSS_SESSION_HOME || join(env.CODEX_HOME || join(homedir(), '.codex'), 'cross-session'));
  if (create) mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested);
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = createHash('sha256').update(canonical).digest('hex');
  // Avoid the dynamic port range, which Windows often reserves for Hyper-V.
  return { root, instance: hash, port: 10000 + (parseInt(hash.slice(0, 8), 16) % 30000) };
}
export function authToken(root, { create = true } = {}) {
  const path = join(root, 'auth-token');
  try {
    const existing = readFileSync(path, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new CrossSessionError('TOKEN_INVALID', 'The saved broker token is invalid.');
    return existing;
  } catch (error) { if (error.code !== 'ENOENT' || !create) throw error; }
  // Publish a complete token atomically. Concurrent callers cannot read an
  // empty token and cannot replace the winning token (hard link, no overwrite).
  const temporary = join(root, `auth-token-${process.pid}-${randomBytes(8).toString('hex')}`);
  writeFileSync(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { unlinkSync(temporary); }
  const token = readFileSync(path, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new CrossSessionError('TOKEN_NOT_READY', 'The broker token is being created or is invalid.');
  return token;
}
export class BrokerClient {
  constructor({ config, timeoutMs = 35000, autoStart = true, createState = true } = {}) {
    this.config = config ?? settings(process.env, { create: createState });
    this.timeoutMs = timeoutMs;
    this.createState = createState;
    this.autoStart = autoStart && createState;
  }
  async request(path, data, { signal } = {}) {
    const token = authToken(this.config.root, { create: this.createState });
    let response, body;
    const requestSignal = requestAbort(signal, this.timeoutMs);
    try {
      response = await fetch(`http://127.0.0.1:${this.config.port}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ instance: this.config.instance, ...data }), signal: requestSignal.signal, redirect: 'manual'
      });
      if (response.status >= 300 && response.status < 400) await response.body?.cancel().catch(() => {});
      else body = await response.json();
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') throw new CrossSessionError('BROKER_OFFLINE', 'The local messaging broker is not running.');
      const details = { requestPath: path, requestOutcome: 'unknown', ...(response ? { httpStatus: response.status } : {}) };
      if (error instanceof SyntaxError) throw new CrossSessionError('BROKER_RESPONSE_INVALID', 'The broker response is invalid. The request result is unknown. Check message history before another send.', details);
      throw new CrossSessionError('BROKER_TIMEOUT', 'The broker reply was lost or timed out. The request result is unknown. Check message history before another send.', details);
    } finally { requestSignal.dispose(); }
    const object = body !== null && typeof body === 'object' && !Array.isArray(body);
    const text = value => typeof value === 'string' && Boolean(value.trim());
    const invalid = !object || (response.ok
      ? (path === '/health' && (body.instance !== this.config.instance || (body.version !== undefined && !text(body.version)) || (body.pid !== undefined && (!Number.isInteger(body.pid) || body.pid < 1)))) ||
        (path === '/shutdown' && body.stopped !== true)
      : (body.code !== undefined && !text(body.code)) || (body.message !== undefined && !text(body.message)));
    if (invalid) throw new CrossSessionError('BROKER_RESPONSE_INVALID', 'The broker response is invalid. The request result is unknown. Check message history before another send.', { requestPath: path, requestOutcome: 'unknown', httpStatus: response.status });
    if (!response.ok) throw new CrossSessionError(body.code ?? 'BROKER_REJECTED', body.message ?? 'The broker rejected the request.', body);
    return body;
  }
  async ensure(options = {}) {
    try { return await this.request('/health', {}, options); }
    catch (error) { if (error.code !== 'BROKER_OFFLINE' || !this.autoStart) throw error; }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url))], {
      detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CROSS_SESSION_HOME: this.config.root }
    });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 60; i++) {
      await new Promise((resolveWait, rejectWait) => {
        if (options.signal?.aborted) return rejectWait(new CrossSessionError('BROKER_TIMEOUT', 'The broker hook deadline expired.'));
        const timer = setTimeout(done, 100);
        const aborted = () => { clearTimeout(timer); options.signal.removeEventListener('abort', aborted); rejectWait(new CrossSessionError('BROKER_TIMEOUT', 'The broker hook deadline expired.')); };
        function done() { options.signal?.removeEventListener('abort', aborted); resolveWait(); }
        options.signal?.addEventListener('abort', aborted, { once: true });
      });
      try { return await this.request('/health', {}, options); }
      catch (error) { if (!['BROKER_OFFLINE', 'TOKEN_NOT_READY'].includes(error.code)) throw error; }
    }
    throw new CrossSessionError('BROKER_START_FAILED', 'The broker did not start. Run the broker command in a terminal to see its error.');
  }
  async call(method, args, sessionId) { await this.ensure(); return this.request('/call', { method, args, sessionId }); }
  async hook(input, projectRoot, { totalTimeoutMs } = {}) {
    const options = Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs > 0 ? { signal: AbortSignal.timeout(totalTimeoutMs) } : {};
    await this.ensure(options);
    return this.request('/hook', { input, projectRoot }, options);
  }
}
