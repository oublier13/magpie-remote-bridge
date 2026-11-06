'use strict';
const { isIP } = require('node:net');
const { validateHost } = require('./tunnel');

const userPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH 端口必须是 1 到 65535 之间的整数');
  }
  return port;
}

function parseTarget(input) {
  if (typeof input !== 'string' || !input || /\s/.test(input)) {
    throw new Error('SSH Host 不能为空，且不能包含空白或命令参数');
  }
  const parts = input.split('@');
  if (parts.length > 2 || (parts.length === 2 && !userPattern.test(parts[0]))) {
    throw new Error('无效的 SSH 用户名');
  }
  const address = parts[parts.length - 1];
  let host;
  let port;
  if (address.startsWith('[')) {
    const match = /^\[([^\[\]]+)\](?::([0-9]+))?$/.exec(address);
    if (!match || isIP(match[1]) !== 6) {
      throw new Error('IPv6 地址格式无效，请使用 [IPv6] 或 [IPv6]:端口');
    }
    host = match[1];
    port = match[2];
  } else if (isIP(address) === 6) {
    // A valid raw IPv6 address always names the host in full. An explicit port
    // requires brackets so its last segment cannot be mistaken for a port.
    host = address;
  } else {
    const match = /^([^:[\]]+)(?::([0-9]+))?$/.exec(address);
    if (!match) throw new Error('SSH 地址格式无效，请使用 host:端口 或 [IPv6]:端口');
    host = validateHost(match[1]);
    port = match[2];
  }
  const target = { host: validateHost(parts.length === 2 ? `${parts[0]}@${host}` : host) };
  if (port !== undefined) target.sshPort = validatePort(Number(port));
  return target;
}

// Remote-SSH uses either a plain alias or UTF-8 JSON encoded as hex. In
// particular, user@host connections are encoded so the user must be preserved.
function authorityTarget(authority) {
  if (typeof authority !== 'string' || !authority.startsWith('ssh-remote+')) {
    throw new Error('不是 Remote-SSH 工作区');
  }
  const raw = authority.slice('ssh-remote+'.length);
  let value;
  try { value = decodeURIComponent(raw); }
  catch { throw new Error('无法解析 Remote-SSH 地址，请手动选择 SSH Host'); }
  if (!/^7b[0-9a-f]*$/i.test(value)) return parseTarget(value);
  try {
    if (value.length % 2) throw new Error('Invalid hex');
    const data = JSON.parse(Buffer.from(value, 'hex').toString('utf8'));
    if (!data || typeof data.hostName !== 'string') throw new Error('Missing hostName');
    if (data.user !== undefined && (typeof data.user !== 'string' || !userPattern.test(data.user))) {
      throw new Error('Invalid user');
    }
    if (data.user && data.hostName.includes('@')) throw new Error('Ambiguous user');
    const target = parseTarget(data.user ? `${data.user}@${data.hostName}` : data.hostName);
    if (data.port !== undefined) target.sshPort = validatePort(data.port);
    return target;
  } catch {
    throw new Error('无法解析 Remote-SSH 编码地址，请手动选择 SSH Host（包含正确的用户名）');
  }
}

function savedTarget(saved, authority) {
  if (typeof saved !== 'string' && (!saved || typeof saved !== 'object' || Array.isArray(saved))) {
    throw new Error('无效的 SSH Host 映射');
  }
  const host = typeof saved === 'string' ? saved : saved.host;
  // Repair only the exact raw authority saved by older releases. Intentional
  // aliases and other user-selected hosts remain untouched.
  const isLegacy = typeof authority === 'string' && authority.startsWith('ssh-remote+') &&
    host === authority.slice('ssh-remote+'.length);
  const target = isLegacy ? authorityTarget(authority) : parseTarget(host);
  if (typeof saved === 'object' && saved.sshPort !== undefined) {
    target.sshPort = validatePort(saved.sshPort);
  }
  return target;
}

module.exports = { parseTarget, authorityTarget, savedTarget };
