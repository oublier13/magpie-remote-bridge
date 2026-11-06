'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const MODEL_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
async function localClaudeModels(gatewayPort) {
  try {
    const json = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const env = json.env || {};
    const base = new URL(env.ANTHROPIC_BASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
        Number(base.port || 80) !== gatewayPort || base.protocol !== 'http:') return {};
    return Object.fromEntries(MODEL_KEYS.filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
  } catch { return {}; }
}
function terminalEnv({ remotePort, token, model }, localModels = {}) {
  const base = `http://127.0.0.1:${remotePort}`;
  const env = { ...localModels, MAGPIE_BRIDGE_URL: base, MAGPIE_BRIDGE_TOKEN: token,
    OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: token,
    ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: null, OPENAI_ORG_ID: null, OPENAI_ORGANIZATION: null };
  if (model) for (const key of MODEL_KEYS) env[key] = model;
  return env;
}
function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function codexCommand({ remotePort, model }) {
  const base = `http://127.0.0.1:${remotePort}/v1`;
  const config = {
    model_provider: 'magpie_bridge',
    'model_providers.magpie_bridge.name': 'Magpie Remote Bridge',
    'model_providers.magpie_bridge.base_url': base,
    'model_providers.magpie_bridge.model_catalog_url': `${base}/codex/models`,
    'model_providers.magpie_bridge.env_key': 'MAGPIE_BRIDGE_TOKEN',
    'model_providers.magpie_bridge.wire_api': 'responses',
    'model_providers.magpie_bridge.requires_openai_auth': false,
    'model_providers.magpie_bridge.supports_websockets': false
  };
  if (model) config.model = model;
  return 'codex ' + Object.entries(config).map(([k, v]) => '-c ' + shellQuote(`${k}=${JSON.stringify(v)}`)).join(' ');
}
module.exports = { localClaudeModels, terminalEnv, codexCommand, shellQuote };
