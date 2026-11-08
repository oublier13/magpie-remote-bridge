'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { syncRelease, downloadPackage } = require('../scripts/github-release');

const manifest = { publisher: 'wkoa', name: 'magpie-remote-bridge', version: '0.3.2' };
const sha = 'a'.repeat(40);
const filename = 'magpie-remote-bridge-0.3.2.vsix';
const buffer = Buffer.from('PK\x03\x04published-marketplace-package');
const digest = createHash('sha256').update(buffer).digest('hex');
const notFound = () => Object.assign(new Error('Not found'), { stderr: 'gh: Not Found (HTTP 404)' });

function setup(existing, { packaged = manifest, apiError } = {}) {
  const calls = []; let downloads = 0;
  return {
    calls, downloads: () => downloads,
    options: {
      manifest, sha, output() {},
      download: async () => { downloads++; return buffer; },
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'api') {
          if (apiError) throw apiError;
          if (!existing) throw notFound();
          return { stdout: JSON.stringify(existing) };
        }
        if (command === 'unzip') return { stdout: JSON.stringify(packaged) };
        if (args[1] === 'create') {
          assert.deepEqual(await fs.readFile(args[3]), buffer);
          assert.equal(await fs.readFile(args[4], 'utf8'), `${digest}  ${filename}\n`);
          assert.equal(args[args.indexOf('--target') + 1], sha);
        }
        return { stdout: '' };
      }
    }
  };
}
test('new GitHub release attaches the actual Marketplace package and matching checksum', async () => {
  const f = setup(); const result = await syncRelease(f.options);
  assert.equal(result.digest, digest);
  const created = f.calls.find(c => c.args[1] === 'create');
  assert.ok(created); assert.ok(created.args.includes('--notes-file'));
  await assert.rejects(fs.stat(created.args[3]), { code: 'ENOENT' });
});
test('a complete release is idempotent and does not download or mutate anything', async () => {
  const f = setup({ assets: [{ name: filename }, { name: filename + '.sha256' }] });
  assert.equal((await syncRelease(f.options)).skipped, true);
  assert.equal(f.downloads(), 0); assert.equal(f.calls.length, 1);
});
test('a partial release uploads only missing attachments without clobbering existing assets', async () => {
  const f = setup({ assets: [{ name: filename, digest: `sha256:${digest}` }] });
  await syncRelease(f.options);
  const upload = f.calls.find(c => c.args[1] === 'upload');
  assert.ok(upload.args[3].endsWith('.vsix.sha256'));
  assert.ok(!upload.args.includes('--clobber'));
  assert.ok(!f.calls.some(c => c.args[1] === 'create'));
});
test('conflicting existing assets, draft releases and mismatched packages cannot be overwritten', async () => {
  const conflicting = setup({ assets: [{ name: filename, digest: 'sha256:wrong' }] });
  await assert.rejects(syncRelease(conflicting.options), /refusing to overwrite/);
  const draft = setup({ draft: true, assets: [] });
  await assert.rejects(syncRelease(draft.options), /draft or prerelease/);
  const mismatch = setup(null, { packaged: { ...manifest, publisher: 'another-publisher' } });
  await assert.rejects(syncRelease(mismatch.options), /identity does not match/);
  for (const f of [conflicting, draft, mismatch]) assert.ok(!f.calls.some(c => ['upload', 'create'].includes(c.args[1])));
});
test('authorization errors are not treated as a missing release', async () => {
  const f = setup(null, { apiError: Object.assign(new Error('Forbidden'), { stderr: 'HTTP 403' }) });
  await assert.rejects(syncRelease(f.options), /Forbidden/);
  assert.equal(f.downloads(), 0);
});
test('invalid release identity is rejected before accessing GitHub', async () => {
  const f = setup();
  await assert.rejects(syncRelease({ ...f.options, sha: 'main' }), /Invalid/);
  await assert.rejects(syncRelease({ ...f.options, repo: 'another/repo' }), /Invalid/);
  assert.equal(f.calls.length, 0);
});
test('package retrieval waits for Marketplace validation and rejects non-VSIX responses', async () => {
  let calls = 0; let waits = 0; let cancelled = 0;
  const result = await downloadPackage('https://example.invalid', {
    attempts: 2, pause: async () => { waits++; },
    fetchImpl: async () => ++calls === 1
      ? { ok: false, status: 404, body: { cancel: async () => { cancelled++; } } }
      : { ok: true, arrayBuffer: async () => buffer }
  });
  assert.deepEqual(result, buffer); assert.equal(waits, 1); assert.equal(cancelled, 1);
  await assert.rejects(downloadPackage('https://example.invalid', {
    attempts: 1, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>') })
  }), /did not return a VSIX/);
});
