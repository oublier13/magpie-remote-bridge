'use strict';
// Executed only by OpenSSH SSH_ASKPASS. The only stdout is the requested secret.
const http = require('node:http');

function run() {
  const port = Number(process.env.MAGPIE_ASKPASS_PORT);
  const token = process.env.MAGPIE_ASKPASS_TOKEN;
  const body = JSON.stringify({ challenge: process.argv.slice(2).join(' ') });
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || Buffer.byteLength(body) > 4096) {
    process.exitCode = 1; return;
  }
  let req; let response; let timer; let settled = false; let bytes = 0; const chunks = [];
  const finish = success => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (!success) { process.exitCode = 1; response?.destroy(); req?.destroy(); return; }
    const onOutputError = () => { process.exitCode = 1; };
    process.stdout.once('error', onOutputError);
    process.stdout.write(Buffer.concat(chunks, bytes).toString('utf8') + '\n', error => {
      if (error) process.exitCode = 1;
      else process.stdout.removeListener('error', onOutputError);
    });
  };
  try {
    http.validateHeaderValue('authorization', `Bearer ${token}`);
    timer = setTimeout(() => finish(false), 180000);
    req = http.request({ hostname: '127.0.0.1', port, agent: false,
      path: '/askpass', method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
      } }, res => {
      response = res;
      res.on('error', () => finish(false)); res.once('aborted', () => finish(false));
      res.once('close', () => { if (!settled) finish(false); });
      if (res.statusCode !== 200) { finish(false); return; }
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) finish(false);
        else if (!settled) chunks.push(chunk);
      });
      res.once('end', () => finish(true));
    });
    req.on('error', () => finish(false)); req.end(body);
  } catch { finish(false); }
}
run();
