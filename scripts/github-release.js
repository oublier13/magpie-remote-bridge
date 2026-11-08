'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const repository = 'wkoa/magpie-remote-bridge';

async function downloadPackage(url, { fetchImpl = fetch, pause = ms => new Promise(r => setTimeout(r, ms)), attempts = 30 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Marketplace did not return a VSIX archive');
      return buffer;
    } catch (error) {
      if (attempt === attempts) throw new Error(`Marketplace package is unavailable after ${attempts} attempts: ${error.message}`);
      console.log(`Waiting for Marketplace validation (${attempt}/${attempts})…`);
      await pause(15000);
    }
  }
}

async function syncRelease({ manifest, sha, repo = repository, run = exec, download = downloadPackage, output = console.log }) {
  if (repo !== repository || manifest.publisher !== 'wkoa' || manifest.name !== 'magpie-remote-bridge' ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('Invalid repository, publisher, extension version or source commit');
  }
  const tag = `v${manifest.version}`;
  const filename = `${manifest.name}-${manifest.version}.vsix`;
  let existing;
  try {
    existing = JSON.parse((await run('gh', ['api', `repos/${repo}/releases/tags/${tag}`])).stdout);
  } catch (error) {
    if (!/\b404\b/.test(String(error.stderr || ''))) throw error;
  }
  const names = new Set((existing?.assets || []).map(asset => asset.name));
  if (existing?.draft || existing?.prerelease) throw new Error(`Release ${tag} exists as a draft or prerelease; review it before publishing`);
  if (names.has(filename) && names.has(filename + '.sha256')) {
    output(`Release ${tag} already contains the VSIX and checksum; skipping.`);
    return { skipped: true, tag };
  }
  // A repeated CI build can have different ZIP timestamps. Download the actual
  // published Marketplace package instead of attaching a rebuild of that version.
  const buffer = await download(`https://marketplace.visualstudio.com/_apis/public/gallery/publishers/wkoa/vsextensions/magpie-remote-bridge/${manifest.version}/vspackage`);
  const digest = createHash('sha256').update(buffer).digest('hex');
  const existingBinary = existing?.assets?.find(asset => asset.name === filename);
  if (existingBinary?.digest && existingBinary.digest !== `sha256:${digest}`) {
    throw new Error(`Existing ${filename} differs from Marketplace; refusing to overwrite it`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mpb-release-'));
  try {
    const binary = path.join(directory, filename);
    const checksum = binary + '.sha256';
    const notes = path.join(directory, 'release-notes.md');
    await fs.writeFile(binary, buffer);
    const packaged = JSON.parse((await run('unzip', ['-p', binary, 'extension/package.json'])).stdout);
    if (packaged.publisher !== manifest.publisher || packaged.name !== manifest.name || packaged.version !== manifest.version) {
      throw new Error('Downloaded Marketplace package identity does not match the requested release');
    }
    await fs.writeFile(checksum, `${digest}  ${filename}\n`);
    if (existing) {
      const missing = [[filename, binary], [filename + '.sha256', checksum]].filter(([name]) => !names.has(name)).map(([, file]) => file);
      await run('gh', ['release', 'upload', tag, ...missing, '--repo', repo]);
    } else {
      await fs.writeFile(notes, `VS Code Marketplace 与 GitHub Release 同步发布。附件使用市场上的同一份 VSIX。\n\n- 版本：${manifest.version}\n- 源码提交：\`${sha}\`\n- SHA-256：\`${digest}\`\n\n更新详情：[Changelog](https://github.com/${repo}/blob/${sha}/CHANGELOG.md)\n\n安装：在本机 VS Code 选择“从 VSIX 安装”，或搜索 \`@id:wkoa.magpie-remote-bridge\`。\n`);
      await run('gh', ['release', 'create', tag, binary, checksum, '--repo', repo, '--target', sha,
        '--title', `Magpie Remote Bridge ${tag}`, '--notes-file', notes]);
    }
    output(`Synchronized GitHub Release ${tag} with the Marketplace VSIX.`);
    return { skipped: false, tag, digest };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const manifest = require('../package.json');
  syncRelease({ manifest, sha: process.env.GITHUB_SHA, repo: process.env.GITHUB_REPOSITORY || repository })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { downloadPackage, syncRelease };
