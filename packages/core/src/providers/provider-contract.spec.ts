import assert from "node:assert/strict";
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { HuggingFaceProvider } from './huggingface.js';
import { callRemoteProvider } from './remote.js';
import { RunPodServerlessProvider } from './runpod.js';

test('rejects incomplete provider configuration at construction', () => {
  assert.throws(
    () => new RunPodServerlessProvider({ apiKey: '', endpointId: 'endpoint' }),
    /API key is required/,
  );
  assert.throws(
    () => new HuggingFaceProvider({ apiKey: 'token', endpointUrl: '', timeout: 1000 }),
    /endpoint URL is required/,
  );
});

test('honors a zero-retry RunPod policy', async (context) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('offline');
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = new RunPodServerlessProvider({
    apiKey: 'token',
    endpointId: 'endpoint',
    maxRetries: 0,
  });
  await assert.rejects(
    provider.generate([{ role: 'user', content: 'hello' }]),
    /Network error: offline/,
  );
  assert.equal(calls, 1);
});

test('rejects unsupported HuggingFace image content before transport', async () => {
  const provider = new HuggingFaceProvider({
    apiKey: 'token',
    endpointUrl: 'https://example.test/generate',
  });
  await assert.rejects(
    provider.generate([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }]),
    /do not support image message content/,
  );
});

test('direct Gemini API preserves system instructions, inline images, and normalized JSON schemas', async () => {
  let capturedUrl = '';
  let capturedBody: any = null;
  const server = createServer(async (req, res) => {
    capturedUrl = req.url || '';
    let raw = '';
    for await (const chunk of req) raw += chunk;
    capturedBody = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      modelVersion: 'gemini-3.5-flash-lite',
      candidates: [{ content: { parts: [{ text: '{"kind":"none","done":true}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const response = await callRemoteProvider(
      { provider: 'gemini', apiKey: 'test-key', endpoint: `http://127.0.0.1:${port}/v1beta`, model: 'gemini-3.5-flash-lite' },
      [
        { role: 'system', content: 'Ainekio OS persona system prompt.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What do you see?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } },
          ],
        },
      ],
      {
        temperature: 0.2,
        jsonSchema: {
          type: 'object',
          required: ['kind', 'done'],
          properties: {
            kind: { const: 'none' },
            done: { type: 'boolean' },
          },
        },
      },
    );
    assert.equal(capturedUrl, '/v1beta/models/gemini-3.5-flash-lite:generateContent?key=test-key');
    assert.deepEqual(capturedBody.systemInstruction, { parts: [{ text: 'Ainekio OS persona system prompt.' }] });
    assert.deepEqual(capturedBody.contents, [{
      role: 'user',
      parts: [
        { text: 'What do you see?' },
        { inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } },
      ],
    }]);
    assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(capturedBody.generationConfig.responseJsonSchema.properties.kind, {
      type: 'string',
      enum: ['none'],
    });
    assert.equal(capturedBody.generationConfig.thinkingConfig, undefined);
    assert.equal(response.provider, 'gemini');
    assert.equal(response.content, '{"kind":"none","done":true}');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
