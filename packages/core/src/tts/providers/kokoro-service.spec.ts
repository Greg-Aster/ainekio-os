import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CacheConfig, KokoroConfig } from '../interface.js';
import { setAuditEnabled } from '../../audit.js';
import { KokoroService, resetKokoroServerReadinessCache } from './kokoro-service.js';
import { getCacheKey } from '../cache.js';
import { splitSpeechText } from '../speech-chunks.js';

setAuditEnabled(false);

const config: KokoroConfig = {
  langCode: 'a',
  voice: 'af_heart',
  speed: 1,
  useCustomVoicepack: false,
  customVoicepackPath: '/unused/custom.pt',
  autoFallbackToPiper: false,
  outputFormat: 'wav',
};

test('Kokoro streams early, bypasses old engine audio, and reuses its ONNX cache', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-kokoro-cache-'));
  const cache: CacheConfig = { enabled: true, directory: cacheDir, maxSizeMB: 10 };
  const synthesisTexts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.endsWith('/synthesize')) {
      const request = JSON.parse(String(init?.body)) as { text: string };
      synthesisTexts.push(request.text);
      return new Response(Buffer.from(`wav:${request.text}`), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const text = [
    'The first sentence should become playable quickly for the waiting person.',
    'The second sentence must not delay the first synthesis result unnecessarily.',
    'The third sentence continues with enough detail to require another audio phrase.',
    'The final sentence completes the response after earlier audio is available.',
  ].join(' ');

  for (const chunk of splitSpeechText(text)) {
    const key = getCacheKey(chunk, 'kokoro:a:af_heart', 1);
    fs.writeFileSync(path.join(cacheDir, `${key}.wav`), 'old-pytorch-audio');
  }

  try {
    const service = new KokoroService(config, cache);
    const iterator = service.synthesizeStream(text, { requestId: 'stream-test' });
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(synthesisTexts.length, 1);
    assert.equal(first.value?.index, 0);
    assert.equal(first.value?.cacheHit, false);

    const remaining = [];
    for await (const chunk of iterator) remaining.push(chunk);
    assert.ok(remaining.length >= 1);
    const requestCount = synthesisTexts.length;

    const cached = [];
    for await (const chunk of service.synthesizeStream(text, { requestId: 'cache-test' })) {
      cached.push(chunk);
    }
    assert.equal(synthesisTexts.length, requestCount);
    assert.ok(cached.every(chunk => chunk.cacheHit));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Kokoro skips redundant per-utterance /health calls on a healthy server and recovers cleanly on 503 or disconnect', async () => {
  resetKokoroServerReadinessCache();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-kokoro-ready-'));
  const cache: CacheConfig = { enabled: false, directory: cacheDir, maxSizeMB: 10 };
  const originalFetch = globalThis.fetch;
  let healthCalls = 0;
  let synthCalls = 0;
  let mode: 'healthy' | 'loading-once' | 'disconnected-once' | 'server-500' = 'healthy';

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    init?.signal?.throwIfAborted();
    if (url.endsWith('/health')) {
      healthCalls += 1;
      return Response.json({ status: 'ok' });
    }
    if (url.endsWith('/synthesize')) {
      synthCalls += 1;
      if (mode === 'loading-once') {
        mode = 'healthy';
        return new Response(JSON.stringify({ detail: 'Pipeline not initialized' }), { status: 503 });
      }
      if (mode === 'disconnected-once') {
        mode = 'healthy';
        throw new TypeError('fetch failed');
      }
      if (mode === 'server-500') {
        return new Response(JSON.stringify({ detail: 'Synthesis failed: Invalid voice' }), { status: 500 });
      }
      return new Response(Buffer.from('RIFF-audio'), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    // Separate KokoroService instances (matching createKokoroTTSService per utterance)
    // must synthesize directly without blocking on /health when the server is healthy.
    const first = await new KokoroService(config, cache).synthesize('First healthy utterance.');
    const second = await new KokoroService(config, cache).synthesize('Second healthy utterance.');
    assert.equal(first.toString(), 'RIFF-audio');
    assert.equal(second.toString(), 'RIFF-audio');
    assert.equal(healthCalls, 0);
    assert.equal(synthCalls, 2);

    // 503 (pipeline loading) triggers readiness verification and retries synthesis once.
    mode = 'loading-once';
    const afterLoading = await new KokoroService(config, cache).synthesize('Utterance while loading.');
    assert.equal(afterLoading.toString(), 'RIFF-audio');
    assert.equal(healthCalls, 1);
    assert.equal(synthCalls, 4);

    // Connection failure triggers readiness verification/recovery and retries once.
    mode = 'disconnected-once';
    const afterDisconnect = await new KokoroService(config, cache).synthesize('Utterance after restart.');
    assert.equal(afterDisconnect.toString(), 'RIFF-audio');
    assert.equal(healthCalls, 2);
    assert.equal(synthCalls, 6);

    // Subsequent utterances return to zero /health round-trips.
    await new KokoroService(config, cache).synthesize('Warm utterance again.');
    assert.equal(healthCalls, 2);
    assert.equal(synthCalls, 7);

    // Synthesis 500 errors must surface immediately without retrying or probing /health.
    mode = 'server-500';
    await assert.rejects(
      new KokoroService(config, cache).synthesize('Bad voice request.'),
      /Kokoro server error \(500\)/,
    );
    assert.equal(healthCalls, 2);
    assert.equal(synthCalls, 8);

    // Aborted signals must abort without probing /health or retrying.
    mode = 'healthy';
    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      new KokoroService(config, cache).synthesize('Aborted utterance.', { signal: abortController.signal }),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
    assert.equal(healthCalls, 2);
  } finally {
    resetKokoroServerReadinessCache();
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
