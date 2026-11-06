'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners, once } = require('node:events');
const { spawn } = require('node:child_process');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { PassThrough } = require('node:stream');
const { Tunnel, sshArgs, validateHost } = require('../src/tunnel');

const options = { host: 'my-server', remotePort: 13425, localPort: 42123 };
function child() {
  const p = new EventEmitter();
  p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.exitCode = null; p.signalCode = null; p.kills = [];
  p.kill = (signal = 'SIGTERM') => {
    p.killed = true; p.kills.push(signal);
    queueMicrotask(() => {
      if (p.exitCode === null && p.signalCode === null) { p.signalCode = signal; p.emit('close', null, signal); }
    });
    return true;
  };
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
test('explicit SSH port is passed to both tunnel and probe separately from forwarding ports', async () => {
  const opts = { ...options, host: 'alice@server', sshPort: 2222 };
  const args = sshArgs(opts, 'READY');
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:13425:127.0.0.1:42123');
  const p = child(); let probeArgs;
  const tunnel = new Tunnel(opts, (_, args) => {
    probeArgs = args; setImmediate(() => { p.stdout.write('200'); p.emit('close', 0); }); return p;
  });
  await tunnel.probe('token');
  assert.equal(probeArgs[probeArgs.indexOf('-p') + 1], '2222');
  assert.equal(probeArgs.at(-2), 'alice@server');
  for (const sshPort of [0, 65536, '22', 22.5]) assert.throws(() => sshArgs({ ...opts, sshPort }, 'READY'));
});

test('validates IPv6 destinations without admitting options, shell syntax or malformed users', () => {
  for (const host of ['::1', '::', '::ffff:192.0.2.1', 'alice@2001:db8::1', '[::1]', 'alice@[::1]', 'fe80::1%en0']) {
    assert.equal(validateHost(host), host);
    assert.equal(sshArgs({ ...options, host }, 'READY').at(-2), host);
  }
  for (const host of ['user@@host', '@host', 'user@-host', '-user@::1', 'user name@::1', '::1;id',
    '::1%$(id)', '::1%en0 x', 'user@[::1] -oProxyCommand=evil', '[127.0.0.1]', 'host:22', 'name[::1]', '\n::1']) {
    assert.throws(() => validateHost(host), undefined, host);
  }
});
test('already aborted start and probe do not spawn children', async () => {
  let calls = 0;
  const tunnel = new Tunnel(options, () => { calls++; return child(); });
  const signal = AbortSignal.abort();
  await assert.rejects(tunnel.start({ signal }), { name: 'AbortError' });
  await assert.rejects(tunnel.probe('token', { signal }), { name: 'AbortError' });
  tunnel.stop(); tunnel.stop(); assert.equal(calls, 0);
});
test('aborting start rejects immediately, kills once and removes cancellation and child listeners', async () => {
  const p = child(); const controller = new AbortController();
  const tunnel = new Tunnel(options, () => p);
  const pending = tunnel.start({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  tunnel.stop(); tunnel.stop(); await nextTurn();
  assert.deepEqual(p.kills, ['SIGTERM']); assert.equal(p.stdin.writableEnded, true); assert.equal(tunnel.child, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  for (const event of ['error', 'close']) assert.equal(p.listenerCount(event), 0);
  for (const stream of [p.stdin, p.stdout, p.stderr]) assert.equal(stream.listenerCount('error'), 0);
});
test('stop cancels a pending start and every outstanding probe immediately and is idempotent', async () => {
  const children = [child(), child(), child()]; let index = 0;
  const tunnel = new Tunnel(options, () => children[index++]);
  const pending = [tunnel.start(), tunnel.probe('first'), tunnel.probe('second')];
  const results = Promise.all(pending.map(promise => assert.rejects(promise, { name: 'AbortError' })));
  tunnel.stop(); tunnel.stop(); await results; await nextTurn();
  for (const p of children) { assert.deepEqual(p.kills, ['SIGTERM']); assert.equal(p.listenerCount('close'), 0); }
  assert.equal(tunnel.pending.size, 0); assert.equal(tunnel.child, undefined);
});
test('successful readiness releases its abort listener and duplicate starts cannot spawn a second master', async () => {
  const p = child(); const controller = new AbortController(); let calls = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    calls++;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => p.stdout.write(marker + '\n')); return p;
  });
  await tunnel.start({ signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(); assert.equal(p.killed, undefined);
  await assert.rejects(tunnel.start(), /已在运行/); assert.equal(calls, 1);
  tunnel.stop(); await nextTurn();
});
test('a main child closing during a probe cannot turn a buffered HTTP 200 into success', async () => {
  const main = child(); const probe = child(); let count = 0; const closed = [];
  const tunnel = new Tunnel(options, (_, args) => {
    if (count++ === 0) {
      const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
      setImmediate(() => main.stdout.write(marker + '\n')); return main;
    }
    return probe;
  });
  tunnel.on('closed', message => closed.push(message));
  await tunnel.start();
  const pending = tunnel.probe('token');
  probe.stdout.write('200'); main.emit('close', 255); probe.emit('close', 0);
  await assert.rejects(pending, /SSH/);
  assert.equal(probe.killed, true); assert.equal(tunnel.child, undefined); assert.equal(closed.length, 1);
  tunnel.stop(); await nextTurn();
});
test('aborting a probe after HTTP output still rejects and removes signal listeners', async () => {
  const p = child(); const controller = new AbortController();
  const tunnel = new Tunnel(options, () => p);
  const pending = tunnel.probe('token', { signal: controller.signal });
  p.stdout.write('200'); controller.abort(); p.emit('close', 0);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(p.kills, ['SIGTERM']); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('spawn failures reject without leaked abort listeners and allow a later attempt', async () => {
  const controller = new AbortController(); const failure = new Error('spawn failed');
  let fail = true; const p = child();
  const tunnel = new Tunnel(options, () => {
    if (fail) throw failure;
    setImmediate(() => { p.stdout.write('200'); p.emit('close', 0); }); return p;
  });
  await assert.rejects(tunnel.start({ signal: controller.signal }), error => error === failure);
  await assert.rejects(tunnel.probe('token', { signal: controller.signal }), error => error === failure);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  fail = false; await tunnel.probe('token', { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  tunnel.stop(); assert.deepEqual(p.kills, []);
});
test('late close from a stopped child cannot clear a restarted tunnel', async () => {
  const old = child(); const current = child(); let count = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    const p = count++ === 0 ? old : current;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => { if (!p.killed) p.stdout.write(marker + '\n'); }); return p;
  });
  const first = tunnel.start(); tunnel.stop();
  const second = tunnel.start();
  await assert.rejects(first, { name: 'AbortError' }); await second;
  assert.equal(tunnel.child, current); tunnel.stop(); await nextTurn();
});
test('probe rejects configuration injection and oversized output without leaving children running', async () => {
  const p = child(); let calls = 0;
  const tunnel = new Tunnel(options, () => { calls++; return p; });
  await assert.rejects(tunnel.probe('token"\nurl = "http://other'), /Invalid bridge session token/);
  assert.equal(calls, 0);
  const pending = tunnel.probe('token'); p.stdout.write('x'.repeat(129));
  await assert.rejects(pending, /响应过长/); assert.equal(p.killed, true); await nextTurn();
});
test('stop terminates actual local children used for both start and probe', { timeout: 5000 }, async t => {
  const children = [];
  const tunnel = new Tunnel(options, (_, args, spawnOptions) => {
    // A local stand-in only: no SSH or remote connection is launched.
    const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.stdout.write("waiting");'], spawnOptions);
    children.push(p); return p;
  });
  t.after(() => { tunnel.stop(); for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
  const start = tunnel.start(); const probe = tunnel.probe('token');
  const results = Promise.all([start, probe].map(promise => assert.rejects(promise, { name: 'AbortError' })));
  await Promise.all(children.map(p => once(p.stdout, 'data')));
  const closed = children.map(p => once(p, 'close'));
  tunnel.stop(); await results; await Promise.all(closed);
  for (const p of children) assert.ok(p.exitCode !== null || p.signalCode !== null);
});

test('cancelling a probe leaves a successfully started tunnel running', async () => {
  const { getEventListeners } = require('node:events');
  const main = child(); const probe = child(); let calls = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    if (calls++ > 0) return probe;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => main.stdout.write(marker)); return main;
  });
  const startController = new AbortController();
  await tunnel.start({ signal: startController.signal });
  assert.equal(getEventListeners(startController.signal, 'abort').length, 0);
  const controller = new AbortController();
  const pending = tunnel.probe('token', { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(probe.killed, true); assert.equal(main.killed, undefined); assert.equal(tunnel.child, main);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); tunnel.stop();
});
test('main close in the same turn as a successful probe cannot produce false success', async () => {
  const main = child(); const probe = child(); let calls = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    if (calls++ > 0) return probe;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => main.stdout.write(marker)); return main;
  });
  await tunnel.start();
  const pending = tunnel.probe('token'); const rejected = assert.rejects(pending, /SSH/);
  probe.stdout.write('200'); probe.emit('close', 0); main.emit('close', 255);
  await rejected;
});
test('readiness marker followed immediately by process close still rejects start', async () => {
  const p = child();
  const tunnel = new Tunnel(options, (_, args) => {
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => { p.stdout.write(marker); p.emit('close', 255); }); return p;
  });
  await assert.rejects(tunnel.start(), /SSH 已退出/);
});
test('start timeout escalates a child that ignores termination and close clears process listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = child(); const signals = []; p.kill = signal => { signals.push(signal || 'SIGTERM'); return true; };
  const tunnel = new Tunnel(options, () => p);
  const pending = tunnel.start(); const rejected = assert.rejects(pending, /超时/);
  t.mock.timers.tick(25000); await rejected;
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(2000); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  p.emit('close', null);
  for (const emitter of [p, p.stdin, p.stdout, p.stderr]) assert.equal(emitter.listenerCount('error'), 0);
  assert.equal(tunnel.processes.size, 0); assert.equal(tunnel.pending.size, 0);
});
test('late pipe and process errors after abort are handled until the child closes', async () => {
  const p = child(); p.kill = () => true;
  const controller = new AbortController(); const tunnel = new Tunnel(options, () => p);
  const pending = tunnel.start({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  p.emit('error', new Error('late process failure')); p.stdin.emit('error', new Error('EPIPE'));
  p.emit('close', null);
  assert.equal(tunnel.processes.size, 0);
});
test('old child closing after a restart does not clear or close the replacement tunnel', async () => {
  const old = child(); old.kill = () => true; const replacement = child(); let calls = 0; let closures = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    const p = calls++ ? replacement : old;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    setImmediate(() => p.stdout.write(marker)); return p;
  });
  tunnel.on('closed', () => { closures++; });
  await tunnel.start(); tunnel.stop(); await tunnel.start(); old.emit('close', 0);
  assert.equal(tunnel.child, replacement); assert.equal(closures, 0); tunnel.stop();
});

test('CLI inspection reuses private authentication with strict host verification and bounded protocol output', async () => {
  for (const executable of ['/usr/bin/codex', '/home/alice/.local/bin/codex', 'MISSING']) {
    const p = child(); let checkArgs; let script = '';
    p.stdin.on('data', chunk => { script += chunk; });
    const tunnel = new Tunnel({ ...options, auth: { controlPath: '/private/ctl', env: { SSH_ASKPASS_REQUIRE: 'force' } } }, (_, args) => {
      checkArgs = args;
      setImmediate(() => {
        const marker = script.match(/MAGPIE_CLI_[A-F0-9]+/)[0];
        p.stdout.write(`profile banner\n\x1b[3J${marker}\t${executable}\n`); p.emit('close', 0);
      });
      return p;
    });
    assert.equal(await tunnel.checkCli('codex'), executable === 'MISSING' ? undefined : executable);
    for (const option of ['BatchMode=yes', 'ControlPath=/private/ctl', 'StrictHostKeyChecking=yes']) assert.ok(checkArgs.includes(option));
    assert.ok(!checkArgs.includes('-R'));
    assert.equal(checkArgs.at(-1), 'sh -s');
    assert.match(script, /\.local\/bin\/codex/);
  }
});

test('CLI inspection rejects SSH, malformed and oversized responses rather than treating them as missing', async () => {
  for (const mode of ['ssh-error', 'no-marker', 'invalid-path', 'duplicate', 'oversized']) {
    const p = child(); let script = '';
    p.stdin.on('data', chunk => { script += chunk; });
    const tunnel = new Tunnel(options, () => {
      setImmediate(() => {
        const marker = script.match(/MAGPIE_CLI_[A-F0-9]+/)[0];
        const responses = { 'ssh-error': '', 'no-marker': 'banner only', 'invalid-path': `${marker}\tcodex\n`,
          duplicate: `${marker}\t/usr/bin/codex\n${marker}\tMISSING\n`, oversized: 'x'.repeat(16385) };
        p.stdout.write(responses[mode]); p.emit('close', mode === 'ssh-error' ? 255 : 0);
      }); return p;
    });
    await assert.rejects(tunnel.checkCli('codex'), /check|path|limit/i);
    assert.equal(tunnel.pending.size, 0);
  }
});

test('CLI inspection cancellation and timeout terminate only the inspection child', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const main = child(), check = child(), timeout = child(); let calls = 0;
  const tunnel = new Tunnel(options, (_, args) => {
    const p = [main, check, timeout][calls++];
    if (p === main) {
      const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
      queueMicrotask(() => p.stdout.write(marker));
    }
    return p;
  });
  await tunnel.start();
  const controller = new AbortController();
  const cancelled = tunnel.checkCli('codex', { signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(check.killed, true);
  assert.equal(main.killed, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const timed = tunnel.checkCli('claude'); const expired = assert.rejects(timed, /timed out/);
  t.mock.timers.tick(15000); await expired;
  assert.equal(timeout.killed, true);
  assert.equal(main.killed, undefined);
  assert.equal(tunnel.child, main);
  tunnel.stop();
});

test('already cancelled CLI inspection never spawns and a closed master invalidates buffered results', async () => {
  let calls = 0; const main = child(), check = child(); let script = '';
  check.stdin.on('data', chunk => { script += chunk; });
  const tunnel = new Tunnel(options, (_, args) => {
    if (calls++ > 0) return check;
    const marker = args.at(-1).match(/MAGPIE_BRIDGE_READY_[0-9a-f]+/)[0];
    queueMicrotask(() => main.stdout.write(marker)); return main;
  });
  await assert.rejects(tunnel.checkCli('codex', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await tunnel.start();
  const pending = tunnel.checkCli('claude'); const rejected = assert.rejects(pending, /SSH/);
  const marker = script.match(/MAGPIE_CLI_[A-F0-9]+/)[0];
  check.stdout.write(`${marker}\t/usr/bin/claude\n`); check.emit('close', 0); main.emit('close', 255);
  await rejected; tunnel.stop();
});
