'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, authorityTarget, savedTarget } = require('../src/host');
const encoded = data => `ssh-remote+${Buffer.from(JSON.stringify(data)).toString('hex')}`;

test('parses SSH aliases and user@host without changing case or inventing a port', () => {
  for (const host of ['my-server', 'My-Server', '_local', 'deadbeef', '192.0.2.103', 'alice@My-Server', 'remote-user@192.0.2.103']) {
    assert.deepEqual(parseTarget(host), { host }, host);
  }
});
test('parses an explicit SSH port independently from the SSH destination', () => {
  for (const [input, host, sshPort] of [
    ['my-server:2222', 'my-server', 2222],
    ['alice@My-Server:2222', 'alice@My-Server', 2222],
    ['remote-user@192.0.2.103:1', 'remote-user@192.0.2.103', 1],
    ['192.0.2.103:65535', '192.0.2.103', 65535],
    ['server:00022', 'server', 22]
  ]) {
    assert.deepEqual(parseTarget(input), { host, sshPort }, input);
  }
});
test('normalizes bracketed IPv6 destinations to raw IPv6 before ssh', () => {
  for (const [input, target] of [
    ['[2001:db8::1]', { host: '2001:db8::1' }],
    ['alice@[2001:db8::1]', { host: 'alice@2001:db8::1' }],
    ['[2001:DB8::1]:2222', { host: '2001:DB8::1', sshPort: 2222 }],
    ['alice@[2001:db8::1]:2222', { host: 'alice@2001:db8::1', sshPort: 2222 }],
    ['[::1]:1', { host: '::1', sshPort: 1 }],
    ['alice@[::]:65535', { host: 'alice@::', sshPort: 65535 }],
    ['[::ffff:192.0.2.103]:22', { host: '::ffff:192.0.2.103', sshPort: 22 }]
  ]) {
    assert.deepEqual(parseTarget(input), target, input);
  }
});
test('keeps raw IPv6 intact without interpreting its last segment as an SSH port', () => {
  for (const host of ['2001:db8::1', '2001:db8::1:2222', 'alice@2001:db8::1:2222', '::1', '::', '::ffff:192.0.2.103', 'alice@::1']) {
    assert.deepEqual(parseTarget(host), { host }, host);
  }
});
test('rejects malformed brackets, invalid IPv6 and ambiguous address syntax', () => {
  for (const input of ['[server]', '[192.0.2.103]:22', '[]', '[::1', '::1]', '[[::1]]', '[::1]]',
    '[::1]extra', '[::1]:22:33', 'server[::1]', '2001:db8::xyz', '2001:db8:::1', 'server:22:33', ':22',
    'alice@@server', '@server', 'alice@', '-alice@server', 'alice@-server', 'ssh://server:22']) {
    assert.throws(() => parseTarget(input), undefined, input);
  }
});
test('rejects invalid SSH ports for both hostnames and bracketed IPv6', () => {
  for (const host of ['server', 'alice@server', '[::1]', 'alice@[2001:db8::1]']) {
    for (const port of ['', '0', '-1', '65536', '22.5', '+22', '0x16', '2e1', 'NaN', 'Infinity', '22extra', '9999999999999999999999999999']) {
      const input = `${host}:${port}`;
      assert.throws(() => parseTarget(input), undefined, input);
    }
  }
});
test('rejects whitespace, options, command syntax and non-string targets', () => {
  for (const input of [undefined, null, 22, {}, [], '', ' ', ' server', 'server ', 'alice @server', 'alice@ server',
    'server\n', 'server\r', 'server\t', 'server\u00a0', '-oProxyCommand=bad', '--', 'server -p 22', 'alice@-oProxyCommand=bad',
    'server;cmd', 'server&&cmd', 'server|cmd', '$(cmd)', '`cmd`', 'server/dir', 'alice%40server', 'alice@server@other']) {
    assert.throws(() => parseTarget(input), undefined, String(input));
  }
});
test('decodes Remote-SSH JSON authority preserving user, host case and SSH port', () => {
  assert.deepEqual(authorityTarget(encoded({ hostName: '192.0.2.103', user: 'remote-user' })), { host: 'remote-user@192.0.2.103' });
  assert.deepEqual(authorityTarget(encoded({ hostName: 'My-Server', user: 'alice', port: 2222 })), { host: 'alice@My-Server', sshPort: 2222 });
  assert.deepEqual(authorityTarget(encoded({ hostName: '2001:db8::1', user: 'alice', port: 22 })), { host: 'alice@2001:db8::1', sshPort: 22 });
  assert.deepEqual(authorityTarget(encoded({ hostName: 'My-Server' })), { host: 'My-Server' });
  assert.deepEqual(authorityTarget(encoded({ hostName: '[::1]', port: 2222 })), { host: '::1', sshPort: 2222 });
  assert.deepEqual(authorityTarget(encoded({ hostName: '[2001:db8::1]', user: 'alice', port: 22 })), { host: 'alice@2001:db8::1', sshPort: 22 });
});
test('preserves plain aliases, literal user@host and percent-encoded user separator', () => {
  for (const host of ['my-server', 'alice@my-server', 'deadbeef']) {
    assert.deepEqual(authorityTarget(`ssh-remote+${host}`), { host });
  }
  assert.deepEqual(authorityTarget('ssh-remote+alice%40my-server'), { host: 'alice@my-server' });
});
test('normalizes plain Remote-SSH IPv6 and explicit port syntax', () => {
  assert.deepEqual(authorityTarget('ssh-remote+alice@[2001:db8::1]'), { host: 'alice@2001:db8::1' });
  assert.deepEqual(authorityTarget('ssh-remote+alice%40%5B%3A%3A1%5D%3A2222'), { host: 'alice@::1', sshPort: 2222 });
  assert.deepEqual(authorityTarget('ssh-remote+::1'), { host: '::1' });
  assert.deepEqual(authorityTarget('ssh-remote+my-server:2222'), { host: 'my-server', sshPort: 2222 });
});
test('rejects malformed encoded targets and unsafe SSH values instead of using hex as DNS name', () => {
  for (const data of [{}, { hostName: '-oProxyCommand=bad' }, { hostName: 'server;cmd' },
    { hostName: 'server', user: '-root' }, { hostName: 'server', user: 'a@b' },
    { hostName: 'alice@server', user: 'bob' }, { hostName: 'server', user: {} },
    { hostName: '[not-ipv6]' }, { hostName: 'server:0' }, { hostName: 'server', user: '' },
    ...[0, -1, 65536, 22.5, '2222'].map(port => ({ hostName: 'server', port }))]) {
    assert.throws(() => authorityTarget(encoded(data)));
  }
  for (const authority of ['ssh-remote+7b', 'ssh-remote+7b0', 'ssh-remote+%', 'ssh-remote+', 'file+server']) {
    assert.throws(() => authorityTarget(authority));
  }
});
test('repairs exact legacy encoded mappings and preserves intentional host overrides', () => {
  const id = encoded({ hostName: '192.0.2.103', user: 'remote-user', port: 2222 });
  const raw = id.slice('ssh-remote+'.length);
  assert.deepEqual(savedTarget(raw, id), { host: 'remote-user@192.0.2.103', sshPort: 2222 });
  assert.deepEqual(savedTarget('my-alias', id), { host: 'my-alias' });
  assert.deepEqual(savedTarget({ host: 'my-alias', sshPort: 2200 }, id), { host: 'my-alias', sshPort: 2200 });
  assert.deepEqual(savedTarget('deadbeef', id), { host: 'deadbeef' });
  assert.deepEqual(savedTarget({ host: raw, sshPort: 2200 }, id), { host: 'remote-user@192.0.2.103', sshPort: 2200 });
  assert.throws(() => savedTarget({ host: 'server', sshPort: '2222' }, id));
});
test('normalizes saved destinations and preserves an explicit mapped SSH port', () => {
  const id = encoded({ hostName: 'other-server', port: 22 });
  for (const [saved, target] of [
    ['alice@My-Server:2222', { host: 'alice@My-Server', sshPort: 2222 }],
    ['alice@[2001:db8::1]:2222', { host: 'alice@2001:db8::1', sshPort: 2222 }],
    [{ host: '[::1]' }, { host: '::1' }],
    [{ host: '[::1]', sshPort: 2200 }, { host: '::1', sshPort: 2200 }],
    [{ host: 'alice@[2001:db8::1]:2222', sshPort: 2200 }, { host: 'alice@2001:db8::1', sshPort: 2200 }],
    [{ host: 'My-Alias', sshPort: 65535 }, { host: 'My-Alias', sshPort: 65535 }]
  ]) {
    assert.deepEqual(savedTarget(saved, id), target);
  }
});
test('does not decode intentional encoded-looking aliases or non-SSH authorities', () => {
  const alias = Buffer.from(JSON.stringify({ hostName: 'server' })).toString('hex');
  assert.deepEqual(savedTarget(alias, 'ssh-remote+other-server'), { host: alias });
  assert.deepEqual(savedTarget(alias, `file+${alias}`), { host: alias });
  assert.deepEqual(savedTarget('My-Alias'), { host: 'My-Alias' });
  assert.deepEqual(savedTarget('alice%40server', 'ssh-remote+alice%40server'), { host: 'alice@server' });
});
test('rejects invalid saved hosts, explicit ports and malformed legacy mappings', () => {
  for (const saved of [undefined, null, 22, [], {}, { host: '' }, { host: '[server]' }, { host: 'server -p 22' },
    { host: 'server:0' }, ...[0, -1, 65536, 22.5, '22', null].map(sshPort => ({ host: 'server', sshPort }))]) {
    assert.throws(() => savedTarget(saved, 'ssh-remote+server'));
  }
  assert.throws(() => savedTarget('7b', 'ssh-remote+7b'));
  assert.throws(() => savedTarget('7b0', 'ssh-remote+7b0'));
});
