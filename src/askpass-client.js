'use strict';
// Executed only by OpenSSH SSH_ASKPASS. The only stdout is the requested secret.
const http = require('node:http');
const req = http.request({ hostname: '127.0.0.1', port: Number(process.env.MAGPIE_ASKPASS_PORT),
  path: '/askpass', method: 'POST', headers: {
    authorization: `Bearer ${process.env.MAGPIE_ASKPASS_TOKEN}`, 'content-type': 'application/json'
  } }, res => {
  let value = '';
  res.setEncoding('utf8'); res.on('data', c => { value += c; if (value.length > 16384) req.destroy(); });
  res.on('end', () => {
    if (res.statusCode !== 200) { process.exitCode = 1; return; }
    process.stdout.write(value + '\n');
  });
  res.on('error', () => { process.exitCode = 1; });
});
req.setTimeout(180000, () => req.destroy());
req.on('error', () => { process.exitCode = 1; });
req.end(JSON.stringify({ challenge: process.argv.slice(2).join(' ') }));
