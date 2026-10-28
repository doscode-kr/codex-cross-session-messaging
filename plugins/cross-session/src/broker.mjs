import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { settings, authToken } from './client.mjs';
import { Store } from './store.mjs';
import { NativeAdapter } from './native.mjs';
import { MessagingService } from './service.mjs';
import { errorData, CrossSessionError } from './errors.mjs';
import { brokerDiagnostics } from './diagnostics.mjs';
import { productVersion } from './version.mjs';

const requestDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function startBroker({ config = settings(), native = new NativeAdapter(), intervalMs = 1000 } = {}) {
  const token = authToken(config.root);
  let store, service, timer, polling = false;
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      // Reading a lazy journal body can fail. Keep headers untouched until then.
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(json);
    };
    const supplied = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return reply(403, { code: 'AUTH_FAILED', message: 'The local port belongs to another broker or the token does not match.' });
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || req.headers.origin) return reply(400, { code: 'INVALID_REQUEST', message: 'Use a local authenticated JSON client.' });
    try {
      const parts = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 131072) throw new CrossSessionError('REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.');
        parts.push(part);
      }
      let text;
      try { text = requestDecoder.decode(Buffer.concat(parts, size)); }
      catch { throw new CrossSessionError('INVALID_REQUEST', 'Request body must use valid UTF-8.'); }
      const data = JSON.parse(text);
      if (data.instance !== config.instance) throw new CrossSessionError('INSTANCE_MISMATCH', 'Another messaging state directory uses this port.');
      if (req.url === '/health') return reply(200, { version: productVersion, instance: config.instance, pid: process.pid,
        ...(data.diagnostics === true ? { diagnostics: brokerDiagnostics(service) } : {}) });
      if (req.url === '/call') return reply(200, await service.call(data.method, data.args, data.sessionId));
      if (req.url === '/hook') return reply(200, await service.hook(data.input, data.projectRoot));
      if (req.url === '/shutdown') {
        await service.requestShutdown();
        reply(200, { stopped: true });
        setImmediate(() => close());
        return;
      }
      throw new CrossSessionError('NOT_FOUND', 'Unknown broker endpoint.');
    } catch (error) { reply(400, errorData(error)); }
  });
  // Bind first. Only the successful listener may open and mutate the journal.
  await new Promise((yes, no) => { server.once('error', no); server.listen(config.port, '127.0.0.1', yes); });
  try { store = new Store(config.root); store.recover(); service = new MessagingService(store, native); }
  catch (error) {
    try { store?.close(); } catch { /* Preserve the startup error. */ }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    throw error;
  }
  if (intervalMs) timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await service.tick(); } catch { /* Existing daemon can be offline; state remains intact. */ }
    finally { polling = false; }
  }, intervalMs);
  let closing;
  function close() {
    if (closing) return closing;
    service.stopping = true;
    clearInterval(timer);
    closing = (async () => {
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      await service.drain();
      native.close();
      store.close();
    })();
    return closing;
  }
  return { config, server, service, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const broker = await startBroker();
    process.once('SIGINT', () => broker.close());
    process.once('SIGTERM', () => broker.close());
  } catch (error) {
    // Concurrent bootstrap loser is harmless. It must not open the journal.
    if (error.code !== 'EADDRINUSE') { console.error(error.message); process.exitCode = 1; }
  }
}
