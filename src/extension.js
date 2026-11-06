'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startProxy, getModels } = require('./proxy');
const { Tunnel, validateHost } = require('./tunnel');
const { localClaudeModels, terminalEnv, codexCommand } = require('./agents');
const { startAuth } = require('./auth');

function activate(context) {
  const log = vscode.window.createOutputChannel('Magpie Remote Bridge');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  status.command = 'magpieBridge.connect'; status.show();
  let session; let connecting; let generation = 0; let retryTimer; let disposed = false;
  const terminals = new Set();
  const cfg = () => {
    const c = vscode.workspace.getConfiguration('magpieBridge');
    return { host: c.get('sshHost'), gatewayPort: c.get('gatewayPort'), remotePort: c.get('remotePort'),
      sshPath: c.get('sshPath'), configFile: c.get('sshConfigFile'), model: c.get('model'),
      autoConnect: c.get('autoConnect'), autoReconnect: c.get('autoReconnect') };
  };
  function render(text, connected = false) {
    status.text = `$(plug) Magpie: ${text}`;
    status.tooltip = '本机 Magpie → 当前 Remote-SSH 工作区';
    status.command = connected ? 'magpieBridge.terminal' : 'magpieBridge.connect';
  }
  render('未连接');
  function authority() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区');
    const folders = vscode.workspace.workspaceFolders || [];
    if (vscode.env.remoteName !== 'ssh-remote' || !folders.length ||
      !folders[0].uri.authority.startsWith('ssh-remote+')) {
      throw new Error('请先在 VS Code 中通过 Remote-SSH 打开远端文件夹。首版支持桌面版 VS Code、SSH 与远端 POSIX shell。');
    }
    return folders[0].uri.authority;
  }
  async function chooseHost(id, config) {
    const map = context.globalState.get('hosts', {});
    if (map[id]) return map[id];
    const guess = id.slice('ssh-remote+'.length);
    const candidates = new Set([config.host, /^[\w.@-]+$/.test(guess) ? guess : ''].filter(Boolean));
    try {
      const contents = await fs.readFile(config.configFile || path.join(os.homedir(), '.ssh', 'config'), 'utf8');
      for (const line of contents.split(/\r?\n/)) {
        const match = /^\s*Host\s+(.+?)(?:\s+#.*)?$/i.exec(line);
        if (match) for (const item of match[1].split(/\s+/)) if (/^[\w.@-]+$/.test(item)) candidates.add(item);
      }
    } catch { /* Include/Match or a non-default file can be entered manually. */ }
    const manual = '输入其他 SSH Host…';
    const selected = await vscode.window.showQuickPick([...candidates, manual], {
      title: '选择当前 Remote-SSH 工作区对应的 Host',
      placeHolder: '必须与当前远端工作区是同一服务器和用户（使用本机 SSH 配置）'
    });
    if (!selected) return;
    const host = selected === manual ? await vscode.window.showInputBox({
      title: '当前工作区的 SSH Host', prompt: '输入本机 ~/.ssh/config 的 Host 别名或 user@host',
      validateInput: value => { try { validateHost(value); } catch (e) { return e.message; } }
    }) : selected;
    if (!host) return;
    validateHost(host);
    await context.globalState.update('hosts', { ...map, [id]: host });
    return host;
  }
  function disconnect() {
    generation++; clearTimeout(retryTimer); retryTimer = undefined;
    const old = session; session = undefined;
    old?.tunnel.stop(); old?.proxy.close(); old?.config.auth?.close(); old?.cancel?.dispose(true);
    for (const terminal of terminals) terminal.dispose();
    terminals.clear();
    render('未连接');
  }
  function watch(s, tunnel) {
    tunnel.on('closed', message => {
      if (session !== s || s.tunnel !== tunnel || !s.ready) return;
      s.ready = false; render('连接中断'); log.appendLine(message);
      if (cfg().autoReconnect) scheduleReconnect(s);
      else { disconnect(); vscode.window.showWarningMessage('Magpie 桥接已断开，请重新连接。'); }
    });
  }
  function scheduleReconnect(s) {
    if (session !== s) return;
    if (s.attempts >= 3) {
      disconnect(); vscode.window.showWarningMessage('Magpie 重连失败，请检查 SSH 后手动连接。'); return;
    }
    const attempt = ++s.attempts;
    render(`重连 ${attempt}/3`);
    retryTimer = setTimeout(async () => {
      if (session !== s) return;
      const tunnel = new Tunnel({ ...s.config, localPort: s.proxy.port });
      s.tunnel = tunnel; watch(s, tunnel);
      try {
        await tunnel.start();
        if (session !== s) return tunnel.stop();
        await tunnel.probe(s.proxy.token);
        if (session !== s) return tunnel.stop();
        s.ready = true;
        // Reset after a stable minute; a flapping connection still reaches the retry limit.
        const stable = setTimeout(() => { if (session === s && s.ready && s.tunnel === tunnel) s.attempts = 0; }, 60000);
        stable.unref();
        render('已连接', true); log.appendLine('SSH 已重连，原终端令牌继续有效。');
      } catch (e) {
        tunnel.stop();
        if (session !== s) return;
        log.appendLine(e.message); scheduleReconnect(s);
      }
    }, Math.min(1000 * 2 ** (attempt - 1), 8000));
  }
  async function connect() {
    if (disposed) return;
    if (session?.ready) return session;
    if (connecting) return connecting;
    if (session) disconnect();
    const id = authority(); const config = cfg(); const epoch = generation;
    connecting = (async () => {
      const host = await chooseHost(id, config);
      if (!host || generation !== epoch || disposed) return;
      config.host = host;
      const key = (await context.secrets.get('gatewayKey')) || 'magpie';
      render('检查本机网关');
      await getModels(config.gatewayPort, key); // Read-only; no model inference or billing.
      if (generation !== epoch || disposed) return;
      const proxy = await startProxy({ gatewayPort: config.gatewayPort, upstreamKey: key });
      if (generation !== epoch || disposed) { proxy.close(); return; }
      const cancel = new vscode.CancellationTokenSource();
      try {
        config.auth = await startAuth(challenge => vscode.window.showInputBox({ password: true, ignoreFocusOut: true,
          title: `Magpie SSH · ${host}`, prompt: challenge,
          placeHolder: '仅用于本次 SSH 认证，不保存密码' }, cancel.token));
      } catch (e) { proxy.close(); cancel.dispose(true); throw e; }
      if (generation !== epoch || disposed) { proxy.close(); config.auth.close(); cancel.dispose(true); return; }
      const tunnel = new Tunnel({ ...config, localPort: proxy.port });
      const s = { proxy, tunnel, config, cancel, ready: false, attempts: 0 };
      session = s; watch(s, tunnel); render('建立 SSH 隧道');
      try {
        await tunnel.start();
        if (session !== s) { tunnel.stop(); return; }
        await tunnel.probe(proxy.token);
        if (session !== s) { tunnel.stop(); return; }
        s.ready = true; render('已连接', true);
        log.appendLine(`已连接 ${host}:127.0.0.1:${config.remotePort} → 本机 Magpie:${config.gatewayPort}；远端 HTTP 检测通过。`);
        return s;
      } catch (e) {
        if (session === s) disconnect();
        throw e;
      }
    })();
    try { return await connecting; }
    catch (e) { if (!session) render('连接失败'); throw e; }
    finally { connecting = undefined; }
  }
  async function openTerminal(agent) {
    authority();
    const s = await connect(); if (!s?.ready || session !== s) return;
    const config = { ...s.config, model: cfg().model, token: s.proxy.token };
    if (agent === 'codex' && !config.model) {
      await chooseModel(); config.model = cfg().model;
      if (!config.model) return;
    }
    const models = await localClaudeModels(config.gatewayPort);
    if (session !== s || !s.ready) return;
    const terminal = vscode.window.createTerminal({
      name: `Magpie · ${agent || 'Remote'}`, env: terminalEnv(config, models),
      cwd: vscode.workspace.workspaceFolders[0].uri
    });
    terminals.add(terminal); terminal.show();
    if (agent === 'claude') terminal.sendText('claude', true);
    if (agent === 'codex') terminal.sendText(codexCommand(config), true);
  }
  async function chooseModel() {
    const c = cfg(); const key = (await context.secrets.get('gatewayKey')) || 'magpie';
    const models = await getModels(c.gatewayPort, key);
    const selected = await vscode.window.showQuickPick(models, { title: '选择 Magpie 模型（新启动的 agent 会话生效）' });
    if (selected) await vscode.workspace.getConfiguration('magpieBridge').update('model', selected, vscode.ConfigurationTarget.Global);
  }
  async function diagnose() {
    const c = cfg(); const key = (await context.secrets.get('gatewayKey')) || 'magpie';
    const models = await getModels(c.gatewayPort, key);
    if (session?.ready) await session.tunnel.probe(session.proxy.token);
    vscode.window.showInformationMessage(`本机 Magpie 正常，${models.length} 个模型；${session?.ready ? '远端 → 本机 HTTP 检测通过' : '隧道未连接'}。`);
  }
  async function setKey() {
    const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true,
      title: 'Magpie 本机网关密钥（留空清除）', prompt: '仅存储在 VS Code SecretStorage，不会发送给远端' });
    if (key === undefined) return;
    if (/[\r\n]/.test(key)) throw new Error('密钥不能包含换行');
    if (key) await context.secrets.store('gatewayKey', key); else await context.secrets.delete('gatewayKey');
    disconnect(); vscode.window.showInformationMessage('网关密钥已更新，下次连接生效。');
  }
  const commands = {
    connect, disconnect, terminal: () => openTerminal(), claude: () => openTerminal('claude'),
    codex: () => openTerminal('codex'), model: chooseModel, diagnose, key: setKey, logs: () => log.show(),
    changeHost: async () => {
      const id = authority(); disconnect();
      const map = { ...context.globalState.get('hosts', {}) }; delete map[id];
      await context.globalState.update('hosts', map);
      return connect();
    },
    copyConnection: async () => {
      const s = await connect(); if (!s?.ready || session !== s) return;
      const base = `http://127.0.0.1:${s.config.remotePort}`;
      await vscode.env.clipboard.writeText(JSON.stringify({
        openaiBaseUrl: `${base}/v1`, anthropicBaseUrl: base,
        apiKey: s.proxy.token, model: cfg().model || undefined
      }, null, 2));
      vscode.window.showInformationMessage('远端接入地址及本次连接的临时令牌已复制；重新连接后需更新令牌。');
    }
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`magpieBridge.${name}`, async () => {
      try { return await fn(); } catch (e) {
        log.appendLine(e.message); vscode.window.showErrorMessage(`Magpie: ${e.message}`);
      }
    }));
  }
  context.subscriptions.push(log, status,
    vscode.window.onDidCloseTerminal(terminal => terminals.delete(terminal)),
    { dispose: () => { disposed = true; disconnect(); } });
  if (cfg().autoConnect) {
    try {
      const id = authority();
      if (context.globalState.get('hosts', {})[id]) connect().catch(e => log.appendLine(e.message));
    } catch { /* Wait for an explicit connection in a supported workspace. */ }
  }
}
module.exports = { activate };
