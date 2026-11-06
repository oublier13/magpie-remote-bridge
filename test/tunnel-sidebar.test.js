'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Tunnel } = require('../src/tunnel');

const options = { host: 'user@server', remotePort: 13425, localPort: 49123, auth: { controlPath: '/private/session/ctl' } };
function child() {
  const p = new EventEmitter();
  p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.exitCode = null; p.signalCode = null;
  p.kill = () => { p.killed = true; queueMicrotask(() => { p.signalCode = 'SIGTERM'; p.emit('close', null); }); return true; };
  return p;
}

test('credential forward stays separate from the API master and revokes on tunnel stop', async () => {
  const children = []; const argsList = [];
  const tunnel = new Tunnel(options, (_, args) => {
    const p = child(); children.push(p); argsList.push(args);
    const marker = args.at(-1).match(/MAGPIE_(?:BRIDGE|CREDENTIAL)_READY_[a-f0-9]+/)[0];
    queueMicrotask(() => p.stdout.write(marker + '\n')); return p;
  });
  await tunnel.start(); const master = tunnel.child;
  const forward = await tunnel.openCredentialForward('/tmp/local/c.sock', '/tmp/remote/c.sock');
  assert.equal(tunnel.child, master); assert.equal(tunnel.processes.size, 2);
  const args = argsList[1];
  assert.equal(args[args.indexOf('-R') + 1], '/tmp/remote/c.sock:/tmp/local/c.sock');
  for (const value of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ControlPath=/private/session/ctl']) assert.ok(args.includes(value));
  let closed = false; forward.once('closed', () => { closed = true; });
  tunnel.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(children.every(p => p.killed)); assert.equal(closed, true); assert.equal(tunnel.processes.size, 0);
});

test('a failed socket forward does not destroy the established API master', async () => {
  const master = child(); const failed = child(); let calls = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    if (calls++ === 0) {
      queueMicrotask(() => master.stdout.write(args.at(-1).match(/MAGPIE_BRIDGE_READY_[a-f0-9]+/)[0]));
      return master;
    }
    queueMicrotask(() => failed.emit('close', 255)); return failed;
  });
  await tunnel.start();
  await assert.rejects(tunnel.openCredentialForward('/tmp/local/socket', '/tmp/remote/socket'), /forwarding closed/);
  assert.equal(tunnel.child, master); assert.equal(master.killed, undefined); tunnel.stop();
});

test('invalid socket paths and cancelled forwarding never spawn SSH', async () => {
  let calls = 0; const tunnel = new Tunnel(options, () => { calls++; return child(); });
  for (const value of ['relative', '/tmp/a:b', '/tmp/line\nbreak', '/tmp/has space', '/' + 'x'.repeat(100)]) {
    assert.throws(() => tunnel.openCredentialForward(value, '/tmp/valid'), /Invalid/);
    assert.throws(() => tunnel.openCredentialForward('/tmp/valid', value), /Invalid/);
  }
  await assert.rejects(tunnel.openCredentialForward('/tmp/local', '/tmp/remote', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('Codex setup uses strict SSH and isolated Python stdin without credentials in arguments', async () => {
  const p = child(); let input = ''; let commandArgs;
  p.stdin.on('data', data => { input += data; });
  const tunnel = new Tunnel(options, (_, args) => {
    commandArgs = args;
    setImmediate(() => { p.stdout.write('login banner\n{"version":"fixture-version","ok":true}\n'); p.emit('close', 0); }); return p;
  });
  const request = { operation: 'prepare', owner: 'a'.repeat(32) };
  assert.equal((await tunnel.codex(request)).version, 'fixture-version');
  assert.equal(commandArgs.at(-1), 'python3 -I -'); assert.ok(!commandArgs.includes('-R'));
  assert.ok(commandArgs.includes('StrictHostKeyChecking=yes')); assert.ok(commandArgs.includes('BatchMode=yes'));
  assert.ok(!commandArgs.join().includes(request.owner));
  const encoded = input.match(/main\(json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)\)\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), request);
  await assert.rejects(tunnel.codex({ operation: 'prepare', token: 'forbidden' }), /Invalid/);
  await assert.rejects(tunnel.codex({ operation: 'arbitrary-shell' }), /Invalid/);
});

test('Codex protocol errors omit remote messages, malformed JSON and stderr credentials', async () => {
  for (const output of ['{"ok":false,"code":"LEASE_EXISTS","message":"private-remote-value"}\n', '{"ok":true,broken-private-remote-value\n', '{"unrecognized":true}\n', 'ssh-failure']) {
    const p = child(); const tunnel = new Tunnel(options, () => {
      setImmediate(() => { p.stdout.write(output); p.stderr.write('private-remote-value'); p.emit('close', output === 'ssh-failure' ? 255 : 0); }); return p;
    });
    await assert.rejects(tunnel.codex({ operation: 'inspect' }), error => {
      assert.ok(!error.message.includes('private-remote-value'));
      if (output.includes('LEASE_EXISTS')) assert.equal(error.code, 'LEASE_EXISTS');
      return true;
    });
  }
});
