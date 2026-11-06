'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { shellQuote } = require('./agents');

// A private askpass channel, not a password cache. Each SSH challenge is answered
// directly by a VS Code password input box; passwords are never written to disk.
async function startAuth(prompt) {
  if (process.platform === 'win32') return { close() {} };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mpb-'));
  await fs.chmod(directory, 0o700);
  const token = randomBytes(32).toString('hex');
  const sockets = new Set(); let closed = false; let prompting = false;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.url !== '/askpass' || supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); req.resume(); return; }
    if (closed || prompting) { res.writeHead(409); res.end(); req.resume(); return; }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) throw new Error('Oversized authentication challenge');
      }
      const { challenge } = JSON.parse(body);
      if (typeof challenge !== 'string') throw new Error('Invalid authentication challenge');
      prompting = true;
      const password = await prompt(challenge.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512));
      if (closed || password === undefined) { res.writeHead(403); res.end(); }
      else { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(password); }
    } catch { if (!res.destroyed) { res.writeHead(400); res.end(); } }
    finally { prompting = false; }
  });
  server.requestTimeout = 0;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const helper = path.join(directory, 'askpass');
    await fs.writeFile(helper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'askpass-client.js'))} "$@"\n`, { mode: 0o700 });
    return {
      controlPath: path.join(directory, 'ctl'),
      env: { ...process.env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0',
        ELECTRON_RUN_AS_NODE: '1', MAGPIE_ASKPASS_PORT: String(server.address().port), MAGPIE_ASKPASS_TOKEN: token },
      close() {
        closed = true;
        for (const socket of sockets) socket.destroy(); server.close();
        // Only generated helper/control files, in this extension's private directory.
        fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    };
  } catch (e) { for (const socket of sockets) socket.destroy(); server.close(); await fs.rm(directory, { recursive: true, force: true }); throw e; }
}
module.exports = { startAuth };
