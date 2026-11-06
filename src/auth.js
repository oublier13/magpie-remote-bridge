'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { shellQuote } = require('./agents');

function challengeBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const finish = (error, body) => {
      req.removeListener('data', onData); req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted); req.removeListener('error', onError);
      if (error) { req.resume(); reject(error); } else resolve(body);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > 4096) return finish(new Error('Oversized authentication challenge'));
      chunks.push(chunk);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, bytes).toString('utf8'));
    const onAborted = () => finish(new Error('Authentication request aborted'));
    const onError = error => finish(error);
    req.on('data', onData); req.once('end', onEnd);
    req.once('aborted', onAborted); req.once('error', onError);
  });
}

// A private askpass channel, not a password cache. Each SSH challenge is answered
// directly by a VS Code password input box; passwords are never written to disk.
async function startAuth(prompt, { platform = process.platform } = {}) {
  if (platform === 'win32') return { close() {} };
  if (typeof prompt !== 'function') throw new TypeError('An authentication prompt is required');
  let directory; let server; let closing; let closed = false; let prompting = false;
  const token = randomBytes(32).toString('hex'); const sockets = new Set();
  function close() {
    if (!closing) {
      closed = true;
      for (const socket of sockets) socket.destroy();
      closing = (async () => {
        if (server) await new Promise(resolve => server.close(() => resolve()));
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      })().catch(() => {});
    }
    return closing;
  }
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mpb-'));
    await fs.chmod(directory, 0o700);
    server = http.createServer(async (req, res) => {
      // Keep errors from a disconnected peer contained, including while draining.
      req.on('error', () => {}); res.on('error', () => {});
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== 'POST' || req.url !== '/askpass' || supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); req.resume(); return; }
      if (closed || prompting) { res.writeHead(409); res.end(); req.resume(); return; }
      // Reserve before reading the body, so overlapping uploads cannot open two dialogs.
      prompting = true;
      try {
        const body = JSON.parse(await challengeBody(req));
        if (!body || typeof body.challenge !== 'string') throw new Error('Invalid authentication challenge');
        if (closed || res.destroyed) return;
        const password = await prompt(body.challenge.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512));
        if (closed || res.destroyed) return;
        if (typeof password !== 'string' || Buffer.byteLength(password) > 16384) { res.writeHead(403); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(password); }
      } catch {
        if (!res.destroyed && !res.writableEnded) { res.writeHead(400); res.end(); }
      } finally { prompting = false; }
    });
    server.requestTimeout = 15000; server.headersTimeout = 15000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => {
      const onError = error => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    server.on('error', close);
    const helper = path.join(directory, 'askpass');
    await fs.writeFile(helper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'askpass-client.js'))} "$@"\n`, { mode: 0o700 });
    return {
      controlPath: path.join(directory, 'ctl'),
      env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0',
        ELECTRON_RUN_AS_NODE: '1', MAGPIE_ASKPASS_PORT: String(server.address().port), MAGPIE_ASKPASS_TOKEN: token },
      close
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { startAuth };
