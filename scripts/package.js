'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createVSIX } = require('@vscode/vsce');
const manifest = require('../package.json');

(async () => {
  const cwd = path.resolve(__dirname, '..');
  const directory = path.join(cwd, 'dist');
  await fs.mkdir(directory, { recursive: true });
  await createVSIX({ cwd, packagePath: path.join(directory, `${manifest.name}-${manifest.version}.vsix`), dependencies: false });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
