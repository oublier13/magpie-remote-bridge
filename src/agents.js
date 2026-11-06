'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const MODEL_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
/** Import only model identifiers, and only from settings using this local gateway. */
async function localClaudeModels(gatewayPort, { readFile = fs.readFile } = {}) {
  try {
    const json = JSON.parse(await readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
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
// Limit remote inspection to known CLI names; no user input becomes shell code.
function remoteCliScript(agent, marker) {
  if (!['codex', 'claude'].includes(agent) || !/^[A-Z0-9_]+$/.test(marker)) throw new Error('Invalid CLI check');
  const probe = `p=$(command -v ${agent} 2>/dev/null)
case "$p" in /*) if [ -f "$p" ] && [ -x "$p" ]; then printf '\n%s\\t%s\\n' '${marker}' "$p"; exit 0; fi;; esac
for p in "$HOME/.local/bin/${agent}" "$HOME/bin/${agent}" "$HOME/.npm-global/bin/${agent}"; do
  if [ -f "$p" ] && [ -x "$p" ]; then printf '\n%s\\t%s\\n' '${marker}' "$p"; exit 0; fi
done
exit 3`;
  return `sh -c ${shellQuote(probe)} && exit 0
failed=0
case "\${SHELL##*/}" in
  bash|zsh|ksh|sh|dash)
    "$SHELL" -ilc ${shellQuote(probe)} && exit 0
    [ "$?" -eq 3 ] || failed=1
    "$SHELL" -ic ${shellQuote(probe)} && exit 0
    [ "$?" -eq 3 ] || failed=1
    ;;
esac
if command -v bash >/dev/null 2>&1; then
  bash -ic ${shellQuote(probe)} && exit 0
  [ "$?" -eq 3 ] || failed=1
fi
[ "$failed" -eq 0 ] || exit 2
printf '\n%s\\tMISSING\\n' '${marker}'
`;
}

function cliCommand(executable) {
  if (typeof executable !== 'string' || !executable.startsWith('/') || /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error('Invalid remote CLI path');
  }
  // Also support npm/nvm shebangs that find node alongside the resolved CLI.
  return `PATH=${shellQuote(path.posix.dirname(executable))}:"$PATH" ${shellQuote(executable)}`;
}
function codexCommand({ remotePort, model }, executable) {
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
  return (executable ? cliCommand(executable) : 'codex') + ' ' + Object.entries(config).map(([k, v]) => '-c ' + shellQuote(`${k}=${JSON.stringify(v)}`)).join(' ');
}
module.exports = { localClaudeModels, terminalEnv, codexCommand, shellQuote, cliCommand, remoteCliScript };
