import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { temporary, FakeNative } from './helpers.mjs';
import { settings, BrokerClient } from '../plugins/cross-session/src/client.mjs';
import { startBroker } from '../plugins/cross-session/src/broker.mjs';
import { handleMcp } from '../plugins/cross-session/src/mcp.mjs';
import { nativeClientInfo } from '../plugins/cross-session/src/native.mjs';
import { productVersion } from '../plugins/cross-session/src/version.mjs';

const packageVersion = JSON.parse(readFileSync('plugins/cross-session/package.json', 'utf8')).version;

test('runtime protocols report the plugin package version', async t => {
  assert.equal(productVersion, packageVersion);
  assert.equal(nativeClientInfo.version, packageVersion);

  const initialized = await handleMcp({ method: 'initialize', params: { protocolVersion: '2024-11-05' } }, {});
  assert.equal(initialized.serverInfo.version, packageVersion);

  let broker;
  const config = settings({ CROSS_SESSION_HOME: temporary(t, () => broker?.close()) });
  broker = await startBroker({ config, native: new FakeNative(), intervalMs: 0 });
  const health = await new BrokerClient({ config, autoStart: false }).request('/health', {});
  assert.equal(health.version, packageVersion);
});
