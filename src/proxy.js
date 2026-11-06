'use strict';
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

// Deliberately exclude Magpie UI, administration, login and MCP callback routes.
function allowed(method, path) {
  if (method === 'GET') return ['/v1/models', '/v1/codex/models'].includes(path);
  if (method !== 'POST') return false;
  return ['/v1/chat/completions', '/v1/responses', '/v1/responses/compact',
    '/v1/messages', '/v1/messages/count_tokens', '/v1/embeddings'].includes(path);
}
function equal(a, b) {
  const aa = Buffer.from(typeof a === 'string' ? a : ''); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cleanHeaders(headers) {
  const out = { ...headers };
  const extra = String(headers.connection || '').split(',').map(s => s.trim().toLowerCase());
  for (const name of [...extra, 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete out[name];
  return out;
}
async function startProxy({ gatewayPort, upstreamKey = 'magpie' }) {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('Invalid gateway port');
  if (typeof upstreamKey !== 'string') throw new Error('Invalid gateway key');
  http.validateHeaderValue('authorization', `Bearer ${upstreamKey}`);
  http.validateHeaderValue('x-api-key', upstreamKey);
  const token = randomBytes(32).toString('hex');
  const sockets = new Set(); const requests = new Set(); let closing;
  const server = http.createServer((req, res) => {
    const fail = (code, message) => {
      if (upstream) req.unpipe(upstream);
      req.resume();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message, type: 'bridge_error' } }));
    };
    let upstream;
    const disconnect = () => upstream?.destroy();
    req.on('error', disconnect); req.on('aborted', disconnect);
    req.once('close', () => { req.removeListener('error', disconnect); req.removeListener('aborted', disconnect); });
    res.on('error', disconnect);
    res.once('close', () => { disconnect(); res.removeListener('error', disconnect); });
    if (!equal(req.headers.authorization?.replace(/^Bearer /i, ''), token) &&
        !equal(req.headers['x-api-key'], token)) return fail(401, 'Invalid bridge session token');
    // Accept only origin-form targets, without normalizing encoded routes or traversal.
    const raw = req.url || ''; const path = raw.split('?')[0];
    if (!raw.startsWith('/') || /[\\#\s]/.test(raw) || !allowed(req.method, path)) return fail(403, 'Route is not exposed by Magpie Remote Bridge');
    let target;
    try { target = new URL(raw, 'http://127.0.0.1'); }
    catch { return fail(400, 'Invalid request target'); }
    if (target.origin !== 'http://127.0.0.1') return fail(403, 'Invalid request target');
    if (target.searchParams.has('key')) return fail(400, 'Use an authentication header instead of a query key');
    const headers = cleanHeaders(req.headers);
    for (const name of ['host', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'origin', 'referer',
      'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete headers[name];
    headers.authorization = `Bearer ${upstreamKey}`;
    if (path.startsWith('/v1/messages')) headers['x-api-key'] = upstreamKey;
    // Reframe the decoded body when its original framing header was hop-by-hop.
    if (headers['content-length'] === undefined && (req.headers['transfer-encoding'] || req.headers['content-length'])) {
      headers['transfer-encoding'] = 'chunked';
    }
    try {
      upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort,
        path: raw, method: req.method, headers, agent: false }, response => {
        const disconnectResponse = () => res.destroy();
        response.on('error', disconnectResponse); response.on('aborted', disconnectResponse);
        response.once('close', () => {
          if (!response.complete) disconnectResponse();
          response.removeListener('error', disconnectResponse); response.removeListener('aborted', disconnectResponse);
        });
        if (res.destroyed) { response.destroy(); return; }
        const replyHeaders = cleanHeaders(response.headers); delete replyHeaders['set-cookie'];
        try { res.writeHead(response.statusCode, replyHeaders); }
        catch { response.destroy(); fail(502, 'Invalid local Magpie gateway response'); return; }
        response.pipe(res); // Preserve SSE streaming and backpressure.
      });
      requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
      upstream.once('upgrade', (_response, socket) => { socket.destroy(); fail(502, 'Invalid local Magpie gateway response'); });
      upstream.setTimeout(300000, () => upstream.destroy(new Error('Gateway idle timeout')));
      upstream.on('error', () => fail(502, 'Local Magpie gateway unavailable'));
      req.pipe(upstream);
    } catch { fail(502, 'Local Magpie gateway unavailable'); }
  });
  server.requestTimeout = 0;
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  const close = () => {
    if (closing) return closing;
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    closing = new Promise(resolve => server.close(() => resolve()));
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.removeListener('error', onError); server.removeListener('listening', onListening); };
      const onError = error => { cleanup(); reject(error); };
      const onListening = () => { cleanup(); resolve(); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  } catch (error) { await close(); throw error; }
  server.on('error', close);
  return { port: server.address().port, token, close };
}
function abortError() {
  const error = new Error('Operation cancelled'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error;
}
function getModels(port, key = 'magpie', pathOrOptions = '/v1/models', extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const options = typeof pathOrOptions === 'string' ? extraOptions : pathOrOptions;
    const path = typeof pathOrOptions === 'string' ? pathOrOptions : options?.path || '/v1/models';
    const { signal, timeoutMs = 8000 } = options || {};
    if (signal?.aborted) { reject(abortError()); return; }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) { reject(new Error('Invalid gateway check timeout')); return; }
    let req; let response; let timer; let settled = false; let size = 0; let chunks = [];
    const cancel = () => finish(abortError());
    const finish = (error, models) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); chunks = [];
      response?.removeListener('data', onData); response?.removeListener('end', onEnd);
      if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolve(models);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) finish(new Error('Model catalog exceeds 8 MiB'));
      else chunks.push(chunk);
    };
    const onError = error => finish(error);
    const onAborted = () => finish(new Error('Magpie gateway disconnected during the model check'));
    const onEnd = () => {
      try {
        if (response.statusCode !== 200) throw new Error(`Magpie returned HTTP ${response.statusCode}; check gateway authentication`);
        const json = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        if (!json || !Array.isArray(json.data)) throw new Error('Expected an OpenAI-compatible model catalog');
        const models = json.data.filter(model => model && typeof model === 'object' && !Array.isArray(model) &&
          typeof model.id === 'string' && model.id.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(model.id)).map(model => model.id);
        finish(undefined, models);
      } catch (error) { finish(error); }
    };
    try {
      req = http.request({ hostname: '127.0.0.1', port, path, agent: false,
        headers: { authorization: `Bearer ${key}` } }, res => {
        response = res;
        res.on('data', onData); res.once('end', onEnd); res.on('error', onError); res.once('aborted', onAborted);
        res.once('close', () => {
          if (!res.complete) onAborted();
          res.removeListener('data', onData); res.removeListener('end', onEnd);
          res.removeListener('error', onError); res.removeListener('aborted', onAborted);
        });
        if (settled) res.destroy();
        else if (res.statusCode !== 200) finish(new Error(`Magpie returned HTTP ${res.statusCode}; check gateway authentication`));
      });
      req.on('error', onError); req.once('close', () => req.removeListener('error', onError));
      timer = setTimeout(() => finish(new Error('Magpie gateway check timed out')), timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else req.end();
    } catch (error) { finish(error); }
  });
}
module.exports = { allowed, startProxy, getModels };
