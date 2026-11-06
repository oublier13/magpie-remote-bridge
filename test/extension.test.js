'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture({ remoteName = 'ssh-remote', start } = {}) {
  const commands = new Map(); const terminals = []; const errors = []; const logs = [];
  const tunnels = []; const proxies = []; const state = {};
  const values = { gatewayPort: 3425, remotePort: 13425, sshHost: 'my-server',
    sshPath: 'ssh', sshConfigFile: '', model: 'vendor/model', autoConnect: false, autoReconnect: false };
  const disposable = { dispose() {} };
  const vscode = {
    CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
    StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1 },
    env: { remoteName, clipboard: { writeText: async () => {} } },
    workspace: { isTrusted: true,
      workspaceFolders: [{ uri: { authority: 'ssh-remote+my-server', path: '/remote/project' } }],
      getConfiguration: () => ({ get: k => values[k], update: async (k, v) => { values[k] = v; } }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; } },
    window: {
      createOutputChannel: () => ({ appendLine: s => logs.push(s), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showQuickPick: async choices => choices[0], showErrorMessage: s => errors.push(s),
      showWarningMessage: s => errors.push(s), showInformationMessage() {},
      createTerminal: options => {
        const t = { options, show() {}, sendText(s) { this.command = s; }, dispose() { this.disposed = true; } };
        terminals.push(t); return t;
      },
      onDidCloseTerminal: () => disposable
    }
  };
  class FakeTunnel extends EventEmitter {
    constructor(options) { super(); this.options = options; tunnels.push(this); }
    async start() { if (start) await start(); }
    async probe(token) { assert.equal(token, 'session-token'); this.probed = true; }
    stop() { this.stopped = true; this.emit('closed', 'stopped'); }
  }
  const context = { subscriptions: [], globalState: {
    get: (key, fallback) => state[key] || fallback, update: async (key, value) => { state[key] = value; }
  }, secrets: { get: async () => undefined } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/extension'), 'utf8'), {
    module, setTimeout, clearTimeout,
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './proxy') return {
        getModels: async () => ['vendor/model'], startProxy: async () => {
          const p = { token: 'session-token', port: 49123, close() { this.closed = true; } };
          proxies.push(p); return p;
        }
      };
      if (name === './tunnel') return { Tunnel: FakeTunnel, validateHost: s => s };
      if (name === './auth') return { startAuth: async () => ({ close() {} }) };
      if (name === './agents') return { ...require('../src/agents'), localClaudeModels: async () => ({}) };
      return require(name);
    }
  });
  module.exports.activate(context);
  return { run: name => commands.get(`magpieBridge.${name}`)(), terminals, tunnels, proxies, errors, logs, context };
}
test('connects once, probes from remote, launches in remote cwd and revokes resources on disconnect', async () => {
  const f = fixture();
  await Promise.all([f.run('connect'), f.run('connect')]);
  assert.equal(f.tunnels.length, 1); assert.equal(f.tunnels[0].probed, true);
  await f.run('codex');
  const terminal = f.terminals[0];
  assert.equal(terminal.options.cwd.path, '/remote/project');
  assert.equal(terminal.options.env.MAGPIE_BRIDGE_TOKEN, 'session-token');
  assert.ok(terminal.command.startsWith('codex '));
  assert.ok(!terminal.command.includes('session-token'));
  await f.run('disconnect');
  assert.ok(terminal.disposed && f.tunnels[0].stopped && f.proxies[0].closed);
  assert.ok(!f.logs.join().includes('session-token'));
  assert.deepEqual(f.errors, []);
});
test('local workspace cannot start a reverse tunnel or remote agent', async () => {
  const f = fixture({ remoteName: undefined });
  // Explicitly override the default constructor argument for the local workspace case.
  const g = fixture({ remoteName: 'local' });
  await g.run('claude');
  assert.equal(g.tunnels.length, 0); assert.equal(g.terminals.length, 0);
  assert.match(g.errors[0], /Remote-SSH/);
  f.context.subscriptions.forEach(s => s.dispose());
});
test('disconnect during SSH startup cannot resurrect a session', async () => {
  let release;
  const hold = new Promise(r => { release = r; });
  const f = fixture({ start: () => hold });
  const pending = f.run('connect');
  while (!f.tunnels.length) await new Promise(r => setImmediate(r));
  await f.run('disconnect'); release(); await pending;
  assert.equal(f.proxies[0].closed, true); assert.equal(f.tunnels[0].stopped, true);
  assert.equal(f.terminals.length, 0);
});
