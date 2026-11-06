'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, getEventListeners } = require('node:events');
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
      res.on('error', reject); res.on('aborted', () => reject(new Error('Response aborted')));
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

test('catalog ignores null and malformed entries, preserves both path and options APIs', async t => {
  const paths = [];
  const controller = new AbortController();
  const bridge = await fixture(t, (req, res) => {
    paths.push(req.url);
    res.end(JSON.stringify({ data: [null, false, 3, 'model', {}, [], { id: 1 }, { id: '' },
      { id: '   ' }, { id: 'bad\nmodel' }, { id: 'vendor/model' }, { id: 'next' }] }));
  });
  assert.deepEqual(await getModels(bridge.port, bridge.token, '/v1/codex/models'), ['vendor/model', 'next']);
  assert.deepEqual(await getModels(bridge.port, bridge.token, { timeoutMs: 1000 }), ['vendor/model', 'next']);
  assert.deepEqual(await getModels(bridge.port, bridge.token, '/v1/codex/models', { timeoutMs: 1000 }), ['vendor/model', 'next']);
  assert.deepEqual(await getModels(bridge.port, bridge.token, { path: '/v1/codex/models', signal: controller.signal }), ['vendor/model', 'next']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(paths, ['/v1/codex/models', '/v1/models', '/v1/codex/models', '/v1/codex/models']);
});
test('catalog rejects invalid document shapes and invalid JSON', async t => {
  let body = 'null';
  const bridge = await fixture(t, (_, res) => res.end(body));
  for (body of ['null', '{}', '{"data":null}', '{"data":{}}', '[1]', '{']) {
    await assert.rejects(getModels(bridge.port, bridge.token));
  }
});
test('catalog limit counts UTF-8 bytes instead of characters', async t => {
  // This is below 8 MiB as a JS string but above 8 MiB on the wire.
  const body = JSON.stringify({ data: [], padding: '界'.repeat(3 * 1024 * 1024) });
  const bridge = await fixture(t, (_, res) => res.end(body));
  await assert.rejects(getModels(bridge.port, bridge.token), /exceeds 8 MiB/);
});
test('catalog check can be cancelled before sending or while awaiting a response', async t => {
  const { getEventListeners } = require('node:events');
  let seen; const received = new Promise(resolve => { seen = resolve; });
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  let count = 0;
  const bridge = await fixture(t, (_, res) => {
    count++; res.once('close', disconnected); seen();
  });
  const before = new AbortController(); before.abort();
  await assert.rejects(getModels(bridge.port, bridge.token, { signal: before.signal }), { name: 'AbortError' });
  assert.equal(count, 0);
  const active = new AbortController();
  const pending = getModels(bridge.port, bridge.token, { signal: active.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await received; active.abort(); await rejected; await closed;
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
});
test('catalog detaches abort listener after success and parsing failure', async t => {
  const { getEventListeners } = require('node:events');
  let valid = true;
  const bridge = await fixture(t, (_, res) => res.end(valid ? '{"data":[]}' : '{'));
  const controller = new AbortController();
  assert.deepEqual(await getModels(bridge.port, bridge.token, { signal: controller.signal }), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  valid = false;
  await assert.rejects(getModels(bridge.port, bridge.token, { signal: controller.signal }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('upstream disconnect before headers gives 502 and mid-catalog disconnect rejects promptly', async t => {
  let partial = false;
  const bridge = await fixture(t, (req, res) => {
    if (!partial) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":[');
    setImmediate(() => res.destroy());
  });
  assert.equal((await request(bridge)).status, 502);
  partial = true;
  await assert.rejects(getModels(bridge.port, bridge.token, { timeoutMs: 1000 }), error => !/timed out/.test(error.message));
});
test('strips hop-by-hop headers in both directions and regenerates framing', async t => {
  let received; let receivedBody = '';
  const bridge = await fixture(t, async (req, res) => {
    received = req.headers;
    for await (const chunk of req) receivedBody += chunk;
    res.writeHead(200, { connection: 'x-upstream-hop, content-length', 'x-upstream-hop': 'remove',
      'content-length': 5, 'keep-alive': 'timeout=1', 'proxy-connection': 'keep-alive',
      'proxy-authenticate': 'Basic', 'proxy-authorization': 'hidden', te: 'trailers', upgrade: 'example' });
    res.end('reply');
  });
  const response = await request(bridge, { method: 'POST', path: '/v1/messages', body: 'payload', headers: {
    connection: 'x-client-hop, content-length', 'x-client-hop': 'remove', 'content-length': 7,
    'proxy-connection': 'keep-alive', 'keep-alive': 'timeout=1', te: 'trailers',
    'proxy-authorization': 'hidden', 'x-goog-api-key': 'client-key'
  } });
  assert.equal(receivedBody, 'payload'); assert.equal(response.text, 'reply');
  for (const name of ['x-client-hop', 'content-length', 'proxy-connection', 'keep-alive', 'te', 'proxy-authorization', 'x-goog-api-key']) {
    assert.equal(received[name], undefined, name);
  }
  for (const name of ['x-upstream-hop', 'content-length', 'proxy-connection', 'te', 'proxy-authorization', 'proxy-authenticate', 'upgrade']) {
    assert.equal(response.headers[name], undefined, name);
  }
  assert.notEqual(response.headers['keep-alive'], 'timeout=1');
  assert.equal(received['transfer-encoding'], 'chunked');
  assert.equal(response.headers['transfer-encoding'], 'chunked');
});
test('closing twice cancels active upstream streams and revokes the listener', async t => {
  let arrived; const received = new Promise(resolve => { arrived = resolve; });
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  const bridge = await fixture(t, (_, res) => { res.once('close', disconnected); arrived(); });
  const pending = getModels(bridge.port, bridge.token, { timeoutMs: 1000 });
  const rejected = assert.rejects(pending);
  await received;
  const first = bridge.close(); const second = bridge.close();
  assert.equal(first, second);
  await first; await rejected; await closed;
  await assert.rejects(getModels(bridge.port, bridge.token));
});

async function catalogServer(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
test('aborting a streaming model check disconnects the request and releases its signal listener', async t => {
  let began; let disconnected;
  const started = new Promise(resolve => { began = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const port = await catalogServer(t, (_, res) => {
    res.on('close', disconnected); res.write('{"data":['); began();
  });
  const controller = new AbortController();
  const pending = getModels(port, 'magpie', { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); await closed;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('model check deadline is bounded even when the gateway keeps sending data', { timeout: 2000 }, async t => {
  const port = await catalogServer(t, (_, res) => {
    res.write('{"data":[');
    const interval = setInterval(() => res.write(' '), 5); res.once('close', () => clearInterval(interval));
  });
  const controller = new AbortController();
  await assert.rejects(getModels(port, 'magpie', { signal: controller.signal, timeoutMs: 30 }), /timed out/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('model checks reject an upstream disconnect instead of waiting for the default timeout', { timeout: 2000 }, async t => {
  const port = await catalogServer(t, (_, res) => {
    res.write('{"data":['); setImmediate(() => res.destroy());
  });
  await assert.rejects(getModels(port), /disconnected|aborted|socket hang up/i);
});
test('chunked upstream trailers are removed without interrupting streaming', async t => {
  const bridge = await fixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-private' });
    res.write('data: first\n\n'); res.addTrailers({ 'x-private': 'secret' }); res.end('data: last\n\n');
  });
  const result = await request(bridge);
  assert.equal(result.text, 'data: first\n\ndata: last\n\n'); assert.equal(result.headers.trailer, undefined);
});
test('an upstream stream disconnect aborts the downstream response', { timeout: 2000 }, async t => {
  let disconnect;
  const bridge = await fixture(t, (_, res) => { res.write('partial'); disconnect = () => res.destroy(); });
  await assert.rejects(new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: bridge.port, path: '/v1/models',
      headers: { authorization: `Bearer ${bridge.token}` } }, res => {
      res.once('data', () => disconnect()); res.on('error', reject); res.once('end', resolve);
    });
    req.on('error', reject);
  }), /aborted|socket hang up/i);
});
test('malformed targets are rejected and cannot terminate the request handler', async t => {
  let count = 0;
  const bridge = await fixture(t, (_, res) => { count++; res.end('{"data":[]}'); });
  for (const path of ['//[invalid/v1/models', '/\\[invalid/v1/models', '/v1/models?next=\\evil', '/v1/models#ignored', '/v1/models?x=#fragment']) {
    assert.equal((await request(bridge, { path })).status, 403);
  }
  assert.equal((await request(bridge, { path: '/v1/models?%6bey=secret' })).status, 400);
  assert.deepEqual(await getModels(bridge.port, bridge.token), []); assert.equal(count, 1);
});

test('model checks reject an HTTP authentication failure before waiting for its body', { timeout: 2000 }, async t => {
  const port = await catalogServer(t, (_, res) => { res.writeHead(401); res.flushHeaders(); });
  await assert.rejects(getModels(port, 'magpie', { timeoutMs: 1000 }), /HTTP 401/);
});
test('an unexpected gateway protocol upgrade returns a bounded 502', { timeout: 2000 }, async t => {
  const bridge = await fixture(t, (_, res) => {
    res.writeHead(101, { connection: 'Upgrade', upgrade: 'example' }); res.flushHeaders();
  });
  assert.equal((await request(bridge)).status, 502);
});

test('every published model route reaches the gateway and other methods stay blocked', async t => {
  const seen = [];
  const bridge = await fixture(t, (req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.end('{}'); });
  const routes = [
    ['GET', '/v1/models'], ['GET', '/v1/codex/models'], ['POST', '/v1/chat/completions'],
    ['POST', '/v1/responses'], ['POST', '/v1/responses/compact'], ['POST', '/v1/messages'],
    ['POST', '/v1/messages/count_tokens'], ['POST', '/v1/embeddings']
  ];
  for (const [method, path] of routes) assert.equal((await request(bridge, { method, path })).status, 200);
  assert.deepEqual(seen, routes.map(([method, path]) => `${method} ${path}`));
  assert.equal((await request(bridge, { method: 'PUT', path: '/v1/responses' })).status, 403);
  assert.equal(seen.length, routes.length);
});
