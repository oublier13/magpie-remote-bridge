'use strict';

// Optional compatibility test against a real official Codex binary. All API
// requests use a local fixture, including its fixed SSE reply; no model is called.
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomBytes } = require('node:crypto');
const { startCredentialBroker } = require('../src/credential-broker');

async function verify(binary) {
  if (!binary || !path.isAbsolute(binary)) throw new Error('Usage: node scripts/verify-codex-sidebar.js /absolute/path/to/official/codex');
  const home = await fs.mkdtemp('/tmp/mpb-codex-compat-');
  let broker; let server; let child; let lines;
  const token = randomBytes(32).toString('hex');
  let authenticated = 0; let generation = 0;
  try {
    await fs.chmod(home, 0o700);
    broker = await startCredentialBroker(token);
    server = http.createServer((request, response) => {
      request.resume();
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
      authenticated++;
      if (request.method === 'POST' && request.url === '/v1/responses') {
        generation++;
        const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'BRIDGE_PROTOCOL_OK', annotations: [] }] };
        const result = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'gpt-5.4', output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'BRIDGE_PROTOCOL_OK' },
          { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'BRIDGE_PROTOCOL_OK' },
          { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: result }
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{
        slug: 'gpt-5.4', display_name: 'Local protocol fixture', description: 'Compatibility fixture',
        default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
        shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 0,
        base_instructions: 'Compatibility test.', supports_reasoning_summaries: true,
        supports_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform',
        web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: true, context_window: 32000, input_modalities: ['text']
      }] }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const provider = { name: 'Magpie compatibility fixture', base_url: base, model_catalog_url: `${base}/codex/models`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      auth: { command: '/usr/bin/curl', args: ['--disable', '--silent', '--show-error', '--fail', '--max-time', '3', '--noproxy', '*',
        '--unix-socket', broker.socketPath, 'http://localhost/token'], timeout_ms: 5000, refresh_interval_ms: 1000 }
    };
    // An existing app-server starts on 'before'; switching the config must affect
    // a newly created thread without reloading VS Code (which revokes the bridge).
    await fs.writeFile(path.join(home, 'config.toml'), `model_provider = "before"\nmodel = "gpt-5.4"\n[model_providers.before]\nname = "Before"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
    // A user curlrc must not redirect the capability into a file. --disable is
    // deliberately the provider command's first argument.
    await fs.writeFile(path.join(home, '.curlrc'), `output = ${JSON.stringify(path.join(home, 'unexpected-curl-output'))}\n`, { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home, CURL_HOME: home, XDG_CONFIG_HOME: home, RUST_LOG: 'off' };
    const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
    if (version.status !== 0) throw new Error('Official Codex binary did not start');
    child = spawn(binary, ['app-server', '--strict-config'], { env, cwd: home, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map(); let id = 0; let turnComplete; let reply = '';
    lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') reply += message.params.item.text;
      if (message.method === 'turn/completed') turnComplete?.(message.params.turn);
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Codex RPC rejected ${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
    const fail = () => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex app-server exited')); }
      pending.clear();
    };
    child.on('error', fail); child.once('close', fail); child.stdin.on('error', fail);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Codex RPC timed out: ${method}`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer, method }); send({ id: requestId, method, params });
    });
    await rpc('initialize', { clientInfo: { name: 'magpie_compatibility_test', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const config = await rpc('config/read', { includeLayers: true });
    const user = config.layers.find(layer => layer.name.type === 'user');
    if (!user) throw new Error('Codex did not expose its user config version');
    const edits = [
      { keyPath: 'model_providers.magpie_vscode_bridge', value: provider, mergeStrategy: 'replace' },
      { keyPath: 'model_provider', value: 'magpie_vscode_bridge', mergeStrategy: 'replace' }
    ];
    await rpc('config/batchWrite', { edits, filePath: user.name.file, expectedVersion: user.version, reloadUserConfig: false });
    const thread = await rpc('thread/start', { cwd: home, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
    if (thread.modelProvider !== 'magpie_vscode_bridge') throw new Error(`New thread retained old provider: ${thread.modelProvider}`);
    // Exercise the app-server's real thread/turn path against a fixed local SSE
    // response. model/list alone may use the bundled catalog and skip auth.
    let turnTimer;
    const completed = new Promise((resolve, reject) => {
      turnComplete = resolve;
      turnTimer = setTimeout(() => reject(new Error('Local fixture turn timed out')), 20000);
    });
    try {
      await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Reply BRIDGE_PROTOCOL_OK', text_elements: [] }] });
      const turn = await completed;
      if (turn.status !== 'completed') throw new Error(`Local fixture turn failed: ${turn.error?.message || turn.status}`);
    } finally { clearTimeout(turnTimer); }
    if (!authenticated || generation !== 1 || !reply.includes('BRIDGE_PROTOCOL_OK')) throw new Error('Official app-server did not complete the authenticated local fixture turn');
    await stop(child); child = undefined; lines.close();
    const containsToken = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (await containsToken(name)) return true; }
        else if (entry.isFile() && (await fs.readFile(name)).includes(Buffer.from(token))) return true;
      }
      return false;
    };
    const stored = await containsToken(home);
    if (stored) throw new Error('Capability found in isolated Codex files');
    return { ok: true, bundledVersion: version.stdout.trim(), newThreadProvider: thread.modelProvider,
      authenticatedFixtureRequests: authenticated, localFixtureResponses: generation, externalModelRequests: 0,
      response: reply, tokenStoredOnDisk: stored };
  } finally {
    if (child) await stop(child);
    lines?.close(); await broker?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(home, { recursive: true, force: true });
  }
}

function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
    child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}

if (require.main === module) verify(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
