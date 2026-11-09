/**
 * Shared TTS Cache Utilities
 * Used by all TTS providers for consistent caching
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { audit } from '../audit.js';
import type { CacheConfig } from './interface.js';

/**
 * Generate a cache key for text, model/provider, and speaking rate
 */
export function getCacheKey(text: string, identifier: string, speakingRate: number): string {
  const key = `${text}|${identifier}|${speakingRate}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Check if cached audio exists
 */
export function getCachedAudio(
  cacheConfig: CacheConfig,
  text: string,
  identifier: string,
  speakingRate: number
): Buffer | null {
  if (!cacheConfig.enabled) return null;

  const cacheKey = getCacheKey(text, identifier, speakingRate);
  const cachePath = path.join(cacheConfig.directory, `${cacheKey}.wav`);

  if (fs.existsSync(cachePath)) {
    audit({
      level: 'info',
      category: 'action',
      event: 'tts_cache_hit',
      details: { cacheKey, textLength: text.length, identifier, speakingRate },
      actor: 'system',
    });
    return fs.readFileSync(cachePath);
  }

  return null;
}

interface CacheDirIndex {
  totalBytes: number;
  entries: Map<string, { size: number; mtimeMs: number }>;
}

const directoryIndexCache = new Map<string, CacheDirIndex>();

function getOrLoadDirIndex(directory: string): CacheDirIndex {
  let index = directoryIndexCache.get(directory);
  if (index && fs.existsSync(directory)) {
    return index;
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
  index = { totalBytes, entries };
  directoryIndexCache.set(directory, index);
  return index;
}

/**
 * Save audio to cache
 */
export function cacheAudio(
  cacheConfig: CacheConfig,
  text: string,
  identifier: string,
  speakingRate: number,
  audioBuffer: Buffer
): void {
  if (!cacheConfig.enabled) return;

  const cacheKey = getCacheKey(text, identifier, speakingRate);
  const cachePath = path.join(cacheConfig.directory, `${cacheKey}.wav`);

  // Ensure cache directory exists
  if (!fs.existsSync(cacheConfig.directory)) {
    fs.mkdirSync(cacheConfig.directory, { recursive: true });
    directoryIndexCache.delete(cacheConfig.directory);
  }

  const index = getOrLoadDirIndex(cacheConfig.directory);
  const previous = index.entries.get(cachePath);
  if (previous) {
    index.totalBytes = Math.max(0, index.totalBytes - previous.size);
  }

  fs.writeFileSync(cachePath, audioBuffer);
  index.entries.set(cachePath, { size: audioBuffer.length, mtimeMs: Date.now() });
  index.totalBytes += audioBuffer.length;
  enforceCacheLimit(cacheConfig, cachePath, index);

  audit({
    level: 'info',
    category: 'action',
    event: 'tts_cache_write',
    details: {
      cacheKey,
      textLength: text.length,
      audioSize: audioBuffer.length,
      identifier,
      speakingRate,
    },
    actor: 'system',
  });
}

function enforceCacheLimit(cacheConfig: CacheConfig, preservePath?: string, preloadedIndex?: CacheDirIndex): void {
  if (!cacheConfig.maxSizeMB || cacheConfig.maxSizeMB <= 0 || !fs.existsSync(cacheConfig.directory)) {
    return;
  }

  const maxBytes = cacheConfig.maxSizeMB * 1024 * 1024;
  const index = preloadedIndex ?? getOrLoadDirIndex(cacheConfig.directory);
  if (index.totalBytes <= maxBytes) return;

  const sorted = [...index.entries.entries()].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  for (const [filePath, meta] of sorted) {
    if (index.totalBytes <= maxBytes) break;
    if (preservePath && filePath === preservePath) continue;
    try {
      fs.unlinkSync(filePath);
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
  if (!cacheConfig.enabled || !fs.existsSync(cacheConfig.directory)) {
    return { size: 0, files: 0 };
  }

  const index = getOrLoadDirIndex(cacheConfig.directory);
  return {
    size: Math.round((index.totalBytes / (1024 * 1024)) * 100) / 100, // MB
    files: index.entries.size,
  };
}

/**
 * Clear cache directory
 */
export function clearCache(cacheConfig: CacheConfig): number {
  if (!cacheConfig.enabled || !fs.existsSync(cacheConfig.directory)) {
    directoryIndexCache.delete(cacheConfig.directory);
    return 0;
  }

  const files = fs.readdirSync(cacheConfig.directory).filter((f) => f.endsWith('.wav'));

  for (const file of files) {
    fs.unlinkSync(path.join(cacheConfig.directory, file));
  }
  directoryIndexCache.delete(cacheConfig.directory);

  audit({
    level: 'info',
    category: 'action',
    event: 'tts_cache_cleared',
    details: { filesDeleted: files.length },
    actor: 'system',
  });

  return files.length;
}
