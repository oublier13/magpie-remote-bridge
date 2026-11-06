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
