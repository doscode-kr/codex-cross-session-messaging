import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, authToken, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';

function files(root) {
  return fs.readdirSync(root).sort().map(name => ({ name, content: fs.readFileSync(join(root, name), 'hex'), mtime: fs.statSync(join(root, name)).mtimeMs }));
}

test('read-only settings does not create a missing state directory', t => {
  const parent = temporary(t);
  const root = join(parent, 'missing', 'state');
  assert.throws(() => settings({ CROSS_SESSION_HOME: root }, { create: false }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('read-only token access does not publish a missing token', t => {
  const root = temporary(t);
  assert.throws(() => authToken(root, { create: false }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the default config of a read-only client does not create state', t => {
  const parent = temporary(t);
  const before = process.env.CROSS_SESSION_HOME;
  process.env.CROSS_SESSION_HOME = join(parent, 'missing', 'state');
  try {
    assert.throws(() => new BrokerClient({ createState: false, autoStart: true }), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    if (before === undefined) delete process.env.CROSS_SESSION_HOME;
    else process.env.CROSS_SESSION_HOME = before;
  }
});

test('a read-only client with a config keeps a missing token absent', async t => {
  const root = temporary(t);
  const config = settings({ CROSS_SESSION_HOME: root }, { create: false });
  const client = new BrokerClient({ config, createState: false, autoStart: false });
  await assert.rejects(client.ensure(), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('read-only mode prevents spawn even when autoStart is explicitly true', async t => {
  const root = temporary(t);
  const config = settings({ CROSS_SESSION_HOME: root });
  authToken(root);
  const before = files(root);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const original = childProcess.spawn;
  let spawned = 0;
  childProcess.spawn = () => { spawned++; throw new Error('Unexpected broker spawn'); };
  syncBuiltinESMExports();
  try {
    const client = new BrokerClient({ config, createState: false, autoStart: true });
    await assert.rejects(client.ensure(), { code: 'BROKER_OFFLINE' });
    assert.equal(spawned, 0);
    assert.deepEqual(files(root), before);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('read-only token errors retain their original classification', async t => {
  const root = temporary(t);
  const config = settings({ CROSS_SESSION_HOME: root }, { create: false });
  fs.writeFileSync(join(root, 'auth-token'), 'invalid');
  const before = files(root);
  const client = new BrokerClient({ config, createState: false, autoStart: true });
  await assert.rejects(client.ensure(), { code: 'TOKEN_INVALID' });
  assert.deepEqual(files(root), before);
  const original = fs.readFileSync;
  const failure = Object.assign(new Error('Injected access failure'), { code: 'EACCES' });
  fs.readFileSync = (...args) => {
    if (args[0] === join(root, 'auth-token')) throw failure;
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => authToken(root, { create: false }), error => error === failure);
    await assert.rejects(client.ensure(), error => error === failure);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(files(root), before);
});

test('read-only health checks preserve existing state files and canonical identity', async t => {
  let broker;
  const root = temporary(t, () => broker?.close());
  const config = settings({ CROSS_SESSION_HOME: root });
  config.port = 0;
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  config.port = broker.server.address().port;
  const before = files(root);
  const readonly = settings({ CROSS_SESSION_HOME: join(root, '.') }, { create: false });
  assert.equal(readonly.root, config.root);
  assert.equal(readonly.instance, config.instance);
  assert.equal(readonly.port, settings({ CROSS_SESSION_HOME: root }).port);
  const client = new BrokerClient({ config, createState: false, autoStart: true });
  const health = await client.ensure();
  assert.equal(health.instance, config.instance);
  assert.deepEqual(files(root), before);
});

test('default and explicit create options preserve state creation', t => {
  const parent = temporary(t);
  for (const options of [undefined, { create: true }]) {
    const root = join(parent, options ? 'explicit' : 'default');
    const config = settings({ CROSS_SESSION_HOME: root }, options);
    assert.ok(fs.statSync(root).isDirectory());
    const token = authToken(config.root, options);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(authToken(config.root, { create: false }), token);
    assert.deepEqual(fs.readdirSync(root), ['auth-token']);
    const client = new BrokerClient({ config });
    assert.equal(client.autoStart, true);
  }
});
