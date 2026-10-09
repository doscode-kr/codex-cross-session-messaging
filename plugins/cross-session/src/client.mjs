import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CrossSessionError } from './errors.mjs';

export function settings(env = process.env) {
  const requested = resolve(env.CROSS_SESSION_HOME || join(env.CODEX_HOME || join(homedir(), '.codex'), 'cross-session'));
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested);
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = createHash('sha256').update(canonical).digest('hex');
  // Avoid the dynamic port range, which Windows often reserves for Hyper-V.
  return { root, instance: hash, port: 10000 + (parseInt(hash.slice(0, 8), 16) % 30000) };
}
export function authToken(root) {
  const path = join(root, 'auth-token');
  try {
    const existing = readFileSync(path, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new CrossSessionError('TOKEN_INVALID', 'The saved broker token is invalid.');
    return existing;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  constructor({ config = settings(), timeoutMs = 35000, autoStart = true } = {}) { this.config = config; this.timeoutMs = timeoutMs; this.autoStart = autoStart; }
  async request(path, data) {
    const token = authToken(this.config.root);
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.config.port}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ instance: this.config.instance, ...data }), signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') throw new CrossSessionError('BROKER_OFFLINE', 'The local messaging broker is not running.');
      throw new CrossSessionError('BROKER_TIMEOUT', 'The broker reply was lost or timed out. Check the message history before resending.');
    }
    const body = await response.json();
    if (!response.ok) throw new CrossSessionError(body.code ?? 'BROKER_REJECTED', body.message ?? 'The broker rejected the request.', body);
    return body;
  }
  async ensure() {
    try { return await this.request('/health', {}); }
    catch (error) { if (error.code !== 'BROKER_OFFLINE' || !this.autoStart) throw error; }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url))], {
      detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CROSS_SESSION_HOME: this.config.root }
    });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { return await this.request('/health', {}); }
      catch (error) { if (!['BROKER_OFFLINE', 'TOKEN_NOT_READY'].includes(error.code)) throw error; }
    }
    throw new CrossSessionError('BROKER_START_FAILED', 'The broker did not start. Run the broker command in a terminal to see its error.');
  }
  async call(method, args, sessionId) { await this.ensure(); return this.request('/call', { method, args, sessionId }); }
  async hook(input, projectRoot) { await this.ensure(); return this.request('/hook', { input, projectRoot }); }
}
