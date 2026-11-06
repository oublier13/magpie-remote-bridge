'use strict';

const os = require('node:os');
const path = require('node:path');

const CONNECTION_KEYS = ['gatewayPort', 'remotePort', 'sshPath', 'sshConfigFile', 'sshHost'];

/** Expands only the local user's home shortcut; never evaluates shell syntax. */
function localPath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('SSH paths must be strings without control characters');
  return /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Captures application-scoped settings once for a connection. */
function readConfig(workspace) {
  const c = workspace.getConfiguration('magpieBridge');
  const config = {
    host: c.get('sshHost', ''), gatewayPort: c.get('gatewayPort', 3425),
    remotePort: c.get('remotePort', 13425), sshPath: localPath(c.get('sshPath', 'ssh')),
    configFile: localPath(c.get('sshConfigFile', '')), model: c.get('model', ''),
    autoConnect: c.get('autoConnect', false), autoReconnect: c.get('autoReconnect', true)
  };
  for (const key of ['host', 'model']) {
    if (typeof config[key] !== 'string' || /[\x00-\x1f\x7f]/.test(config[key])) throw new Error(`Invalid bridge ${key} setting`);
  }
  for (const key of ['autoConnect', 'autoReconnect']) {
    if (typeof config[key] !== 'boolean') throw new Error(`magpieBridge.${key} must be a boolean`);
  }
  for (const [key, min] of [['gatewayPort', 1], ['remotePort', 1024]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > 65535) {
      throw new Error(`magpieBridge.${key} must be an integer between ${min} and 65535`);
    }
  }
  if (!config.sshPath || /[\r\n\0]/.test(config.sshPath)) throw new Error('Invalid magpieBridge.sshPath');
  if (config.configFile && !path.isAbsolute(config.configFile)) {
    throw new Error('magpieBridge.sshConfigFile must be an absolute local path');
  }
  return Object.freeze(config);
}

function getGatewayKey(secrets) {
  return secrets.get('gatewayKey').then(key => key || 'magpie');
}

module.exports = { readConfig, getGatewayKey, CONNECTION_KEYS };
