'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');
const fs = require('node:fs/promises');
const { startAuth } = require('../src/auth');
const exec = promisify(execFile);

test('askpass helper returns a UI response only over authenticated private IPC; no password file', async t => {
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
test('cancelling the password input fails authentication without returning a secret', async t => {
  const auth = await startAuth(async () => undefined); t.after(() => auth.close());
  await assert.rejects(exec(auth.env.SSH_ASKPASS, ['Password:'], { env: auth.env }), e => e.code === 1 && e.stdout === '');
});
