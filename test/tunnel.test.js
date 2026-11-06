'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Tunnel, sshArgs, validateHost } = require('../src/tunnel');

const options = { host: 'my-server', remotePort: 13425, localPort: 42123 };
function child() {
  const p = new EventEmitter();
  p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.kill = () => { p.killed = true; };
  return p;
}
test('SSH args use reverse loopback, fail-on-forward-error and do not reuse a control master', () => {
  const args = sshArgs({ ...options, configFile: '/path with spaces/config' }, 'MARKER');
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:13425:127.0.0.1:42123');
  for (const option of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ControlPath=none', 'StrictHostKeyChecking=yes']) assert.ok(args.includes(option));
  assert.equal(args[args.indexOf('-F') + 1], '/path with spaces/config');
  for (const host of ['-oProxyCommand=evil', 'foo bar', 'host;touch /tmp/x', '$(evil)', '']) assert.throws(() => validateHost(host));
  assert.equal(validateHost('user@server.example'), 'user@server.example');
});
test('waits for random readiness marker even when split across chunks', async () => {
  const p = child();
  const tunnel = new Tunnel(options, (_, args) => {
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => {
      p.stdout.write('login banner\n' + marker.slice(0, 12));
      p.stdout.write(marker.slice(12) + '\n');
    });
    return p;
  });
  await tunnel.start(); tunnel.stop(); assert.equal(p.killed, true);
});
test('reports forwarding failure rather than marking the tunnel connected', async () => {
  const p = child();
  const tunnel = new Tunnel(options, () => {
    setImmediate(() => { p.stderr.write('remote port forwarding failed'); p.emit('close', 255); }); return p;
  });
  await assert.rejects(tunnel.start(), /forwarding failed/);
});
test('remote probe sends session token in stdin only, checks HTTP response', async () => {
  const p = child(); let input = ''; let commandArgs;
  p.stdin.on('data', c => { input += c; });
  const tunnel = new Tunnel(options, (_, args) => {
    commandArgs = args;
    setImmediate(() => { p.stdout.write('200'); p.emit('close', 0); }); return p;
  });
  await tunnel.probe('private-capability');
  assert.ok(input.includes('Bearer private-capability'));
  assert.ok(!commandArgs.join(' ').includes('private-capability'));
  assert.ok(!commandArgs.includes('-R'));
});
test('remote probe rejects HTTP errors', async () => {
  const p = child();
  const tunnel = new Tunnel(options, () => {
    setImmediate(() => { p.stdout.write('401'); p.emit('close', 0); }); return p;
  });
  await assert.rejects(tunnel.probe('token'), /HTTP=401/);
});
test('password mode uses a private control socket and probes never request another password', async () => {
  const auth = { controlPath: '/tmp/private-session/ctl', env: { SSH_ASKPASS_REQUIRE: 'force' } };
  const args = sshArgs({ ...options, auth }, 'READY');
  assert.ok(args.includes('BatchMode=no')); assert.ok(args.includes('ControlPath=/tmp/private-session/ctl'));
  assert.ok(args.includes('ControlMaster=auto')); assert.ok(args.includes('ControlPersist=no'));
  const p = child(); let probeArgs;
  const tunnel = new Tunnel({ ...options, auth }, (_, args) => {
    probeArgs = args; setImmediate(() => { p.stdout.write('200'); p.emit('close', 0); }); return p;
  });
  await tunnel.probe('token'); assert.ok(probeArgs.includes('BatchMode=yes'));
});
