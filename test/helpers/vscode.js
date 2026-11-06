'use strict';

const { EventEmitter } = require('node:events');
const { activate } = require('../../src/extension');

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(options = {}) {
  const commands = new Map(), terminals = [], tunnels = [], proxies = [], logs = [], errors = [], infos = [], warnings = [];
  const picks = [], inputs = [], notifications = [], progressMessages = [], clipboard = [], executions = [], listeners = {};
  const status = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const values = {
    sshHost: 'my-server', gatewayPort: 3425, remotePort: 13425, sshPath: 'ssh', sshConfigFile: '',
    model: 'vendor/model', autoConnect: false, autoReconnect: false, ...options.values
  };
  const state = { hosts: options.hosts || {}, ...options.state };
  const secrets = { ...options.secrets };
  const disposable = { dispose() {} };
  const context = {
    subscriptions: [],
    globalState: { get: (key, fallback) => state[key] === undefined ? fallback : state[key], update: async (key, value) => { state[key] = value; } },
    secrets: { get: async key => secrets[key], store: async (key, value) => { secrets[key] = value; }, delete: async key => { delete secrets[key]; } }
  };
  const vscode = {
    l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, ConfigurationTarget: { Global: 1 },
    CancellationTokenSource: class {
      constructor() { const emitter = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: fn => { emitter.on('cancel', fn); return { dispose: () => emitter.off('cancel', fn) }; } }; this.emitter = emitter; }
      cancel() { this.token.isCancellationRequested = true; this.emitter.emit('cancel'); }
      dispose() { this.emitter.removeAllListeners(); }
    },
    env: { remoteName: Object.hasOwn(options, 'remoteName') ? options.remoteName : 'ssh-remote', clipboard: { writeText: async text => clipboard.push(text) } },
    workspace: {
      isTrusted: options.trusted ?? true,
      workspaceFolders: [{ uri: { scheme: 'vscode-remote', authority: options.authority || 'ssh-remote+my-server', path: '/remote/project' } }],
      getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback, update: async (key, value) => { values[key] = value; } }),
      onDidChangeConfiguration: fn => { listeners.configuration = fn; return disposable; },
      onDidChangeWorkspaceFolders: fn => { listeners.folders = fn; return disposable; }
    },
    commands: {
      registerCommand(name, fn) { commands.set(name, fn); return disposable; },
      executeCommand: async (...args) => executions.push(args)
    },
    extensions: { getExtension: () => options.legacy ? {} : undefined },
    window: {
      createOutputChannel: () => ({ info: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text), show() {}, dispose() {} }),
      createStatusBarItem: () => status,
      withProgress: async (_, fn) => {
        const source = new vscode.CancellationTokenSource();
        notifications.push(source);
        return fn({ report: item => progressMessages.push(item.message) }, source.token);
      },
      showQuickPick: async choices => { picks.push(choices); return options.select ? options.select(choices) : choices[0]; },
      showInputBox: async (input, token) => { inputs.push({ input, token }); return options.input ? options.input(input, token) : undefined; },
      showErrorMessage: async (message, ...actions) => { errors.push(message); return options.errorAction?.(actions); },
      showWarningMessage: async message => { warnings.push(message); },
      showInformationMessage: async (message, ...actions) => { infos.push(message); return options.infoAction?.(actions); },
      onDidCloseTerminal: fn => { listeners.closeTerminal = fn; return disposable; },
      createTerminal: opts => {
        const terminal = { options: opts, show() {}, sendText(command) { this.command = command; }, dispose() { this.disposed = true; } };
        terminals.push(terminal); return terminal;
      }
    }
  };
  class FakeTunnel extends EventEmitter {
    constructor(opts) { super(); this.options = opts; tunnels.push(this); }
    async start(opts) { if (options.start) await options.start(this, opts); }
    async probe(token) { this.probed = token; if (options.probe) await options.probe(this); }
    stop() { this.stopped = true; }
  }
  activate(context, {
    vscode, readFile: options.readFile || (async () => options.sshConfig || ''),
    getModels: options.getModels || (async () => ['vendor/model']),
    startProxy: async () => {
      const proxy = { token: 'session-token', port: 49123, close() { this.closed = true; } };
      proxies.push(proxy); return proxy;
    },
    startAuth: options.startAuth || (async () => ({ close() {} })),
    createTunnel: opts => new FakeTunnel(opts), localClaudeModels: async () => ({}),
    clock: options.clock, reconnect: options.reconnect
  });
  return {
    run: name => commands.get(`magpieBridge.${name}`)(), commands, terminals, tunnels, proxies, errors, logs,
    context, state, picks, inputs, infos, warnings, values, status, secrets, clipboard, notifications, executions,
    listeners, vscode, progressMessages, dispose: () => { for (const item of context.subscriptions) item.dispose(); }
  };
}

module.exports = { fixture, flush };
