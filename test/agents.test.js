'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { terminalEnv, codexCommand, shellQuote } = require('../src/agents');
test('terminal environment routes both API protocols and explicitly clears conflicting auth', () => {
  const env = terminalEnv({ remotePort: 13425, token: 'capability', model: 'vendor/model' });
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:13425/v1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:13425');
  assert.equal(env.ANTHROPIC_API_KEY, null);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'vendor/model');
  assert.equal(env.MAGPIE_BRIDGE_TOKEN, 'capability');
});
test('POSIX quoting preserves literal shell metacharacters', () => {
  const input = "foo'bar $(echo injected) `id`\nnext";
  assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' }), input);
});
test('Codex launch overrides provider temporarily and never places a token in command text', () => {
  const command = codexCommand({ remotePort: 13425, model: 'vendor/a' });
  assert.ok(command.includes('wire_api="responses"'));
  assert.ok(command.includes('env_key="MAGPIE_BRIDGE_TOKEN"'));
  assert.ok(command.includes('supports_websockets=false'));
  assert.ok(command.includes('/v1/codex/models'));
  assert.ok(!command.includes('config.toml'));
});
