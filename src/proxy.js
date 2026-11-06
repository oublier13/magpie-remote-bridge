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
  const aa = Buffer.from(a || ''); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cleanHeaders(headers) {
  const out = { ...headers };
  const extra = String(headers.connection || '').split(',').map(s => s.trim().toLowerCase());
  for (const name of [...extra, 'host', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'origin', 'referer',
    'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete out[name];
  return out;
}
async function startProxy({ gatewayPort, upstreamKey = 'magpie' }) {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const fail = (code, message) => {
      req.resume();
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'bridge_error' } }));
    };
    if (!equal(req.headers.authorization?.replace(/^Bearer /i, ''), token) &&
        !equal(req.headers['x-api-key'], token)) return fail(401, 'Invalid bridge session token');
    // Accept only origin-form targets, no normalization of traversal or encoded routes.
    const raw = req.url || '';
    const path = raw.split('?')[0];
    if (!raw.startsWith('/') || !allowed(req.method, path)) return fail(403, 'Route is not exposed by Magpie Remote Bridge');
    const target = new URL(raw, 'http://127.0.0.1');
    if (target.origin !== 'http://127.0.0.1') return fail(403, 'Invalid request target');
    if (target.searchParams.has('key')) return fail(400, 'Use an authentication header instead of a query key');
    const headers = cleanHeaders(req.headers);
    headers.authorization = `Bearer ${upstreamKey}`;
    if (path.startsWith('/v1/messages')) headers['x-api-key'] = upstreamKey;
    const upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort,
      path: raw, method: req.method, headers }, response => {
      const replyHeaders = { ...response.headers };
      delete replyHeaders['set-cookie'];
      delete replyHeaders.connection;
      res.writeHead(response.statusCode, replyHeaders);
      response.on('error', () => res.destroy());
      response.pipe(res); // Preserve SSE streaming and backpressure.
    });
    upstream.setTimeout(300000, () => upstream.destroy(new Error('Gateway idle timeout')));
    upstream.on('error', () => {
      if (!res.headersSent && !res.destroyed) fail(502, 'Local Magpie gateway unavailable');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 0;
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, token,
    close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}
function getModels(port, key = 'magpie', path = '/v1/models') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path,
      headers: { authorization: `Bearer ${key}` } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) req.destroy(new Error('Model catalog exceeds 8 MiB'));
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Magpie returned HTTP ${res.statusCode}; check gateway authentication`));
        try {
          const json = JSON.parse(body);
          if (!Array.isArray(json.data)) throw new Error('Expected an OpenAI-compatible model catalog');
          resolve(json.data.filter(m => typeof m.id === 'string').map(m => m.id));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('Magpie gateway check timed out')));
    req.on('error', reject);
  });
}
module.exports = { allowed, startProxy, getModels };
