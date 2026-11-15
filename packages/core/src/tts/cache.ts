/**
 * Shared TTS Cache Utilities
 * Used by all TTS providers for consistent caching
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { audit } from '../audit.js';
import type { CacheConfig } from './interface.js';

interface CacheDirIndex {
  totalBytes: number;
  entries: Map<string, { size: number; mtimeMs: number }>;
}

interface PendingCacheWrite {
  buffer: Buffer;
  directory: string;
  generation: number;
}

const directoryIndexCache = new Map<string, CacheDirIndex>();
const loadingDirIndexPromises = new Map<string, Promise<CacheDirIndex>>();
const directoryMaintenanceQueues = new Map<string, Promise<void>>();
const directoryGenerations = new Map<string, number>();
const knownDirectories = new Set<string>();
const pendingWrites = new Map<string, PendingCacheWrite>();
let tempFileSequence = 0;

function normalizeDir(directory: string): string {
  return path.resolve(directory);
}

function getDirectoryGeneration(directory: string): number {
  return directoryGenerations.get(directory) ?? 0;
}

/**
 * Generate a cache key for text, model/provider, and speaking rate
 */
export function getCacheKey(text: string, identifier: string, speakingRate: number): string {
  const key = `${text}|${identifier}|${speakingRate}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Check if cached audio exists (including in-flight async cache writes)
 */
export function getCachedAudio(
  cacheConfig: CacheConfig,
  text: string,
  identifier: string,
  speakingRate: number
): Buffer | null {
  if (!cacheConfig.enabled) return null;

  const directory = normalizeDir(cacheConfig.directory);
  const cacheKey = getCacheKey(text, identifier, speakingRate);
  const cachePath = path.join(directory, `${cacheKey}.wav`);

  const pending = pendingWrites.get(cachePath);
  if (pending && pending.generation === getDirectoryGeneration(directory)) {
    audit({
      level: 'info',
      category: 'action',
      event: 'tts_cache_hit',
      details: { cacheKey, textLength: text.length, identifier, speakingRate },
      actor: 'system',
    });
    return Buffer.from(pending.buffer);
  }

  try {
    const buffer = fs.readFileSync(cachePath);
    audit({
      level: 'info',
      category: 'action',
      event: 'tts_cache_hit',
      details: { cacheKey, textLength: text.length, identifier, speakingRate },
      actor: 'system',
    });
    return buffer;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function loadDirIndexSync(directory: string): CacheDirIndex {
  const cached = directoryIndexCache.get(directory);
  if (cached && fs.existsSync(directory)) {
    return cached;
  }
  const entries = new Map<string, { size: number; mtimeMs: number }>();
  let totalBytes = 0;
  if (fs.existsSync(directory)) {
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.wav')) continue;
      const filePath = path.join(directory, file);
      try {
        const stat = fs.statSync(filePath);
        totalBytes += stat.size;
        entries.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files deleted concurrently
      }
    }
  }
  const index = { totalBytes, entries };
  directoryIndexCache.set(directory, index);
  return index;
}

async function getOrLoadDirIndexAsync(directory: string, expectedGeneration: number): Promise<CacheDirIndex | null> {
  const existing = directoryIndexCache.get(directory);
  if (existing) {
    try {
      await fsPromises.access(directory);
      return existing;
    } catch {
      directoryIndexCache.delete(directory);
      knownDirectories.delete(directory);
      return null;
    }
  }

  const inFlight = loadingDirIndexPromises.get(directory);
  if (inFlight) return inFlight;

  const loadPromise = (async (): Promise<CacheDirIndex> => {
    const entries = new Map<string, { size: number; mtimeMs: number }>();
    let totalBytes = 0;
    const files = (await fsPromises.readdir(directory)).filter(file => file.endsWith('.wav'));
    const batchSize = 64;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      if (getDirectoryGeneration(directory) !== expectedGeneration) break;
      const batch = files.slice(offset, offset + batchSize);
      const stats = await Promise.all(
        batch.map(async (file) => {
          const filePath = path.join(directory, file);
          try {
            const stat = await fsPromises.stat(filePath);
            return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
      );
      for (const item of stats) {
        if (!item) continue;
        totalBytes += item.size;
        entries.set(item.filePath, { size: item.size, mtimeMs: item.mtimeMs });
      }
    }
    const index: CacheDirIndex = { totalBytes, entries };
    if (getDirectoryGeneration(directory) === expectedGeneration) {
      directoryIndexCache.set(directory, index);
    }
    return index;
  })().finally(() => {
    if (loadingDirIndexPromises.get(directory) === loadPromise) {
      loadingDirIndexPromises.delete(directory);
    }
  });

  loadingDirIndexPromises.set(directory, loadPromise);
  try {
    return await loadPromise;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      directoryIndexCache.delete(directory);
      knownDirectories.delete(directory);
      return null;
    }
    throw error;
  }
}

function enqueueDirectoryMaintenance(directory: string, task: () => Promise<void>): Promise<void> {
  const previous = directoryMaintenanceQueues.get(directory) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.finally(() => {
    if (directoryMaintenanceQueues.get(directory) === tracked) {
      directoryMaintenanceQueues.delete(directory);
    }
  });
  directoryMaintenanceQueues.set(directory, tracked);
  return tracked;
}

export async function flushCacheMaintenance(directory?: string): Promise<void> {
  if (directory !== undefined) {
    await (directoryMaintenanceQueues.get(normalizeDir(directory)) ?? Promise.resolve());
    return;
  }
  await Promise.all([...directoryMaintenanceQueues.values()]);
}

/**
 * Persist synthesized audio asynchronously without blocking the Node event loop,
 * while scheduling directory-index scan and size-limit eviction in the background.
 */
export async function cacheAudio(
  cacheConfig: CacheConfig,
  text: string,
  identifier: string,
  speakingRate: number,
  audioBuffer: Buffer
): Promise<void> {
  if (!cacheConfig.enabled) return;

  const directory = normalizeDir(cacheConfig.directory);
  const generation = getDirectoryGeneration(directory);
  const cacheKey = getCacheKey(text, identifier, speakingRate);
  const cachePath = path.join(directory, `${cacheKey}.wav`);
  const stagedCopy = Buffer.from(audioBuffer);
  const pendingEntry: PendingCacheWrite = { buffer: stagedCopy, directory, generation };
  pendingWrites.set(cachePath, pendingEntry);

  const tempPath = `${cachePath}.${process.pid}.${++tempFileSequence}.tmp`;
  try {
    if (!knownDirectories.has(directory)) {
      await fsPromises.mkdir(directory, { recursive: true });
      knownDirectories.add(directory);
    }
    if (getDirectoryGeneration(directory) !== generation) {
      return;
    }

    try {
      await fsPromises.writeFile(tempPath, stagedCopy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fsPromises.mkdir(directory, { recursive: true });
      knownDirectories.add(directory);
      if (getDirectoryGeneration(directory) !== generation) return;
      await fsPromises.writeFile(tempPath, stagedCopy);
    }

    if (getDirectoryGeneration(directory) !== generation) {
      await fsPromises.rm(tempPath, { force: true });
      return;
    }
    await fsPromises.rename(tempPath, cachePath);
    const writtenAt = Date.now();

    audit({
      level: 'info',
      category: 'action',
      event: 'tts_cache_write',
      details: {
        cacheKey,
        textLength: text.length,
        audioSize: stagedCopy.length,
        identifier,
        speakingRate,
      },
      actor: 'system',
    });

    void enqueueDirectoryMaintenance(directory, async () => {
      if (getDirectoryGeneration(directory) !== generation) return;
      try {
        const index = await getOrLoadDirIndexAsync(directory, generation);
        if (!index || getDirectoryGeneration(directory) !== generation) return;
        const previous = index.entries.get(cachePath);
        if (previous) {
          index.totalBytes = Math.max(0, index.totalBytes - previous.size);
        }
        index.entries.set(cachePath, { size: stagedCopy.length, mtimeMs: writtenAt });
        index.totalBytes += stagedCopy.length;
        await enforceCacheLimitAsync(cacheConfig, directory, cachePath, index, generation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        console.warn('[tts-cache] Background cache maintenance failed:', error);
      }
    });
  } catch (error) {
    knownDirectories.delete(directory);
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    console.warn('[tts-cache] Failed to persist cached audio:', error);
    audit({
      level: 'warn',
      category: 'action',
      event: 'tts_cache_write_failed',
      details: {
        cacheKey,
        cachePath,
        textLength: text.length,
        audioSize: stagedCopy.length,
        identifier,
        error: (error as Error).message,
      },
      actor: 'system',
    });
  } finally {
    if (pendingWrites.get(cachePath) === pendingEntry) {
      pendingWrites.delete(cachePath);
    }
  }
}

async function enforceCacheLimitAsync(
  cacheConfig: CacheConfig,
  directory: string,
  preservePath: string,
  index: CacheDirIndex,
  expectedGeneration: number
): Promise<void> {
  if (!cacheConfig.maxSizeMB || cacheConfig.maxSizeMB <= 0) {
    return;
  }

  const maxBytes = cacheConfig.maxSizeMB * 1024 * 1024;
  if (index.totalBytes <= maxBytes) return;

  const sorted = [...index.entries.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  for (const [filePath, meta] of sorted) {
    if (index.totalBytes <= maxBytes || getDirectoryGeneration(directory) !== expectedGeneration) break;
    if (filePath === preservePath || pendingWrites.has(filePath)) continue;
    try {
      await fsPromises.unlink(filePath);
    } catch {
      // Ignore concurrent unlink
    }
    index.entries.delete(filePath);
    index.totalBytes = Math.max(0, index.totalBytes - meta.size);
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(cacheConfig: CacheConfig): { size: number; files: number } {
  const directory = normalizeDir(cacheConfig.directory);
  if (!cacheConfig.enabled || !fs.existsSync(directory)) {
    return { size: 0, files: 0 };
  }

  const index = loadDirIndexSync(directory);
  return {
    size: Math.round((index.totalBytes / (1024 * 1024)) * 100) / 100, // MB
    files: index.entries.size,
  };
}

/**
 * Clear cache directory
 */
export function clearCache(cacheConfig: CacheConfig): number {
  const directory = normalizeDir(cacheConfig.directory);
  directoryGenerations.set(directory, getDirectoryGeneration(directory) + 1);
  for (const [cachePath, entry] of pendingWrites.entries()) {
    if (entry.directory === directory) {
      pendingWrites.delete(cachePath);
    }
  }
  loadingDirIndexPromises.delete(directory);
  knownDirectories.delete(directory);

  if (!cacheConfig.enabled || !fs.existsSync(directory)) {
    directoryIndexCache.delete(directory);
    return 0;
  }

  const files = fs.readdirSync(directory).filter((f) => f.endsWith('.wav'));

  for (const file of files) {
    try {
      fs.unlinkSync(path.join(directory, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  directoryIndexCache.delete(directory);

  audit({
    level: 'info',
    category: 'action',
    event: 'tts_cache_cleared',
    details: { filesDeleted: files.length },
    actor: 'system',
  });

  return files.length;
}
