import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { ExecutionStore } from './store.js'
import { ExecutionCheckpointer } from './checkpointer.js'
import { executionWorkInput } from './coordinator-outbox.js'

const definition = { graphId: 'scheduling-fixture', graphHash: 'v1', runtimeVersion: 'v1', checkpointSchemaVersion: 1, nodeVersions: {} }

test('question context becomes idle, survives restart and resumes once on actual input', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-idle-context-'))
  const filename = path.join(directory, 'execution.sqlite')
  let store = new ExecutionStore(filename)
  try {
    const record = store.enter('fixture', definition, 'original-turn', { context: { userMessage: 'fixture question' } }, 'critical')
    const lease = store.claim(record.executionId, definition)
    const checkpoint = new ExecutionCheckpointer(store, lease)
    await checkpoint.put({ configurable: { thread_id: record.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_values: {
        executionTransition: { transitionId: randomUUID(), status: 'waiting' },
      }, channel_versions: {}, versions_seen: {},
    }, { source: 'loop', step: 0, parents: {} })
    store.settle(lease, 'waiting', 'user_or_autonomy')
    store.release(lease)
    assert.equal(store.get(record.executionId).status, 'idle')
    assert.deepEqual(store.summaries('fixture', 0), [], 'No unfinished processing remains')
    assert.equal(store.active('fixture')[0].executionId, record.executionId, 'Context remains available to the next decision')
    assert.deepEqual(store.recoveryExecutions([]), [], 'An unanswered question needs no worker recovery')
    store.close()
    store = new ExecutionStore(filename)
    assert.equal(store.get(record.executionId).status, 'idle')
    const input = { eventId: 'reply', kind: 'user_steering', payload: { userMessage: 'fixture answer' } }
    store.deliverEvent(record.executionId, input)
    store.deliverEvent(record.executionId, input)
    assert.equal(store.get(record.executionId).status, 'running')
    const wakes = store.pendingDispatches(record.executionId)
    assert.equal(wakes.length, 1)
    assert.equal(executionWorkInput(store, wakes[0]).priority, 'critical')
    assert.equal(store.recoveryExecutions([])[0].executionId, record.executionId)
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('conversation and speech inherit admitted priority; explicit choices remain intact', async () => {
  const store = new ExecutionStore(':memory:')
  try {
    const record = store.enter('fixture', definition, 'turn', {}, 'critical')
    const lease = store.claim(record.executionId, definition)
    const saver = new ExecutionCheckpointer(store, lease)
    await saver.put({ configurable: { thread_id: record.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_values: {
        executionTransition: { transitionId: randomUUID(), dispatches: [
          { effectId: 'conversation', kind: 'coordinator_work', payload: { type: 'generic', handler: 'environment.conversation', input: {} } },
          { effectId: 'speech', kind: 'coordinator_work', payload: { type: 'generic', handler: 'tts.robot-speech', input: {} } },
          { effectId: 'explicit', kind: 'coordinator_work', payload: { type: 'generic', handler: 'fixture.work', priority: 'low', input: {} } },
        ] },
      }, channel_versions: {}, versions_seen: {},
    }, { source: 'loop', step: 0, parents: {} })
    for (const id of ['conversation', 'speech', 'explicit']) {
      const work = executionWorkInput(store, store.dispatch(id))
      assert.equal(work.priority, id === 'explicit' ? 'low' : 'critical')
    }
    store.release(lease)
  } finally { store.close() }
})

test('upgrading old question waits retains evidence and does not retire outstanding effects', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-question-upgrade-'))
  const filename = path.join(directory, 'execution.sqlite')
  let store = new ExecutionStore(filename)
  try {
    const idle = store.enter('fixture', definition, 'question', { context: { userMessage: 'retained question' } })
    const delivering = store.enter('fixture', definition, 'delivery', { context: {} })
    for (const record of [idle, delivering]) {
      store.db.prepare("UPDATE executions SET status='waiting' WHERE execution_id=?").run(record.executionId)
      store.db.prepare('INSERT INTO execution_waits VALUES (?, ?)').run(record.executionId, 'user_or_autonomy')
    }
    store.db.transaction(() => store.commitTransition(delivering.executionId, 'pending', {
      transitionId: 'pending', dispatches: [{ effectId: 'speech', kind: 'coordinator_work',
        payload: { type: 'generic', handler: 'tts.robot-speech', input: {} } }],
    }))()
    store.db.exec('ALTER TABLE executions DROP COLUMN priority; PRAGMA user_version=0')
    store.close()
    store = new ExecutionStore(filename)
    assert.equal(store.get(idle.executionId).status, 'idle')
    assert.equal(store.entry(idle.executionId).context.userMessage, 'retained question')
    assert.equal(store.get(delivering.executionId).status, 'waiting')
    assert.equal(store.dispatch('speech').status, 'pending')
    assert.deepEqual(store.summaries('fixture', 0).map(record => record.executionId), [delivering.executionId])
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})


test('durable graph cleanup detaches queue ownership and closes storage after release failures', async () => {
  const { registerProfileStorageConfigGetter } = await import('../path-builder.js')
  const { DEFAULT_GRAPH_SCHEDULER } = await import('../cognitive-graph-schema.js')
  const { withGraphWork, runDurableGraph } = await import('./runtime.js')
  const { UnifiedQueueManager } = await import('../queue/unified-queue-manager.js')
  const { eventBus } = await import('../infrastructure/event-bus/client.js')
  const { setAuditEnabled } = await import('../audit.js')
  eventBus.disconnect(); setAuditEnabled(false)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-finalize-'))
  registerProfileStorageConfigGetter(username => {
    const profilePath = path.join(directory, username)
    fs.mkdirSync(profilePath, { recursive: true })
    return { path: profilePath, type: 'internal' }
  })
  const release = ExecutionStore.prototype.release
  const close = ExecutionStore.prototype.close
  try {
    for (const failure of ['none', 'lease', 'attachment']) {
      const manager = new UnifiedQueueManager()
      const task = manager.enqueue({ type: 'generic', handler: 'fixture.graph', username: 'fixture', input: {} })
      assert.ok(manager.claim(task.id))
      const stores = new Set<ExecutionStore>()
      let closed = 0
      const releasing = mock.method(ExecutionStore.prototype, 'release', function (this: ExecutionStore, lease: Parameters<ExecutionStore['release']>[0]) {
        stores.add(this)
        if (failure === 'lease') throw new Error('Fixture lease release failed')
        return release.call(this, lease)
      })
      const closing = mock.method(ExecutionStore.prototype, 'close', function (this: ExecutionStore) {
        closed++
        return close.call(this)
      })
      try {
        const result = withGraphWork(task, id => {
          const detach = manager.attachExecution(task.id, id)
          return () => {
            detach()
            if (failure === 'attachment') throw new Error('Fixture attachment release failed')
          }
        }, () => runDurableGraph({ graph: { version: '1.0', format: 'svelte-flow', name: `Cleanup ${failure}`,
          scheduler: DEFAULT_GRAPH_SCHEDULER, nodes: [{ id: 'input', type: 'default', position: { x: 0, y: 0 },
            data: { nodeType: 'user_input', label: 'Input', properties: {} } }], edges: [] },
          context: { username: 'fixture', userMessage: 'Isolated input' } }))
        if (failure === 'none') assert.equal((await result).status, 'completed')
        else await assert.rejects(result, new RegExp(`Fixture ${failure === 'lease' ? 'lease' : 'attachment'} release failed`))
        assert.equal(manager.getTask(task.id)?.activeGraphExecutionId, undefined,
          'A failed storage release cannot retain the queue graph writer')
        assert.equal(closed, 1, 'The runtime always closes its owned storage connection')
      } finally {
        releasing.mock.restore(); closing.mock.restore()
        for (const store of stores) if (store.db.open) close.call(store)
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
