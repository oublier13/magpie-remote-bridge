'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { localClaudeModels, terminalEnv, codexCommand, shellQuote } = require('../src/agents');
test('terminal environment routes both API protocols and explicitly clears conflicting auth', () => {
  const env = terminalEnv({ remotePort: 13425, token: 'capability', model: 'vendor/model' });
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:13425/v1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:13425');
  assert.equal(env.ANTHROPIC_API_KEY, null);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'vendor/model');
  assert.equal(env.MAGPIE_BRIDGE_TOKEN, 'capability');
});
test('POSIX quoting preserves literal shell metacharacters', { skip: process.platform === 'win32' }, () => {
  const input = "foo'bar $(echo injected) `id`\nnext";
  assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' }), input);
});
test('Codex launch overrides provider temporarily and never places a token in command text', () => {
  const command = codexCommand({ remotePort: 13425, model: 'vendor/a', token: 'secret-must-not-appear' });
  assert.ok(!command.includes('secret-must-not-appear'));
  assert.ok(command.includes('wire_api="responses"'));
  assert.ok(command.includes('env_key="MAGPIE_BRIDGE_TOKEN"'));
  assert.ok(command.includes('supports_websockets=false'));
  assert.ok(command.includes('/v1/codex/models'));
  assert.ok(!command.includes('config.toml'));
});


test('local model import allows only model fields from the matching gateway', async () => {
  const settings = { env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_MODEL: 'vendor/main',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/fast', ANTHROPIC_API_KEY: 'never-export',
    CLAUDE_CODE_SUBAGENT_MODEL: 42, OTHER_SECRET: 'never-export'
  } };
  const result = await localClaudeModels(3425, { readFile: async () => JSON.stringify(settings) });
  assert.deepEqual(result, { ANTHROPIC_MODEL: 'vendor/main', ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor/fast' });
});

test('model import rejects external, wrong-port and encrypted gateway settings', async () => {
  for (const url of ['http://example.com:3425', 'http://127.0.0.1:1234', 'https://localhost:3425']) {
    const readFile = async () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: 'vendor/private' } });
    assert.deepEqual(await localClaudeModels(3425, { readFile }), {});
  }
  assert.deepEqual(await localClaudeModels(3425, { readFile: async () => '{invalid' }), {});
  assert.deepEqual(await localClaudeModels(3425, { readFile: async () => { throw new Error('not found'); } }), {});
});

test('explicit model overrides imported defaults without forwarding other local credentials', () => {
  const env = terminalEnv({ remotePort: 13425, token: 'capability', model: 'vendor/selected' }, { ANTHROPIC_MODEL: 'vendor/imported' });
  assert.equal(env.ANTHROPIC_MODEL, 'vendor/selected');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'capability');
  assert.equal(env.ANTHROPIC_API_KEY, null);
});

test('resolved CLI commands quote paths and make a colocated node available without exposing tokens', () => {
  const { cliCommand } = require('../src/agents');
  const executable = "/home/alice's tools/.nvm/bin/codex";
  const command = codexCommand({ remotePort: 13425, token: 'hidden-token' }, executable);
  assert.ok(command.startsWith(cliCommand(executable) + ' -c '));
  assert.ok(command.includes(shellQuote("/home/alice's tools/.nvm/bin") + ':"$PATH"'));
  assert.ok(command.includes(shellQuote(executable)));
  assert.ok(!command.includes('hidden-token'));
  for (const invalid of ['codex', '/tmp/codex\nnext', '/tmp/cli\0']) assert.throws(() => cliCommand(invalid));
});

test('CLI inspection rejects unknown commands and unsafe protocol markers', () => {
  const { remoteCliScript } = require('../src/agents');
  assert.throws(() => remoteCliScript('codex; id', 'MARKER'));
  assert.throws(() => remoteCliScript('claude', "MARKER'; id"));
});

test('CLI inspection finds ordinary PATH and user bin executables using only local shells', { skip: process.platform === 'win32' }, t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { remoteCliScript } = require('../src/agents');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'ordinary'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, SHELL: '/bin/false', PATH: `${bin}:/usr/bin:/bin` };
  assert.equal(execFileSync('/bin/sh', ['-s'], { input: remoteCliScript('codex', 'MARKER'), env, encoding: 'utf8' }), `\nMARKER\t${bin}/codex\n`);
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.renameSync(path.join(bin, 'codex'), path.join(home, '.local/bin/codex'));
  assert.equal(execFileSync('/bin/sh', ['-s'], { input: remoteCliScript('codex', 'MARKER'), env, encoding: 'utf8' }), `\nMARKER\t${home}/.local/bin/codex\n`);
});

test('interactive Bash initialization resolves nvm-style CLI and colocated node outside ordinary PATH', { skip: process.platform === 'win32' }, t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { remoteCliScript, cliCommand } = require('../src/agents');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.nvm/versions/node/test/bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env node\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf runtime-found\n', { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.bashrc'), `case $- in *i*) ;; *) return;; esac\nexport PATH=${shellQuote(bin)}:"$PATH"\n`);
  // Use a non-login default shell so the fallback Bash reads the isolated .bashrc.
  const env = { ...process.env, HOME: home, SHELL: '/bin/false', PATH: '/usr/bin:/bin' };
  const output = execFileSync('/bin/sh', ['-s'], { input: remoteCliScript('claude', 'MARKER'), env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(output, `\nMARKER\t${bin}/claude\n`);
  assert.equal(execFileSync('/bin/sh', ['-c', cliCommand(path.join(bin, 'claude'))], { env, encoding: 'utf8' }), 'runtime-found');
});

test('CLI inspection reports missing only after interactive checks and reports shell errors separately', { skip: process.platform === 'win32' }, t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { remoteCliScript } = require('../src/agents');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  // An isolated PATH prevents installed developer CLIs from affecting this test.
  for (const program of ['sh', 'bash']) fs.symlinkSync(`/bin/${program}`, path.join(bin, program));
  const env = { ...process.env, HOME: home, SHELL: '/bin/false', PATH: bin };
  fs.writeFileSync(path.join(home, '.bashrc'), ':\n');
  assert.equal(execFileSync('/bin/sh', ['-s'], { input: remoteCliScript('codex', 'MARKER'), env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), '\nMARKER\tMISSING\n');
  for (const code of [1, 2]) {
    fs.writeFileSync(path.join(home, '.bashrc'), `exit ${code}\n`);
    assert.throws(() => execFileSync('/bin/sh', ['-s'], { input: remoteCliScript('codex', 'MARKER'), env, stdio: ['pipe', 'pipe', 'pipe'] }), error => error.status === 2);
  }
});
