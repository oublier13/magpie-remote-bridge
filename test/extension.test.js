'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush } = require('./helpers/vscode');
const { storageKey } = require('../src/host-picker');
const manifest = require('../package.json');

test('connects once, probes, launches remotely and revokes resources on disconnect', async t => {
  const f = fixture(); t.after(f.dispose);
  await Promise.all([f.run('connect'), f.run('connect')]);
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.tunnels[0].probed, 'session-token');
  await f.run('codex');
  const terminal = f.terminals[0];
  assert.equal(terminal.options.cwd.path, '/remote/project');
  assert.equal(terminal.options.env.MAGPIE_BRIDGE_TOKEN, 'session-token');
  assert.equal(terminal.options.isTransient, true);
  assert.ok(terminal.command.startsWith('codex '));
  assert.ok(!terminal.command.includes('session-token'));
  await f.run('disconnect');
  assert.ok(terminal.disposed && f.tunnels[0].stopped && f.proxies[0].closed);
  assert.ok(!f.logs.join().includes('session-token'));
  assert.deepEqual(f.errors, []);
});

test('a real local workspace and an untrusted workspace cannot start a tunnel', async t => {
  for (const options of [{ remoteName: undefined }, { trusted: false }]) {
    const f = fixture(options); t.after(f.dispose);
    await f.run('claude');
    assert.equal(f.tunnels.length, 0);
    assert.equal(f.terminals.length, 0);
    assert.equal(f.errors.length, 1);
  }
});

test('all contributed command IDs have an implementation', t => {
  const f = fixture(); t.after(f.dispose);
  assert.deepEqual([...f.commands.keys()].sort(), manifest.contributes.commands.map(command => command.command).sort());
});

test('disconnect during SSH startup cannot resurrect a session', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = fixture({ start: () => hold }); t.after(f.dispose);
  const pending = f.run('connect'); await flush();
  assert.equal(f.tunnels.length, 1);
  await f.run('disconnect'); release(); await pending;
  assert.ok(f.proxies[0].closed && f.tunnels[0].stopped);
  assert.equal(f.errors.length, 0);
});

test('notification cancellation stops connection without showing a failure', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = fixture({ start: () => hold }); t.after(f.dispose);
  const pending = f.run('connect'); await flush();
  f.notifications[0].cancel(); release(); await pending;
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.errors.length, 0);
  assert.match(f.status.text, /Disconnected/);
});

test('encoded authority preserves user and explicit port, then migrates to separate storage', async t => {
  const authority = 'ssh-remote+' + Buffer.from(JSON.stringify({ hostName: '192.0.2.103', user: 'remote-user', port: 2222 })).toString('hex');
  const f = fixture({ authority }); t.after(f.dispose);
  await f.run('connect');
  assert.equal(f.picks[0][0].label, 'remote-user@192.0.2.103');
  assert.equal(f.tunnels[0].options.sshPort, 2222);
  assert.deepEqual(f.state[storageKey(authority)], { host: 'remote-user@192.0.2.103', sshPort: 2222 });
});

test('repairs raw hex mapping without replacing intentional aliases', async t => {
  const raw = Buffer.from(JSON.stringify({ hostName: 'host', user: 'alice' })).toString('hex');
  const authority = `ssh-remote+${raw}`;
  const f = fixture({ authority, hosts: { [authority]: raw } }); t.after(f.dispose);
  await f.run('connect');
  assert.equal(f.picks.length, 0);
  assert.equal(f.tunnels[0].options.host, 'alice@host');
  assert.ok(f.logs.some(line => line.includes('Repaired')));
  const g = fixture({ authority, hosts: { [authority]: 'custom-alias' } }); t.after(g.dispose);
  await g.run('connect');
  assert.equal(g.tunnels[0].options.host, 'custom-alias');
});

test('malformed encoded authority still permits manual user@host:port input', async t => {
  const f = fixture({ authority: 'ssh-remote+7b', select: items => items.find(item => item.manual), input: async () => 'alice@host:2222' });
  t.after(f.dispose);
  await f.run('connect');
  assert.ok(!f.picks[0].some(item => item.label === '7b'));
  assert.equal(f.tunnels[0].options.host, 'alice@host');
  assert.equal(f.tunnels[0].options.sshPort, 2222);
});

test('SSH aliases are read from deterministic input and wildcard patterns excluded', async t => {
  const f = fixture({ sshConfig: 'Host first second # comment\n  Host * !excluded\nHost third\nMatch host *\n' }); t.after(f.dispose);
  await f.run('connect');
  assert.deepEqual(f.picks[0].filter(item => !item.manual).map(item => item.label), ['my-server', 'first', 'second', 'third']);
});

test('changing host during selection cancels the stale picker and starts a fresh connection', async t => {
  let release;
  let selections = 0;
  const f = fixture({ select: items => ++selections === 1 ? new Promise(resolve => { release = () => resolve(items[0]); }) : items[0] });
  t.after(f.dispose);
  const old = f.run('connect'); await flush();
  const fresh = f.run('changeHost'); await flush();
  release(); await Promise.all([old, fresh]);
  assert.equal(f.picks.length, 2);
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.errors.length, 0);
});

test('copy details, diagnostics and model reset work without recreating a live session', async t => {
  const f = fixture(); t.after(f.dispose);
  await f.run('connect');
  await f.run('copyConnection');
  assert.deepEqual(JSON.parse(f.clipboard[0]), { openaiBaseUrl: 'http://127.0.0.1:13425/v1', anthropicBaseUrl: 'http://127.0.0.1:13425', apiKey: 'session-token', model: 'vendor/model' });
  await f.run('diagnose');
  assert.ok(f.infos.some(message => message.includes('Remote HTTP access verified')));
  await f.run('model');
  assert.equal(f.values.model, '');
  assert.equal(f.tunnels.length, 1);
});

test('gateway key can be saved or cleared and changing it revokes the session', async t => {
  for (const value of ['new-key', '']) {
    const f = fixture({ input: async () => value, secrets: { gatewayKey: 'old-key' } }); t.after(f.dispose);
    await f.run('connect'); await f.run('key');
    assert.equal(f.secrets.gatewayKey, value || undefined);
    assert.equal(f.proxies[0].closed, true);
    assert.ok(!f.logs.join().includes('old-key'));
  }
});

test('auto-connect requires a saved host and a trusted SSH workspace', async t => {
  const a = fixture({ values: { autoConnect: true }, hosts: { 'ssh-remote+my-server': 'my-server' } }); t.after(a.dispose);
  const b = fixture({ values: { autoConnect: true } }); t.after(b.dispose);
  const c = fixture({ values: { autoConnect: true }, trusted: false, hosts: { 'ssh-remote+my-server': 'my-server' } }); t.after(c.dispose);
  await flush();
  assert.equal(a.tunnels.length, 1);
  assert.equal(b.tunnels.length, 0);
  assert.equal(c.tunnels.length, 0);
});

test('status bar opens actions and menu dispatches without altering existing sessions', async t => {
  const f = fixture(); t.after(f.dispose);
  assert.equal(f.status.command, 'magpieBridge.menu');
  await f.run('menu');
  assert.equal(f.terminals.length, 1);
  assert.equal(f.proxies.length, 1);
});

test('legacy extension warning and actionable gateway errors are shown', async t => {
  const f = fixture({ legacy: true, getModels: async () => { throw new Error('ECONNREFUSED'); } }); t.after(f.dispose);
  await f.run('connect');
  assert.equal(f.warnings.length, 1);
  assert.match(f.errors[0], /Start Magpie/);
  assert.equal(f.proxies.length, 0);
  assert.match(f.status.text, /Connection failed/);
});

test('cancelling the password box aborts the whole connection quietly', async t => {
  let closed = false;
  const f = fixture({
    startAuth: async prompt => {
      const password = await prompt('Password:');
      assert.equal(password, undefined);
      return { close() { closed = true; } };
    },
    input: async () => undefined
  });
  t.after(f.dispose);
  await f.run('connect');
  assert.equal(f.inputs.length, 1);
  assert.equal(f.tunnels.length, 0);
  assert.equal(f.proxies[0].closed, true);
  assert.equal(closed, true);
  assert.equal(f.errors.length, 0);
});

test('different workspace windows save independent host keys even when selection overlaps', async t => {
  let release;
  const a = fixture({ authority: 'ssh-remote+server-a', select: items => new Promise(resolve => { release = () => resolve(items[0]); }) });
  const b = fixture({ authority: 'ssh-remote+server-b' });
  t.after(a.dispose); t.after(b.dispose);
  b.context.globalState = a.context.globalState;
  const pendingA = a.run('connect'); await flush();
  await b.run('connect');
  release(); await pendingA;
  assert.equal(a.state[storageKey('ssh-remote+server-a')].host, 'server-a');
  assert.equal(a.state[storageKey('ssh-remote+server-b')].host, 'server-b');
});

test('retry from a diagnostic failure repeats diagnostics without starting SSH', async t => {
  let calls = 0;
  const f = fixture({
    getModels: async () => { if (++calls === 1) throw new Error('offline'); return ['model']; },
    errorAction: actions => actions.find(action => action === 'Retry')
  });
  t.after(f.dispose);
  await f.run('diagnose');
  assert.equal(calls, 2);
  assert.equal(f.tunnels.length, 0);
  assert.ok(f.infos.some(message => message.includes('not connected')));
});

test('connection-setting changes apply only after choosing reconnect', async t => {
  const f = fixture({ infoAction: actions => actions.find(action => action === 'Reconnect') });
  t.after(f.dispose);
  await f.run('terminal');
  f.values.remotePort = 14444;
  await f.listeners.configuration({ affectsConfiguration: key => key === 'magpieBridge.remotePort' });
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.terminals[0].disposed, true);
  assert.equal(f.tunnels[1].options.remotePort, 14444);
});

test('cancel does not wait for a stalled SSH config file read', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture({ readFile: () => waiting }); t.after(f.dispose);
  let finished = false;
  const pending = f.run('connect').then(() => { finished = true; });
  await flush(); f.notifications[0].cancel(); await flush();
  assert.equal(finished, true);
  assert.equal(f.errors.length, 0);
  release('Host delayed'); await pending;
});

test('same-host candidates retain the encoded workspace port and deduplicate', async t => {
  const authority = 'ssh-remote+' + Buffer.from(JSON.stringify({ hostName: 'host', user: 'alice', port: 2222 })).toString('hex');
  const f = fixture({ authority, values: { sshHost: 'alice@host' }, select: items => items.find(item => item.description === 'Configured default') || items[0] });
  t.after(f.dispose);
  await f.run('connect');
  assert.equal(f.picks[0].filter(item => item.label === 'alice@host').length, 1);
  assert.equal(f.tunnels[0].options.sshPort, 2222);
});

test('simultaneous forget operations cannot restore each other through the legacy map', async t => {
  const a = fixture({ authority: 'ssh-remote+a', hosts: { 'ssh-remote+a': 'old-a', 'ssh-remote+b': 'old-b' }, select: () => undefined });
  const b = fixture({ authority: 'ssh-remote+b', select: () => undefined });
  t.after(a.dispose); t.after(b.dispose);
  b.context.globalState = a.context.globalState;
  await Promise.all([a.run('changeHost'), b.run('changeHost')]);
  assert.equal(a.state[storageKey('ssh-remote+a')], null);
  assert.equal(a.state[storageKey('ssh-remote+b')], null);
  assert.equal(a.tunnels.length + b.tunnels.length, 0);
});

test('an old settings prompt cannot close a replacement session or its terminals', async t => {
  let release;
  const f = fixture({ infoAction: () => new Promise(resolve => { release = resolve; }) }); t.after(f.dispose);
  await f.run('connect');
  f.values.remotePort = 14444;
  const prompt = f.listeners.configuration({ affectsConfiguration: key => key === 'magpieBridge.remotePort' });
  await flush();
  await f.run('disconnect'); await f.run('claude');
  release('Reconnect'); await prompt;
  assert.equal(f.tunnels.length, 2);
  assert.equal(f.terminals[0].disposed, undefined);
  assert.equal(f.proxies[1].closed, undefined);
});

test('one shared connection failure displays one error notification', async t => {
  const f = fixture({ getModels: async () => { throw new Error('offline'); } }); t.after(f.dispose);
  await Promise.all([f.run('connect'), f.run('connect')]);
  assert.equal(f.errors.length, 1);
});

test('joining a reconnect reports the current attempt in the progress notification', async t => {
  const { Clock } = require('./helpers/clock');
  const clock = new Clock();
  const f = fixture({ values: { autoReconnect: true }, clock }); t.after(f.dispose);
  await f.run('connect');
  f.tunnels[0].emit('closed', 'offline'); await flush();
  const pending = f.run('terminal');
  assert.equal(f.progressMessages.at(-1), 'Reconnecting 1/3');
  await clock.advance(1000); await pending;
  assert.equal(f.terminals.length, 1);
});
