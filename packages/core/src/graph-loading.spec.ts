import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-graph-loading-'))
process.env.METAHUMAN_ROOT = fixture
globalThis.fetch = async () => { throw new Error('No network in graph loading tests') }
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { loadGraphForMode } = await import('./graph-streaming.js')
const { loadGraphFile } = await import('./graph-runtime.js')
const { UnifiedQueueManager } = await import('./queue/unified-queue-manager.js')
const { ExecutionEngine } = await import('./queue/execution-engine.js')
after(() => { eventBus.disconnect(); fs.rmSync(fixture, { recursive: true, force: true }) })

const directory = path.join(fixture, 'etc/cognitive-graphs')
fs.mkdirSync(path.join(directory, 'custom'), { recursive: true })
const graph = JSON.parse(fs.readFileSync(new URL('../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url), 'utf8'))

test('invalid configured graphs retain the validation error through both real loaders', async () => {
  const invalid = structuredClone(graph)
  invalid.edges[0].data = { ...invalid.edges[0].data, when: { output: 'output_not_in_contract', equals: true } }
  const filename = path.join(directory, 'invalid-mode.json')
  fs.writeFileSync(filename, JSON.stringify(invalid))
  for (const load of [() => loadGraphForMode('invalid'), () => loadGraphFile(filename)]) {
    await assert.rejects(load, /undeclared output.*output_not_in_contract/)
  }
})

test('invalid custom graph does not silently execute the bundled default', async () => {
  fs.writeFileSync(path.join(directory, 'custom-mode.json'), JSON.stringify(graph))
  const custom = path.join(directory, 'custom/custom-mode.json')
  fs.writeFileSync(custom, '{invalid json')
  await assert.rejects(() => loadGraphForMode('custom'), /JSON|property name/)
  fs.writeFileSync(custom, JSON.stringify(graph))
  assert.equal((await loadGraphForMode('custom'))?.source, custom)
  await assert.rejects(() => loadGraphForMode('absent'), /Workflow not found: absent/)
  assert.equal(await loadGraphFile(path.join(directory, 'absent-mode.json')), null)
})

test('Coordinator retains wrapped configuration failure without retrying the same job', async () => {
  const filename = path.join(directory, 'controller-mode.json')
  fs.writeFileSync(filename, '{invalid json')
  const manager = new UnifiedQueueManager()
  const engine = new ExecutionEngine({}, manager)
  let calls = 0
  engine.registerHandler('workflow.robot-autonomy-controller', async () => {
    calls++
    try { return await loadGraphForMode('controller') }
    catch (cause) { throw new Error('Controller failed', { cause }) }
  })
  const task = manager.enqueue({ type: 'generic', handler: 'workflow.robot-autonomy-controller',
    username: 'fixture-owner', source: 'autonomy', resource: 'io', input: {}, maxAttempts: 3 })
  engine.start()
  try {
    const deadline = Date.now() + 5_000
    while (manager.getTask(task.id)?.state !== 'failed') {
      assert.ok(Date.now() < deadline, 'Configuration failure must reach a terminal receipt')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { await engine.stop() }
  assert.equal(calls, 1, 'An unchanged definition cannot become valid through retries')
  const failed = manager.getTask(task.id)!
  assert.equal(failed.error?.code, 'workflow_configuration_invalid')
  assert.equal(failed.error?.retryable, false)
  assert.match(failed.error?.message ?? '', /Controller failed/)
  const restored = new UnifiedQueueManager()
  restored.importState(JSON.parse(JSON.stringify(manager.exportState())))
  assert.deepEqual(restored.getHistory()[0].error, failed.error)
  fs.writeFileSync(filename, JSON.stringify(graph))
  assert.ok(await loadGraphForMode('controller'))
})

test('corrected definitions reload even when a deployment preserves the old mtime', async () => {
  const filename = path.join(directory, 'timestamps-mode.json')
  fs.writeFileSync(filename, '{invalid json')
  const before = fs.statSync(filename)
  await assert.rejects(() => loadGraphForMode('timestamps'))
  fs.writeFileSync(filename, JSON.stringify(graph))
  fs.utimesSync(filename, before.atime, before.mtime)
  assert.ok(await loadGraphForMode('timestamps'))
})

function responseFixture(mode: 'dual' | 'agent' | 'emulation') {
  const graph = JSON.parse(fs.readFileSync(new URL(`../../../etc/cognitive-graphs/${mode}-mode.json`, import.meta.url), 'utf8'));
  const state: import('./graph-executor.js').GraphExecutionState = {
    status: 'completed', startTime: 1,
    nodes: new Map(graph.nodes.map((node: { id: string; data: { nodeType: string } }) => [node.id, {
      nodeId: node.id, status: 'completed', definition: { type: node.data.nodeType }, inputs: { response: '<think>Raw reasoning</think>Reply' },
      outputs: { response: 'Reply', output: '<think>Raw reasoning</think>Reply', stripped: 'Reply', content: 'Reply',
        persisted: true, entries: [{ role: 'assistant', content: 'Reply', meta: { idempotencyKey: `saved-${node.id}` } }] },
    }])),
  };
  const writer = graph.nodes.find((node: { data: { nodeType: string } }) => node.data.nodeType === 'stream_writer');
  const output = state.nodes.get(writer.id)!.outputs!;
  const buffer = graph.nodes.find((node: { id: string; data: { nodeType: string } }) => node.data.nodeType === 'conversation_buffer'
    && graph.edges.some((edge: { target: string; targetHandle: string }) => edge.target === node.id && edge.targetHandle === 'response'));
  return { graph, state, writer, output, buffer };
}

for (const mode of ['dual', 'agent', 'emulation'] as const) {
  test(`${mode} graph associates raw response presentation with its actual saved entry through output wiring`, async () => {
    const { findResponseEntryReference } = await import('./graph-runtime.js');
    const fixture = responseFixture(mode);
    assert.deepEqual(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'),
      { mode: 'conversation', id: `saved-${fixture.buffer.id}` });
    assert.equal(fixture.output.output, '<think>Raw reasoning</think>Reply', 'identity discovery cannot strip the presented response');
  });
}

test('custom response with no Buffer or unrelated equal-text publication has no asserted saved identity', async () => {
  const { findResponseEntryReference } = await import('./graph-runtime.js');
  const fixture = responseFixture('dual');
  fixture.graph.edges = fixture.graph.edges.filter((edge: { target: string }) => edge.target !== fixture.buffer.id);
  assert.equal(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'), undefined);
  fixture.graph.nodes.push({ id: 'unrelated', data: { nodeType: 'fixture' } });
  fixture.state.nodes.set('unrelated', { nodeId: 'unrelated', status: 'completed', definition: { type: 'fixture' }, outputs: { response: 'Reply' } });
  fixture.graph.edges.push({ id: 'unrelated-buffer', source: 'unrelated', sourceHandle: 'response', target: fixture.buffer.id, targetHandle: 'response' });
  assert.equal(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'), undefined,
    'equal text from another output cannot prove the response identity');
});

test('ambiguous custom publications retain distinct identities instead of choosing the first entry', async () => {
  const { findResponseEntryReference } = await import('./graph-runtime.js');
  const fixture = responseFixture('dual');
  fixture.graph.nodes.push({ ...fixture.buffer, id: 'second-buffer' });
  fixture.state.nodes.set('second-buffer', { ...fixture.state.nodes.get(fixture.buffer.id)!, nodeId: 'second-buffer',
    outputs: { ...fixture.state.nodes.get(fixture.buffer.id)!.outputs, entries: [
      { role: 'assistant', content: 'Reply', meta: { idempotencyKey: 'distinct-equal-text-entry' } },
    ] } });
  const edge = fixture.graph.edges.find((edge: { target: string; targetHandle: string }) => edge.target === fixture.buffer.id && edge.targetHandle === 'response');
  fixture.graph.edges.push({ ...edge, id: 'second-response', target: 'second-buffer' });
  assert.equal(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'), undefined);
});

test('inactive or ambiguous response inputs cannot associate a custom output with a saved entry', async () => {
  const { findResponseEntryReference } = await import('./graph-runtime.js');
  const fixture = responseFixture('agent');
  fixture.state.nodes.get(fixture.writer.id)!.inputs = {};
  assert.equal(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'), undefined);
  fixture.state.nodes.get(fixture.writer.id)!.inputs = { response: 'Reply' };
  const edge = fixture.graph.edges.find((edge: { target: string; targetHandle: string }) => edge.target === fixture.writer.id && edge.targetHandle === 'response');
  fixture.graph.edges.push({ ...edge, id: 'ambiguous-input' });
  assert.equal(findResponseEntryReference(fixture.graph, fixture.state, fixture.output, 'output'), undefined);
});
