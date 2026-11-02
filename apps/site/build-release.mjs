import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Compile separately; running servers and workers retain their original files. */
export async function buildRelease(site, compile) {
  const releases = path.join(site, 'build/releases');
  const release = path.join(releases, randomUUID());
  const selected = path.join(site, 'dist');
  const next = path.join(site, `.dist-${randomUUID()}`);
  await mkdir(release, { recursive: true });
  try {
    await compile(pathToFileURL(`${release}/`));
  } catch (error) {
    await rm(release, { recursive: true, force: true });
    throw error;
  }
  // Preserve the pre-release layout once. Activation restarts that older server;
  // subsequent processes resolve the selected release before importing modules.
  const current = await lstat(selected).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const previous = current && !current.isSymbolicLink()
    ? path.join(releases, `previous-${randomUUID()}`) : null;
  let displaced = false;
  try {
    await symlink(path.relative(site, release), next, 'dir');
    if (previous) {
      await rename(selected, previous);
      displaced = true;
    }
    await rename(next, selected);
  } catch (error) {
    await rm(next, { force: true });
    if (displaced) await rename(previous, selected);
    await rm(release, { recursive: true, force: true });
    throw error;
  }
  console.log(`Site release: ${release}`);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { build } = await import('astro');
  const site = path.dirname(fileURLToPath(import.meta.url));
  await buildRelease(site, outDir => build({ root: site, outDir: fileURLToPath(outDir) }));
}
