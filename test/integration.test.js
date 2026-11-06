'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { BridgeSession } = require('../src/session');
const { startProxy, getModels } = require('../src/proxy');

test('session lifecycle owns a real loopback proxy and revokes its capability', async t => {
  const gateway = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-gateway-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'vendor/model' }] }));
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  class LoopbackProbe extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    async start() {}
    probe(token, options) { return getModels(this.options.localPort, token, options); }
    stop() {}
  }
  const bridge = new BridgeSession({
    readConfig: () => ({ gatewayPort: gateway.address().port, remotePort: 13425 }),
    resolveTarget: async () => ({ host: 'test-host' }), getGatewayKey: async () => 'local-gateway-key',
    getModels, startProxy, startAuth: async () => ({ close() {} }),
    createTunnel: options => new LoopbackProbe(options)
  });
  t.after(() => bridge.dispose());
  const session = await bridge.connect();
  assert.equal(session.ready, true);
  assert.deepEqual(await getModels(session.proxy.port, session.proxy.token), ['vendor/model']);
  await assert.rejects(getModels(session.proxy.port, 'wrong-token'), /401/);
  bridge.disconnect();
  await assert.rejects(getModels(session.proxy.port, session.proxy.token));
});
