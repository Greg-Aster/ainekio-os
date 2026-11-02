import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease } from './build-release.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'metahuman-site-release-'));
  const site = path.join(root, 'apps/site');
  await mkdir(site, { recursive: true });
  try { await run(site); } finally { await rm(root, { recursive: true, force: true }); }
}

async function compile(outDir, value) {
  const server = path.join(fileURLToPath(outDir), 'server');
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, 'entry.mjs'), 'export const later = () => import("./conversation.mjs");');
  await writeFile(path.join(server, 'conversation.mjs'), `export default ${JSON.stringify(value)};`);
}

test('a running release can import conversation lazily after another build is selected', async () => {
  await fixture(async site => {
    const first = await buildRelease(site, outDir => compile(outDir, 'first conversation'));
    const entry = await realpath(path.join(site, 'dist/server/entry.mjs'));
    const running = await import(pathToFileURL(entry).href);
    const second = await buildRelease(site, outDir => compile(outDir, 'second conversation'));
    assert.notEqual(first, second);
    assert.equal((await running.later()).default, 'first conversation');
    const selected = await import(pathToFileURL(await realpath(path.join(site, 'dist/server/entry.mjs'))).href);
    assert.equal((await selected.later()).default, 'second conversation');
    assert.equal(await readFile(path.join(first, 'server/conversation.mjs'), 'utf8'), 'export default "first conversation";');
  });
});

test('failed builds leave the selected release intact', async () => {
  await fixture(async site => {
    const first = await buildRelease(site, outDir => compile(outDir, 'retained'));
    let attempted;
    await assert.rejects(buildRelease(site, async outDir => {
      attempted = fileURLToPath(outDir);
      await compile(outDir, 'incomplete');
      throw new Error('Compiler failed');
    }), /Compiler failed/);
    assert.equal(await realpath(path.join(site, 'dist')), first);
    await assert.rejects(readFile(path.join(attempted, 'server/entry.mjs')), { code: 'ENOENT' });
  });
});

test('first release preserves an existing directory build', async () => {
  await fixture(async site => {
    await compile(pathToFileURL(`${site}/dist/`), 'previous layout');
    const release = await buildRelease(site, outDir => compile(outDir, 'release layout'));
    assert.equal(await realpath(path.join(site, 'dist')), release);
    const { readdir } = await import('node:fs/promises');
    const previous = (await readdir(path.join(site, 'build/releases'))).find(name => name.startsWith('previous-'));
    assert.ok(previous);
    assert.equal((await import(pathToFileURL(path.join(site, 'build/releases', previous, 'server/conversation.mjs')).href)).default,
      'previous layout');
  });
});
