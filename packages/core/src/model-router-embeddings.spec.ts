import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-embedding-operation-'));
process.env.METAHUMAN_ROOT = root;
fs.mkdirSync(path.join(root, 'profiles/fixture/etc'), { recursive: true });
fs.writeFileSync(path.join(root, 'profiles/fixture/etc/models.json'), JSON.stringify({ version: '1.0.0', description: 'Isolated embedding test', defaults: { embedder: 'fixture' },
  models: { fixture: { provider: 'llama-cpp', model: 'fixture-embedding', roles: ['embedder'], adapters: [], description: 'Fixture', options: {} } } }));
const { callEmbeddings } = await import('./model-router.js');
const { eventBus } = await import('./infrastructure/event-bus/client.js');
const { setAuditEnabled } = await import('./audit.js');
setAuditEnabled(false);
let handler: (url: string, body: any) => Response | Promise<Response>;
const server = createServer((request, response) => {
  void (async () => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const result = await handler(request.url!, body ? JSON.parse(body) : undefined);
    response.writeHead(result.status); response.end(await result.text());
  })().catch(error => { response.writeHead(500); response.end(String(error)); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
fs.writeFileSync(path.join(root, 'etc/llm-backend.json'), JSON.stringify({ llamaCpp: { endpoint } }));
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('embedding operation succeeds independently of the health-probe deadline', async () => {
  const requests: string[] = [];
  handler = async url => {
    requests.push(url);
    if (url.endsWith('/health')) throw new DOMException('Health probe timed out', 'TimeoutError');
    assert.ok(url.endsWith('/embeddings'));
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  };
  assert.deepEqual((await callEmbeddings({ text: 'fixture', userId: 'fixture' })).embeddings, [0.1, 0.2, 0.3]);
  assert.equal(requests.length, 1);
  handler = async () => new Response('Embedding model unavailable', { status: 503 });
  await assert.rejects(callEmbeddings({ text: 'fixture', userId: 'fixture' }), /Embedding model unavailable/);
});

test('embedding selection honors the same saved cognitive-mode role as the sidebar', async () => {
  const file = path.join(root, 'profiles/fixture/etc/models.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.models.other = { ...registry.models.fixture, model: 'other-embedding' };
  registry.cognitiveModeMappings = { environment: { embedder: 'other' } };
  fs.writeFileSync(file, JSON.stringify(registry));
  const models: string[] = [];
  handler = async (_url, body) => {
    models.push(body.model);
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  };
  assert.equal((await callEmbeddings({ text: 'fixture', userId: 'fixture', cognitiveMode: 'environment' })).model, 'other-embedding');
  assert.equal((await callEmbeddings({ text: 'fixture', userId: 'fixture' })).model, 'fixture-embedding');
  assert.deepEqual(models, ['other-embedding', 'fixture-embedding']);
});
