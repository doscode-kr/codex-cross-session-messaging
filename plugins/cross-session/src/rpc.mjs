import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { CrossSessionError } from './errors.mjs';

// The CLI proxy relays raw UDS bytes. The daemon socket carries WebSocket
// frames, not the JSON lines used by `codex app-server --listen stdio://`.
export async function connectProxy(child, timeoutMs = 15000) {
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.setTimeout = () => stream;
  stream.setNoDelay = () => stream;
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => stream, handshakeTimeout: timeoutMs,
    perMessageDeflate: false, maxPayload: 16 * 1024 * 1024
  });
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      child.once('error', reject);
      child.once('exit', () => reject(new CrossSessionError('NATIVE_DISCONNECTED', 'Proxy exited during connection.')));
    });
    return new RpcSocket(ws, child, timeoutMs);
  } catch (error) { ws.terminate(); child.kill(); throw error; }
}
export class RpcSocket extends EventEmitter {
  constructor(ws, child, timeoutMs = 15000) {
    super();
    this.child = child;
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
    child?.stderr?.on('data', data => { this.stderr = (this.stderr + data).slice(-2000); });
    ws.on('message', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value.id !== undefined && !value.method) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if (value.error) {
          pending.reject(new CrossSessionError('NATIVE_REJECTED', value.error.message, { rpcCode: value.error.code, rpcData: value.error.data }));
        } else pending.resolve(value.result);
      } else if (value.method && value.id !== undefined) {
        // Approval requests can be broadcast to subscribed clients. A rejection
        // here could race the user's answer in the recipient CLI. Stay passive.
        this.emit('serverRequest', value);
      } else if (value.method) this.emit('notification', value);
    });
    ws.on('error', error => this.fail(error));
    ws.on('close', () => this.fail(new CrossSessionError('NATIVE_DISCONNECTED', 'The daemon connection closed.')));
    child?.on('error', error => this.fail(error));
    child?.on('exit', () => this.fail(new CrossSessionError('NATIVE_DISCONNECTED', `App-server proxy exited. ${this.stderr}`)));
  }
  write(value) { this.ws.send(JSON.stringify(value)); }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new CrossSessionError('NATIVE_DISCONNECTED', 'The app-server connection is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CrossSessionError('NATIVE_TIMEOUT', `No reply to ${method}. The delivery outcome may be unknown.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.emit('closed');
  }
  close() {
    this.fail(new CrossSessionError('NATIVE_DISCONNECTED', 'The app-server observer closed.'));
    this.ws.terminate();
    this.child?.kill();
  }
}
