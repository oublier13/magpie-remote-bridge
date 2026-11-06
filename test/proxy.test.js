'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { startProxy, getModels } = require('../src/proxy');

async function fixture(t, handler, options = {}) {
  const gateway = http.createServer(handler);
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const bridge = await startProxy({ gatewayPort: gateway.address().port, ...options });
  t.after(() => { bridge.close(); gateway.closeAllConnections(); gateway.close(); });
  return bridge;
}
function request(bridge, { path = '/v1/models', method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: bridge.port, path, method,
      headers: { authorization: `Bearer ${bridge.token}`, ...headers } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
test('forwards catalog, replaces bridge capability, strips spoofed forwarding headers', async t => {
  let received;
  const bridge = await fixture(t, (req, res) => {
    received = req.headers;
    res.setHeader('set-cookie', 'secret=never-forward');
    res.end(JSON.stringify({ data: [{ id: 'vendor/model' }] }));
  }, { upstreamKey: 'local-only-secret' });
  assert.deepEqual(await getModels(bridge.port, bridge.token), ['vendor/model']);
  const result = await request(bridge, { headers: { 'x-forwarded-for': 'evil', cookie: 'secret', 'x-api-key': bridge.token } });
  assert.equal(received.authorization, 'Bearer local-only-secret');
  assert.equal(received['x-api-key'], undefined);
  assert.equal(received.cookie, undefined);
  assert.equal(received['x-forwarded-for'], undefined);
  assert.equal(result.headers['set-cookie'], undefined);
});
test('rejects unauthenticated, admin, encoded, traversal, absolute and query-key requests before reaching gateway', async t => {
  let count = 0;
  const bridge = await fixture(t, (_, res) => { count++; res.end('{}'); });
  assert.equal((await request(bridge, { headers: { authorization: 'Bearer invalid' } })).status, 401);
  for (const path of ['/api/config', '/v1/magpie/usage', '/v1/%6dodels', '/v1/models/../models',
    'http://example.com/v1/models', '//example.com/v1/models']) {
    assert.equal((await request(bridge, { path })).status, 403, path);
  }
  assert.equal((await request(bridge, { path: '/v1/models?key=secret' })).status, 400);
  assert.equal((await request(bridge, { method: 'DELETE' })).status, 403);
  assert.equal(count, 0);
});
test('passes Anthropic request body and streams SSE before upstream completes', async t => {
  let release; let upstreamBody = '';
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = await fixture(t, async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'magpie');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    for await (const chunk of req) upstreamBody += chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n'); await gate; res.end('data: last\n\n');
  });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': bridge.token, 'anthropic-version': '2023-06-01' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.includes('first')) release(); });
      res.on('end', () => { assert.equal(body, 'data: first\n\ndata: last\n\n'); resolve(); });
    });
    req.on('error', reject); req.end('{"stream":true}');
  });
  assert.equal(upstreamBody, '{"stream":true}');
});
test('unreachable local gateway returns a bounded 502 without credentials', async t => {
  const temp = http.createServer(); temp.listen(0, '127.0.0.1'); await once(temp, 'listening');
  const port = temp.address().port; await new Promise(r => temp.close(r));
  const bridge = await startProxy({ gatewayPort: port, upstreamKey: 'do-not-leak' });
  t.after(() => bridge.close());
  const result = await request(bridge);
  assert.equal(result.status, 502); assert.ok(!result.text.includes('do-not-leak'));
});
test('closing the bridge revokes the old capability', async t => {
  const bridge = await fixture(t, (_, res) => res.end('{"data":[]}'));
  bridge.close();
  await assert.rejects(getModels(bridge.port, bridge.token));
});
