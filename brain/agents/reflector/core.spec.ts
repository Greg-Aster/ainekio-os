import assert from 'node:assert/strict'
import test from 'node:test'
import { setAuditEnabled } from '@metahuman/core'
import { evaluateReflectorGraph, parseReflectorArgs, runReflector, type ReflectorDependencies } from './core.js'
import agent, { meta } from './index.js'
import { graph, graphState, nodeIds } from './core.fixture.js'

setAuditEnabled(false)
const NOW = '2026-08-29T18:00:00.000Z'

function dependencies(
  overrides: Partial<ReflectorDependencies> = {},
): ReflectorDependencies {
  return {
    resolveTargetUser: () => ({
      userId: 'real-profile-uuid',
      username: 'test-user',
      role: 'owner',
    }),
    loadGraph: async () => graph,
    executeGraph: async () => graphState(),
    runWithUserContext: async (_context, callback) => callback(),
    newExecutionId: () => 'generated-execution',
    now: () => NOW,
    ...overrides,
  }
}

test('Reflector evaluates editable node types and requires durable memory persistence', () => {
  assert.deepEqual(
    evaluateReflectorGraph(graph, graphState(), { username: 'test-user', executionId: 'task-1' }),
    {
      status: 'generated',
      username: 'test-user',
      executionId: 'task-1',
      reflection: 'A new reflection.',
      eventId: 'evt-reflection',
      eventPath: 'memory/episodic/reflection.json',
      memoriesConsidered: 4,
      candidatesConsidered: 20,
      scanFailures: 1,
      ttsQueued: true,
    },
  )

  assert.throws(
    () => evaluateReflectorGraph(graph, graphState({
      [nodeIds.reflection_memory]: { saved: false },
    }), { username: 'test-user', executionId: 'task-1' }),
    /did not confirm long-term memory capture/,
  )
  assert.throws(
    () => evaluateReflectorGraph(graph, graphState({
      [nodeIds.reflection_memory_sampler]: { error: 'encrypted profile is locked' },
    }), { username: 'test-user', executionId: 'task-1' }),
    /encrypted profile is locked/,
  )
})

test('Reflector returns typed skips only for expected no-work conditions', () => {
  const insufficient = evaluateReflectorGraph(graph, graphState({
    [nodeIds.reflection_memory_sampler]: {
      ready: false,
      count: 1,
      candidateCount: 1,
      failedCount: 0,
    },
  }), { username: 'test-user', executionId: 'task-1' })
  assert.equal(insufficient.status, 'skipped')
  if (insufficient.status === 'skipped') assert.equal(insufficient.reason, 'insufficient-memories')

  const noPersona = evaluateReflectorGraph(graph, graphState({
    [nodeIds.reflection_prompt]: {
      ready: false,
      personaApplied: false,
      error: 'No persona context available',
    },
  }), { username: 'test-user', executionId: 'task-1' })
  assert.equal(noPersona.status, 'skipped')
  if (noPersona.status === 'skipped') assert.equal(noPersona.reason, 'persona-unavailable')
})

test('Reflector propagates graph, model, and persistence failures', () => {
  const failed = graphState({}, 'failed')
  failed.nodes.set(nodeIds.reflector_llm, {
    nodeId: nodeIds.reflector_llm,
    status: 'failed',
    error: new Error('model unavailable'),
  })
  assert.throws(
    () => evaluateReflectorGraph(graph, failed, { username: 'test-user', executionId: 'task-1' }),
    /model unavailable/,
  )
  assert.throws(
    () => evaluateReflectorGraph(graph, graphState({
      [nodeIds.reflector_llm]: { error: 'generation rejected' },
    }), { username: 'test-user', executionId: 'task-1' }),
    /generation rejected/,
  )
  assert.throws(
    () => evaluateReflectorGraph(graph, graphState({
      [nodeIds.reflection_buffer]: { saved: false, persisted: false, error: 'disk full' },
    }), { username: 'test-user', executionId: 'task-1' }),
    /disk full/,
  )
})

test('Reflector reports saved generation independently of outstanding speech delivery', () => {
  const waiting = graphState({}, 'waiting')
  const identity = { username: 'test-user', executionId: 'task-1' }
  assert.deepEqual(evaluateReflectorGraph(graph, waiting, identity),
    evaluateReflectorGraph(graph, graphState(), identity))
  assert.equal(waiting.status, 'waiting', 'Evaluation cannot settle an outstanding delivery')
  assert.throws(() => evaluateReflectorGraph(graph, graphState({
    [nodeIds.reflection_buffer]: { saved: false, persisted: false, error: 'disk full' },
  }, 'waiting'), identity), /disk full/)
  assert.throws(() => evaluateReflectorGraph(graph, graphState({
    [nodeIds.reflection_memory]: { saved: false },
  }, 'waiting'), identity), /did not confirm long-term memory capture/)
})

test('Reflector never reports interrupted or unfinished generation as saved output', () => {
  const identity = { username: 'test-user', executionId: 'task-1' }
  for (const status of ['pending', 'running', 'failed'] as const) {
    assert.throws(() => evaluateReflectorGraph(graph, graphState({}, status), identity), /did not complete/)
  }
  const cancelled = graphState({}, 'failed')
  cancelled.nodes.set(nodeIds.reflector_llm, {
    nodeId: nodeIds.reflector_llm, status: 'failed',
    error: new DOMException('Graph execution cancelled', 'AbortError'),
  })
  assert.throws(() => evaluateReflectorGraph(graph, cancelled, identity), /Graph execution cancelled/)
  const unfinished = graphState({}, 'waiting')
  delete unfinished.endTime
  assert.throws(() => evaluateReflectorGraph(graph, unfinished, identity), /did not complete/)
  const suspended = graphState({}, 'waiting')
  suspended.pending = [{ value: { reason: 'awaiting input' } }]
  assert.throws(() => evaluateReflectorGraph(graph, suspended, identity), /did not complete/)
  const pendingModel = graphState({}, 'waiting')
  pendingModel.nodes.get(nodeIds.reflector_llm)!.status = 'running'
  assert.throws(() => evaluateReflectorGraph(graph, pendingModel, identity), /reflector_llm ended with status running/)
})

test('Reflector resolves real identity and forwards stable retry and cancellation context', async () => {
  let requestedUsername: string | undefined
  let authenticatedContext: Record<string, unknown> | undefined
  let executionContext: Record<string, unknown> | undefined
  let executionSignal: AbortSignal | undefined
  const controller = new AbortController()
  const outcome = await runReflector({
    username: 'test-user',
    executionId: 'task-stable',
    executionTimestamp: NOW,
    signal: controller.signal,
  }, dependencies({
    resolveTargetUser: options => {
      requestedUsername = options?.username
      return { userId: 'real-profile-uuid', username: 'test-user', role: 'owner' }
    },
    runWithUserContext: async (context, callback) => {
      authenticatedContext = context
      return callback()
    },
    executeGraph: async params => {
      executionContext = params.context
      executionSignal = params.signal
      return graphState()
    },
  }))

  assert.equal(outcome.status, 'generated')
  assert.equal(requestedUsername, 'test-user')
  assert.equal(authenticatedContext?.userId, 'real-profile-uuid')
  assert.equal(executionContext?.userId, 'real-profile-uuid')
  assert.equal(executionContext?.username, 'test-user')
  assert.equal(executionContext?.idempotencyKey, 'reflector:test-user:task-stable')
  assert.equal(executionContext?.memoryTimestamp, NOW)
  assert.equal(executionContext?.abortSignal, controller.signal)
  assert.equal(executionSignal, controller.signal)

  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    runReflector({ signal: cancelled.signal }, dependencies()),
    /cancelled/,
  )
  await assert.rejects(
    runReflector({}, dependencies({ resolveTargetUser: () => null })),
    /No authenticated target user/,
  )
})

test('Reflector exposes one strict adapter contract', () => {
  assert.equal(agent.meta, meta)
  assert.equal(meta.id, 'reflector')
  assert.equal(meta.defaultInterval, undefined)
  assert.deepEqual(parseReflectorArgs([], {
    MH_TRIGGER_USERNAME: 'test-user',
    MH_TASK_ID: 'task-1',
    MH_TASK_CREATED_AT: NOW,
  }), {
    username: 'test-user',
    executionId: 'task-1',
    executionTimestamp: NOW,
  })
  assert.deepEqual(parseReflectorArgs(['--username', 'another-user'], {}), {
    username: 'another-user',
    executionId: undefined,
    executionTimestamp: undefined,
  })
  assert.throws(() => parseReflectorArgs(['--single-user'], {}), /Unknown reflector option/)
})
