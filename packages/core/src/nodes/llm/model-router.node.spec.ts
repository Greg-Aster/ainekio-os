import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-model-router-node-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => { throw new Error('No model services in Model Router node tests'); };
const { eventBus } = await import('../../infrastructure/event-bus/client.js');
eventBus.disconnect();
const router = await import('../../model-router.js');
const calls: Parameters<typeof router.callLLM>[0][] = [];
mock.module(new URL('../../model-router.ts', import.meta.url).href, { namedExports: { ...router,
  callLLM: async (request: Parameters<typeof router.callLLM>[0]) => {
    calls.push(request);
    return { content: '{"ok":true}' };
  },
} });
const { ModelRouterNode } = await import('./model-router.node.js');
const { getNodeSchema } = await import('../schemas.js');
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('Model Router exposes the same optional reasoning input in runtime and browser schemas', () => {
  const expected = { name: 'enableThinking', type: 'boolean', optional: true,
    description: 'Optional reasoning override; a connection takes precedence over Reasoning.' };
  assert.deepEqual(ModelRouterNode.inputs.find(input => input.name === 'enableThinking'), expected);
  assert.deepEqual(getNodeSchema('model_router')?.inputs.find(input => input.name === 'enableThinking'), expected);
});

for (const { name, input, property, expected } of [
  { name: 'connected true enables reasoning over an unchecked property', input: true, property: false, expected: true },
  { name: 'connected false disables reasoning over a checked property', input: false, property: true, expected: false },
  { name: 'unconnected input retains a checked property', input: undefined, property: true, expected: true },
  { name: 'unconnected input retains an unchecked property', input: undefined, property: false, expected: false },
]) test(name, async () => {
  const messages = [{ role: 'system', content: 'Recorded graph instruction.' }, { role: 'user', content: 'Recorded evidence.' }];
  const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const controller = new AbortController();
  const emitProgress = () => {};
  const before = calls.length;
  const result = await ModelRouterNode.execute({ messages, role: 'autonomy', jsonSchema,
    ...(input === undefined ? {} : { enableThinking: input }) },
  { username: 'fixture', cognitiveMode: 'environment', abortSignal: controller.signal, emitProgress },
  { role: 'persona', enableThinking: property, format: 'json', maxTokens: -1, temperature: 0.7, repeatPenalty: 1.1 });
  assert.equal(calls.length, before + 1, 'A connected setting changes one inference, without a second call');
  assert.deepEqual(calls.at(-1), { role: 'autonomy', messages, userId: 'fixture', cognitiveMode: 'environment',
    options: { enableThinking: expected, maxTokens: -1, repeatPenalty: 1.1, temperature: 0.7, format: 'json', jsonSchema },
    onProgress: emitProgress, signal: controller.signal });
  assert.deepEqual(result, { response: '{"ok":true}' });
});
