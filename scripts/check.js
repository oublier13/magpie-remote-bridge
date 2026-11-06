'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const placeholders = value => (value.match(/\{\d+\}/g) || []).sort().join(',');

function runtimeMessages() {
  const messages = new Set();
  for (const file of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    for (const match of text.matchAll(/\bt\('((?:\\.|[^'\\])*)'/g)) {
      const encoded = match[1].replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"');
      messages.add(JSON.parse(`"${encoded}"`));
    }
  }
  return messages;
}

function checkLocalization() {
  const manifest = json('package.json');
  const en = json('package.nls.json');
  const zh = json('package.nls.zh-cn.json');
  const runtime = json('l10n/bundle.l10n.zh-cn.json');
  for (const match of JSON.stringify(manifest).matchAll(/%([\w.]+)%/g)) {
    if (!en[match[1]] || !zh[match[1]]) throw new Error(`Missing manifest translation: ${match[1]}`);
  }
  for (const key of Object.keys(en)) {
    if (!zh[key] || placeholders(en[key]) !== placeholders(zh[key])) throw new Error(`Invalid manifest translation: ${key}`);
  }
  for (const message of runtimeMessages()) {
    if (!runtime[message] || placeholders(message) !== placeholders(runtime[message])) throw new Error(`Missing or invalid UI translation: ${message}`);
  }
}

function check() {
  for (const file of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, 'src', file)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `Syntax error in ${file}`);
  }
  if (process.platform !== 'win32') {
    const result = spawnSync('python3', ['-I', '-c', 'import sys; compile(sys.stdin.read(), "codex-remote.py", "exec")'], {
      input: fs.readFileSync(path.join(root, 'src', 'codex-remote.py'), 'utf8'), encoding: 'utf8'
    });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Python 3 syntax check failed');
  }
  checkLocalization();
  const manifest = json('package.json');
  const lock = json('package-lock.json');
  if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version) throw new Error('Manifest and lockfile versions differ');
  console.log('Source syntax, localization and manifest consistency checks passed.');
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { checkLocalization, runtimeMessages };
