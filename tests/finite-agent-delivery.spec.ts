import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GraphExecutionState, SvelteFlowGraph } from '../packages/core/src/index.js'

test('finite agent generation remains separate from durable output delivery', async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-finite-agent-delivery-'))
  process.env.METAHUMAN_ROOT = fixtureRoot
  const { eventBus } = await import('../packages/core/src/infrastructure/event-bus/client.js')
  eventBus.disconnect()
  const { runGraph, createUser, nodeExecutors, UnifiedQueueManager, setAuditEnabled } = await import('../packages/core/src/index.js')
  const { withGraphWork } = await import('../packages/core/src/durable-execution/runtime.js')
  const { openExecutionStore } = await import('../packages/core/src/durable-execution/storage.js')
  const { deliverDurableWorkReceipt } = await import('../packages/core/src/durable-execution/work-results.js')
  const { evaluateDaydreamerGraph } = await import('../brain/agents/daydreamer/core.js')
  const { evaluateReflectorGraph } = await import('../brain/agents/reflector/core.js')
  const daydreamer = await import('../brain/agents/daydreamer/core.fixture.js')
  const reflector = await import('../brain/agents/reflector/core.fixture.js')
  setAuditEnabled(false)
  t.after(() => eventBus.disconnect())

  interface Scenario {
    name: string
    graph: SvelteFlowGraph
    outputs: Record<string, Record<string, unknown>>
    deliveryNodeType: string
    completedState: () => GraphExecutionState
    evaluate: (state: GraphExecutionState, identity: { username: string; executionId: string }) =>
      ReturnType<typeof evaluateDaydreamerGraph> | ReturnType<typeof evaluateReflectorGraph>
  }

  const scenarios: Scenario[] = [
    {
      name: 'daydreamer', graph: daydreamer.graph,
      outputs: Object.fromEntries(Object.entries(daydreamer.nodeIds).map(([type, id]) =>
        [id, daydreamer.successfulOutputs[type as keyof typeof daydreamer.nodeIds]])),
      deliveryNodeType: 'inner_dialogue_buffer', completedState: daydreamer.graphState,
      evaluate: state => evaluateDaydreamerGraph(daydreamer.graph, state),
    },
    {
      name: 'reflector', graph: reflector.graph, outputs: reflector.successfulOutputs,
      deliveryNodeType: 'tts', completedState: reflector.graphState,
      evaluate: (state, identity) => evaluateReflectorGraph(reflector.graph, state, identity),
    },
  ]

  for (const scenario of scenarios) {
    await t.test(`${scenario.name} retries and reopened delivery receipts retain one generation and actual speech outcomes`, async () => {
      const username = `${scenario.name}-delivery-fixture`
      createUser(username, 'isolated-fixture-password', scenario.name === 'daydreamer' ? 'owner' : 'standard')
      const manager = new UnifiedQueueManager()
      const types = [...new Set(scenario.graph.nodes.map(node => node.data.nodeType))]
      const previous = new Map(types.map(type => [type, nodeExecutors.get(type)!]))
      const calls = new Map<string, number>()
      for (const type of types) {
        nodeExecutors.set(type, async (_inputs, context, properties) => {
          calls.set(type, (calls.get(type) ?? 0) + 1)
          if (type === scenario.deliveryNodeType) {
            context.graphExecution.dispatch({ kind: 'coordinator_work', payload: {
              type: 'generic', handler: 'tts.robot-speech', resource: 'robot-speech-render', executionScope: 'invocation',
              source: 'system', username, input: { text: `Saved ${scenario.name} fixture` },
            } })
          }
          const matches = scenario.graph.nodes.filter(candidate => candidate.data.nodeType === type)
          const node = matches.length === 1 ? matches[0]
            : matches.find(candidate => candidate.data.properties?.role === properties?.role)!
          return scenario.outputs[node.id]
        })
      }
      try {
        for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
          const work = manager.enqueue({ type: 'generic', handler: `agent.${scenario.name}`, username,
            source: 'user', input: { outcome }, maxAttempts: 1 })
          assert.ok(manager.claim(work.id))
          try {
            const invoke = () => withGraphWork(work, id => manager.attachExecution(work.id, id), () => runGraph({
              graph: scenario.graph, context: { username, userId: username, cognitiveMode: 'agent' },
            }), async input => manager.enqueue(input))
            const result = await invoke()
            assert.equal(result.status, 'waiting', result.error?.message)
            assert.ok(result.endTime, 'Generation and persistence finished before asynchronous speech delivery')
            const identity = { username, executionId: work.id }
            const expected = scenario.evaluate(scenario.completedState(), identity)
            assert.deepEqual(scenario.evaluate(result, identity), expected)
            const callsAfterGeneration = new Map(calls)
            let store = openExecutionStore(username)
            let effect
            try {
              assert.equal(store.get(result.executionId!).waitingReason, 'effect_delivery')
              effect = store.dispatches(result.executionId!).find(item => item.kind === 'coordinator_work')!
              assert.ok(effect.workItemId)
            } finally { store.close() }
            assert.deepEqual(scenario.evaluate(await invoke(), identity), expected)
            assert.deepEqual(calls, callsAfterGeneration, 'Retry reuses the committed generation and persistence')
            manager.complete(work.id, true, expected)
            if (outcome === 'cancelled') manager.cancel(effect.workItemId!, 'Fixture output cancelled')
            else {
              assert.ok(manager.claim(effect.workItemId!))
              manager.complete(effect.workItemId!, outcome === 'completed', outcome === 'completed'
                ? { rendered: true } : { code: 'synthesis_failed', message: 'Fixture synthesis failed', retryable: false })
            }
            store = openExecutionStore(username)
            try {
              await deliverDurableWorkReceipt(manager.getTask(effect.workItemId!)!, manager, store)
              await deliverDurableWorkReceipt(manager.getTask(effect.workItemId!)!, manager, store)
            } finally { store.close() }
            store = openExecutionStore(username)
            try {
              assert.equal(store.get(result.executionId!).status, 'completed')
              const receipts = store.events(result.executionId!).filter(event => event.kind === 'work_result')
              assert.equal(receipts.length, 1, 'Repeated receipt delivery is idempotent')
              assert.equal((receipts[0].payload as any).result.state, outcome, 'Speech retains its actual delivery outcome')
            } finally { store.close() }
            const restored = await runGraph({ graph: scenario.graph, executionId: result.executionId,
              context: { username, userId: username, cognitiveMode: 'agent' } })
            assert.equal(restored.endTime, undefined, 'Completed replay need not reconstruct a pass end time')
            assert.deepEqual(scenario.evaluate(restored, identity), expected)
            assert.deepEqual(calls, callsAfterGeneration, 'Settling speech never generates or saves another output')
          } finally { manager.cancel(work.id, 'Fixture cleanup') }
        }
      } finally {
        for (const [type, executor] of previous) nodeExecutors.set(type, executor)
      }
    })
  }
})
