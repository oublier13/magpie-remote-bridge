'use strict';
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');

function validateHost(host) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(host)) {
    throw new Error('SSH Host 必须是有效的别名或 user@host，不能包含空白或命令参数');
  }
  return host;
}
function sshArgs({ host, remotePort, localPort, configFile, auth, interactive = true }, marker) {
  validateHost(host);
  for (const port of [remotePort, localPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid forwarding port');
  }
  const args = ['-T', '-o', `BatchMode=${auth?.env && interactive ? 'no' : 'yes'}`, '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15', '-o', `ControlMaster=${auth?.controlPath ? 'auto' : 'no'}`,
    '-o', `ControlPath=${auth?.controlPath || 'none'}`, '-o', 'ControlPersist=no',
    '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'SessionType=default',
    '-o', 'StrictHostKeyChecking=yes'];
  if (configFile) args.push('-F', configFile);
  args.push('-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host,
    `printf '%s\\n' '${marker}'; cat`);
  return args;
}
class Tunnel extends EventEmitter {
  constructor(options, spawnProcess = spawn) {
    super(); this.options = options; this.spawnProcess = spawnProcess; this.child = undefined;
  }
  start() {
    const marker = `MAGPIE_BRIDGE_READY_${randomBytes(12).toString('hex')}`;
    const args = sshArgs(this.options, marker);
    return new Promise((resolve, reject) => {
      let settled = false; let output = ''; let errorText = '';
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { this.stop(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('SSH 隧道建立超时')), this.options.auth?.env ? 180000 : 25000);
      try { this.child = this.spawnProcess(this.options.sshPath || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.options.auth?.env }); }
      catch (e) { finish(e); return; }
      // Keep stdin open so remote cat holds the session; end it during stop().
      this.child.stdin.on('error', () => {});
      this.child.stdout.on('data', chunk => {
        output = (output + chunk).slice(-4096);
        if (output.includes(marker)) finish();
      });
      this.child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4096); });
      this.child.once('error', e => finish(e));
      this.child.once('close', code => {
        this.child = undefined;
        const message = `SSH 已退出 (${code}): ${errorText.trim() || '连接已关闭'}`;
        if (!settled) finish(new Error(message));
        this.emit('closed', message);
      });
    });
  }
  stop() {
    const child = this.child;
    if (child) {
      child.stdin.end(); child.kill();
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref();
    }
  }
  probe(token) {
    const args = sshArgs({ ...this.options, interactive: false }, 'unused');
    args.splice(args.indexOf('-R'));
    args.push(this.options.host, "curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' --config -");
    return new Promise((resolve, reject) => {
      let body = ''; let settled = false;
      const child = this.spawnProcess(this.options.sshPath || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.options.auth?.env });
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { child.kill(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('远端连通性检测超时')), 20000);
      child.stdout.on('data', chunk => { body = (body + chunk).slice(-128); });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', finish);
      child.once('close', code => {
        if (code !== 0 || body.trim() !== '200') finish(new Error(`远端网关检测失败 (SSH/curl=${code}, HTTP=${body.trim() || '无响应'})；确认远端已安装 curl、SSH Host 与当前工作区一致`));
        else finish();
      });
      // Session capability goes over encrypted stdin, never the process argument list.
      child.stdin.end(`url = "http://127.0.0.1:${this.options.remotePort}/v1/models"\nheader = "Authorization: Bearer ${token}"\n`);
    });
  }
}
module.exports = { Tunnel, sshArgs, validateHost };
