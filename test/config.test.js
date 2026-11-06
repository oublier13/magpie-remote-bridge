'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { readConfig, getGatewayKey } = require('../src/config');
const { createLogger } = require('../src/log');
const { checkLocalization } = require('../scripts/check');

const workspace = values => ({ getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }) });

test('settings validate integer ports and absolute config file paths', () => {
  for (const values of [{ gatewayPort: 0 }, { gatewayPort: '3425' }, { remotePort: 80 }, { remotePort: 65536 }, { sshConfigFile: 'relative/config' }, { sshPath: '' }, { sshPath: 123 },
    { sshConfigFile: 5 }, { sshHost: false }, { model: {} }, { autoReconnect: 1 }, { model: 'model\n' }]) {
    assert.throws(() => readConfig(workspace(values)));
  }
  const config = readConfig(workspace({ sshConfigFile: '~/.ssh/config' }));
  assert.equal(config.configFile, path.join(os.homedir(), '.ssh/config'));
  assert.equal(Object.isFrozen(config), true);
});

test('SecretStorage lookup falls back to the default local key', async () => {
  assert.equal(await getGatewayKey({ get: async () => undefined }), 'magpie');
  assert.equal(await getGatewayKey({ get: async () => 'custom' }), 'custom');
});

test('logger redacts known credentials and bearer values at every level', () => {
  const entries = [];
  const channel = { info: text => entries.push(text), warn: text => entries.push(text), error: text => entries.push(text) };
  const log = createLogger(channel);
  log.protect('private-value');
  log.info('key=private-value');
  log.warn('Authorization: Bearer unknown-token');
  log.error(new Error('failed with private-value'));
  assert.ok(entries.every(text => !text.includes('private-value') && !text.includes('unknown-token')));
});

test('all manifest and runtime messages have matching Chinese translations', checkLocalization);

test('manifest retains application-scoped settings, UI host and no runtime dependencies', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.extensionKind, ['ui']);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0);
  for (const setting of Object.values(manifest.contributes.configuration.properties)) assert.equal(setting.scope, 'application');
});

test('redaction handles overlapping credentials and literal regular-expression syntax', () => {
  const entries = [];
  const log = createLogger({ info: message => entries.push(message) });
  log.protect('abc'); log.protect('abcdef'); log.protect('a[b].*');
  log.info('abcdef abc a[b].*');
  assert.equal(entries[0], '[redacted] [redacted] [redacted]');
});
