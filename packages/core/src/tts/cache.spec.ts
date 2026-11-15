import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setAuditEnabled } from '../audit.js';
import type { CacheConfig } from './interface.js';
import { cacheAudio, clearCache, flushCacheMaintenance, getCachedAudio, getCacheKey, getCacheStats } from './cache.js';

test('cacheAudio serves immediate in-flight hits, writes non-blockingly without scanning existing files synchronously, and evicts in background', async () => {
  setAuditEnabled(false);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-tts-cache-'));
  // 1 MB max limit so two ~600 KB entries trigger eviction of the oldest file
  const config: CacheConfig = { enabled: true, directory: cacheDir, maxSizeMB: 1 };

  try {
    const firstBuf = Buffer.alloc(600 * 1024, 0x41);
    const secondBuf = Buffer.alloc(600 * 1024, 0x42);

    const firstWrite = cacheAudio(config, 'first phrase', 'kokoro:onnx-v1.0:a:af_heart', 1, firstBuf);

    // Immediate read-after-write before awaiting disk I/O must hit from memory
    const immediateHit = getCachedAudio(config, 'first phrase', 'kokoro:onnx-v1.0:a:af_heart', 1);
    assert.ok(immediateHit);
    assert.equal(immediateHit.length, firstBuf.length);
    assert.equal(immediateHit[0], 0x41);

    await firstWrite;
    await flushCacheMaintenance(cacheDir);

    const firstKey = getCacheKey('first phrase', 'kokoro:onnx-v1.0:a:af_heart', 1);
    const firstPath = path.join(cacheDir, `${firstKey}.wav`);
    assert.equal(fs.existsSync(firstPath), true, 'first entry must be persisted to disk');

    const past = new Date(Date.now() - 5000);
    fs.utimesSync(firstPath, past, past);
    clearCache({ enabled: false, directory: cacheDir, maxSizeMB: 1 });
    assert.equal(getCacheStats(config).files, 1);

    await cacheAudio(config, 'second phrase', 'kokoro:onnx-v1.0:a:af_heart', 1, secondBuf);
    await flushCacheMaintenance(cacheDir);

    const secondKey = getCacheKey('second phrase', 'kokoro:onnx-v1.0:a:af_heart', 1);
    const secondPath = path.join(cacheDir, `${secondKey}.wav`);

    assert.equal(fs.existsSync(secondPath), true, 'newest entry must survive eviction');
    assert.equal(fs.existsSync(firstPath), false, 'oldest entry exceeding maxSizeMB must be evicted');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('clearCache invalidates in-flight async writes and prevents stale file resurrection', async () => {
  setAuditEnabled(false);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-tts-cache-clear-'));
  const config: CacheConfig = { enabled: true, directory: cacheDir, maxSizeMB: 10 };

  try {
    const pending = cacheAudio(config, 'ephemeral phrase', 'kokoro:onnx-v1.0:a:af_heart', 1, Buffer.from('RIFF-temp'));
    clearCache(config);

    assert.equal(getCachedAudio(config, 'ephemeral phrase', 'kokoro:onnx-v1.0:a:af_heart', 1), null);

    await pending;
    await flushCacheMaintenance(cacheDir);

    assert.equal(getCachedAudio(config, 'ephemeral phrase', 'kokoro:onnx-v1.0:a:af_heart', 1), null);
    const wavFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter(f => f.endsWith('.wav')) : [];
    assert.equal(wavFiles.length, 0);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cacheAudio handles unwritable destinations without unhandled rejection and releases staged memory', async () => {
  setAuditEnabled(false);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-tts-cache-err-'));
  const blockingFile = path.join(tempRoot, 'not-a-directory');
  fs.writeFileSync(blockingFile, 'blocker');
  const badConfig: CacheConfig = { enabled: true, directory: blockingFile, maxSizeMB: 10 };

  try {
    await cacheAudio(badConfig, 'failing phrase', 'kokoro:onnx-v1.0:a:af_heart', 1, Buffer.from('RIFF-fail'));
    await flushCacheMaintenance(blockingFile);
    assert.equal(getCachedAudio(badConfig, 'failing phrase', 'kokoro:onnx-v1.0:a:af_heart', 1), null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
