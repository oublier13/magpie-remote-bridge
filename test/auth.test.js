'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');
const fs = require('node:fs/promises');
const { startAuth } = require('../src/auth');
const exec = promisify(execFile);

test('askpass helper returns a UI response only over authenticated private IPC; no password file', { skip: process.platform === 'win32' }, async t => {
  const challenges = [];
  const auth = await startAuth(async text => { challenges.push(text); return 'test-only-password'; });
  t.after(() => auth.close());
  const result = await exec(auth.env.SSH_ASKPASS, ["test-user@example-host's password: "], { env: auth.env });
  assert.equal(result.stdout, 'test-only-password\n');
  assert.equal(result.stderr, ''); assert.deepEqual(challenges, ["test-user@example-host's password: "]);
  const helper = await fs.readFile(auth.env.SSH_ASKPASS, 'utf8');
  assert.ok(!helper.includes('test-only-password')); assert.ok(!helper.includes(auth.env.MAGPIE_ASKPASS_TOKEN));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: Number(auth.env.MAGPIE_ASKPASS_PORT),
      path: '/askpass', method: 'POST', headers: { authorization: 'Bearer wrong' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end('{"challenge":"malicious"}');
  });
  assert.equal(status, 403); assert.equal(challenges.length, 1);
});
test('cancelling the password input fails authentication without returning a secret', { skip: process.platform === 'win32' }, async t => {
  const auth = await startAuth(async () => undefined); t.after(() => auth.close());
  await assert.rejects(exec(auth.env.SSH_ASKPASS, ['Password:'], { env: auth.env }), e => e.code === 1 && e.stdout === '');
});

function openAuth(auth, options = {}) {
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request({ hostname: '127.0.0.1', port: Number(auth.env.MAGPIE_ASKPASS_PORT),
      path: '/askpass', method: 'POST', agent: false, ...options,
      headers: { authorization: `Bearer ${auth.env.MAGPIE_ASKPASS_TOKEN}`, ...options.headers } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; }); res.on('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
  return { req, result };
}
function authRequest(auth, body = '{"challenge":"Password:"}', options) {
  const { req, result } = openAuth(auth, options); req.end(body); return result;
}
test('Windows authentication mode does not create askpass files or open a prompt', async t => {
  t.mock.method(fs, 'mkdtemp', () => { throw new Error('No temporary directory should be created'); });
  const auth = await startAuth(() => { throw new Error('No prompt should be shown'); }, { platform: 'win32' });
  assert.equal(auth.env, undefined); assert.equal(auth.controlPath, undefined);
  await auth.close(); await auth.close();
});
test('only one prompt may be active, including when other requests are rejected', async t => {
  let entered; const prompting = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const auth = await startAuth(async () => { calls++; entered(); await gate; return 'answer'; }, { platform: 'linux' });
  t.after(() => { release(); return auth.close(); });
  const first = authRequest(auth); await prompting;
  assert.equal((await authRequest(auth)).status, 409);
  assert.equal((await authRequest(auth)).status, 409);
  assert.equal(calls, 1); release();
  assert.equal((await first).body, 'answer');
  assert.equal((await authRequest(auth)).status, 200); assert.equal(calls, 2);
});
test('a partially uploaded challenge reserves the prompt before its body is complete', async t => {
  const challenges = [];
  const auth = await startAuth(async text => { challenges.push(text); return 'answer'; }, { platform: 'linux' });
  t.after(() => auth.close());
  const first = openAuth(auth); first.req.write('{"challenge":');
  // A completed round trip ensures the first upload has reached the server.
  assert.equal((await authRequest(auth, '{}', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await authRequest(auth)).status, 409); assert.equal(challenges.length, 0);
  first.req.end('"First password:"}');
  assert.equal((await first.result).status, 200);
  assert.deepEqual(challenges, ['First password:']);
});
test('challenge limit counts UTF-8 bytes and invalid bodies never show a prompt', async t => {
  let calls = 0;
  const auth = await startAuth(async () => { calls++; return 'answer'; }, { platform: 'linux' });
  t.after(() => auth.close());
  for (const body of ['null', '[]', '{', '{"challenge":1}', JSON.stringify({ challenge: '界'.repeat(2000) })]) {
    assert.equal((await authRequest(auth, body)).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await authRequest(auth)).status, 200); assert.equal(calls, 1);
});
test('prompt text is sanitized and successful secret replies are not cacheable', async t => {
  const challenges = [];
  const auth = await startAuth(async text => { challenges.push(text); return 'answer'; }, { platform: 'linux' });
  t.after(() => auth.close());
  const reply = await authRequest(auth, JSON.stringify({ challenge: 'Pass\0word\n' + 'x'.repeat(600) }));
  assert.equal(reply.status, 200); assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(challenges[0].length, 512); assert.ok(!/[\x00-\x1f\x7f]/.test(challenges[0]));
});
test('closing during a prompt revokes sockets, removes files and tolerates a late answer', async t => {
  const path = require('node:path');
  let entered; const prompting = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const auth = await startAuth(async () => { entered(); await gate; return 'late-secret'; }, { platform: 'linux' });
  t.after(() => { release(); return auth.close(); });
  const pending = authRequest(auth); const rejected = assert.rejects(pending);
  await prompting;
  const first = auth.close(); const second = auth.close(); assert.equal(first, second);
  await first; await rejected; release();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fs.stat(path.dirname(auth.controlPath)), { code: 'ENOENT' });
});
test('permission setup failure removes the newly created private directory', async t => {
  let directory;
  t.mock.method(fs, 'chmod', async target => { directory = target; throw new Error('chmod failed'); });
  await assert.rejects(startAuth(async () => '', { platform: 'linux' }), /chmod failed/);
  assert.ok(directory); await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
test('helper creation failure closes its listener and removes its directory', async t => {
  const path = require('node:path'); let helper;
  t.mock.method(fs, 'writeFile', async target => { helper = target; throw new Error('write failed'); });
  await assert.rejects(startAuth(async () => '', { platform: 'linux' }), /write failed/);
  assert.ok(helper); await assert.rejects(fs.stat(path.dirname(helper)), { code: 'ENOENT' });
});
test('askpass client rejects invalid environment without printing secrets or stack traces', async () => {
  const path = require('node:path');
  const client = path.join(__dirname, '../src/askpass-client.js');
  for (const port of ['0', '65536', 'invalid']) {
    await assert.rejects(exec(process.execPath, [client, 'Password:'], {
      env: { ...process.env, MAGPIE_ASKPASS_PORT: port, MAGPIE_ASKPASS_TOKEN: 'private-value' }
    }), error => error.code === 1 && error.stdout === '' && error.stderr === '');
  }
});
test('askpass client fails on an oversized response or upstream disconnect without printing partial secrets', async t => {
  const path = require('node:path'); const { once } = require('node:events');
  let partial = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (!partial) { res.end('界'.repeat(6000)); return; }
    res.write('partial-secret'); setImmediate(() => res.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, MAGPIE_ASKPASS_PORT: String(server.address().port), MAGPIE_ASKPASS_TOKEN: 'private-value' };
  for (partial of [false, true]) {
    await assert.rejects(exec(process.execPath, [path.join(__dirname, '../src/askpass-client.js'), 'Password:'], { env }),
      error => error.code === 1 && error.stdout === '' && error.stderr === '');
  }
});

test('a disconnected partial challenge releases its reservation without opening a prompt', async t => {
  let calls = 0;
  const auth = await startAuth(async () => { calls++; return 'answer'; }, { platform: 'linux' });
  t.after(() => auth.close());
  const first = openAuth(auth); const rejected = assert.rejects(first.result);
  first.req.write('{"challenge":');
  assert.equal((await authRequest(auth, '{}', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  first.req.destroy(new Error('cancel upload')); await rejected;
  assert.equal((await authRequest(auth, '{}', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal(calls, 0); assert.equal((await authRequest(auth)).status, 200); assert.equal(calls, 1);
});
