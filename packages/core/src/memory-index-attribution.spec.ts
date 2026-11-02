import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, mock } from 'node:test'
import Database from 'better-sqlite3'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-attribution-'))
process.env.METAHUMAN_ROOT = root
fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
fs.mkdirSync(path.join(root, 'profile'), { recursive: true })
const username = 'memory-attribution'
const submissions: any[] = []
const router = await import('./model-router.js')
mock.module('./model-router.js', { namedExports: { ...router,
  callEmbeddings: async () => ({ model: 'fixture', provider: 'fixture', dimensions: 2, embeddings: [1, 0] }),
  isEmbeddingServiceAvailable: async () => true,
} })
const users = await import('./users.js')
mock.module('./users.js', { namedExports: { ...users,
  getUserByUsername: () => ({ id: username, username, role: 'owner' }),
} })
const submission = await import('./queue/work-submission.js')
mock.module('./queue/work-submission.js', { namedExports: { ...submission,
  submitCoordinatorWork: async (input: any) => { submissions.push(input); return { id: 'fixture' } },
} })
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('./audit.js')
setAuditEnabled(false)
const { registerProfileStorageConfigGetter } = await import('./path-builder.js')
registerProfileStorageConfigGetter(name => name === username ? { path: path.join(root, 'profile'), type: 'internal' } : undefined)
const { withUserContext } = await import('./context.js')
const { captureEventWithDetails } = await import('./memory.js')
const { ExecutionEngine } = await import('./queue/execution-engine.js')
const vector = await import('./vector-index.js')
const { MemoryRouterNode } = await import('./nodes/memory/memory-router.node.js')
const { environmentContextBuilderNode } = await import('./nodes/environment/context-builder.node.js')
const { SLEEP_RUNTIME_FILE } = await import('./sleep-runtime.js')
const engine = new ExecutionEngine({}, { addEventListener() {} } as never)
const append = (engine as any).handlers.get('vector.append-event')
after(() => { eventBus.disconnect(); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) })

test('tool capture retains complete results without writing an unconsumed tool cache', async () => {
  const mkdir = mock.method(fs.promises, 'mkdir')
  const captured: string[] = []
  const submissionCount = submissions.length
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const toolOutputs = { text: `Complete tool result ${attempt}: ${'evidence '.repeat(600)}` }
      const result = await withUserContext({ userId: username, username, role: 'owner' }, () =>
        captureEventWithDetails(`Tool result for cache retirement ${attempt}`, {
          type: 'tool_invocation',
          metadata: { cognitiveMode: 'dual', conversationId: 'cache-retirement', toolName: 'fixture', success: true, toolOutputs },
        }))
      captured.push(result.filePath)
      const saved = JSON.parse(fs.readFileSync(result.filePath, 'utf8'))
      assert.deepEqual(saved.metadata.toolOutputs, toolOutputs)
      assert.equal(saved.metadata.conversationId, 'cache-retirement')
    }
    assert.deepEqual(mkdir.mock.calls.filter(call =>
      /(?:recent-tools|tool-output)$/.test(String(call.arguments[0]))).map(call => call.arguments[0]), [],
    'Capturing canonical memories must not also write caches with no reader')
    assert.equal(fs.existsSync(path.join(root, 'profile/state/recent-tools')), false)
    assert.equal(fs.existsSync(path.join(root, 'profile/logs/tool-output')), false)
  } finally {
    mkdir.mock.restore()
    submissions.splice(submissionCount)
    for (const file of captured) fs.rmSync(file, { force: true })
  }
})

test('index migration preserves evidence and append commits only the new item without serializing prior vectors', async () => {
  fs.writeFileSync(path.join(root, 'etc/embeddings.json'), JSON.stringify({ indexContentMode: 'all' }))
  const model = 'incremental-fixture'
  const dest = vector.indexFilePath(model, username)
  const original = { meta: { model: 'fixture', provider: 'fixture', dimensions: 2, items: 3000, createdAt: '2026-10-01T00:00:00Z' },
    data: Array.from({ length: 3000 }, (_, i) => ({ id: `old-${i}`, path: '', type: 'episodic' as const,
      text: `evidence ${i}`, timestamp: '2026-10-01T00:00:00Z', vector: [1, 0] })) }
  const legacy = dest.replace(/\.sqlite$/, '.json')
  fs.writeFileSync(legacy, JSON.stringify(original))
  assert.deepEqual(vector.loadIndex(model, username), original)
  assert.equal(fs.existsSync(legacy), false, 'Committed migration removes the superseded file')
  const cached = vector.loadIndex(model, username)!
  Object.defineProperty(cached.data[0], 'vector', { get() { throw new Error('Historical vectors must not be serialized on append') } })
  const db = new Database(dest)
  try {
    db.exec(`CREATE TABLE changes (kind TEXT);
      CREATE TRIGGER item_insert AFTER INSERT ON index_items BEGIN INSERT INTO changes VALUES ('insert'); END;
      CREATE TRIGGER item_update AFTER UPDATE ON index_items BEGIN INSERT INTO changes VALUES ('update'); END;
      CREATE TRIGGER item_delete AFTER DELETE ON index_items BEGIN INSERT INTO changes VALUES ('delete'); END;`)
    const event = { id: 'new-memory', timestamp: '2026-10-25T00:00:00Z', content: 'New evidence', metadata: { role: 'user', source: 'conversation' } }
    await Promise.all([vector.appendEventToIndex(event, { model, username }), vector.appendEventToIndex(event, { model, username })])
    assert.deepEqual(db.prepare('SELECT kind FROM changes').all(), [{ kind: 'insert' }])
    assert.equal(vector.loadIndex(model, username)!.data.length, 3001)
    vector.clearIndexCache()
    const reloaded = vector.loadIndex(model, username)!
    assert.deepEqual(reloaded.data.slice(0, 3000), original.data)
    assert.equal(reloaded.data.at(-1)!.role, 'user')
    db.exec("CREATE TRIGGER fail_append BEFORE UPDATE ON index_meta BEGIN SELECT RAISE(ABORT, 'fixture commit rejected'); END;")
    await assert.rejects(vector.appendEventToIndex({ ...event, id: 'rejected' }, { model, username }), /fixture commit rejected/)
    assert.equal(vector.loadIndex(model, username)!.data.some(item => item.id === 'rejected'), false)
    assert.equal(db.prepare("SELECT id FROM index_items WHERE id='rejected'").get(), undefined)
    db.exec('DROP TRIGGER fail_append')
    assert.equal(await vector.appendEventToIndex({ ...event, id: 'rejected' }, { model, username }), true)
  } finally { db.close() }
})

test('capture, queued append, rebuild and retrieval preserve attribution and content policy', async () => {
  const records = [
    { content: 'User fixture statement', type: 'conversation', metadata: { role: 'user', source: 'conversation', cognitiveMode: 'dual' as const } },
    { content: 'Assistant fixture statement', type: 'conversation', metadata: { role: 'assistant', source: 'autonomy', sleepSessionId: 'fixture-cycle', cognitiveMode: 'dual' as const } },
    { content: 'Unattributed fixture observation', type: 'observation', metadata: { cognitiveMode: 'dual' as const } },
  ]
  for (const [index, record] of records.entries()) {
    await withUserContext({ userId: username, username, role: 'owner' }, () => captureEventWithDetails(record.content, {
      ...record, type: record.type as any, timestamp: '2026-10-14T00:00:00.000Z', idempotencyKey: `fixture-${index}`,
    }))
  }
  assert.equal(submissions.length, 3)
  for (const [index, work] of submissions.entries()) {
    assert.equal(work.input.metadata?.role, records[index].metadata.role, 'capture must retain speaker in index work')
    assert.equal(work.input.metadata?.source, records[index].metadata.source, 'capture must retain source in index work')
  }
  for (const mode of ['user', 'all']) {
    fs.writeFileSync(path.join(root, 'etc/embeddings.json'), JSON.stringify({ indexContentMode: mode }))
    const indexPath = vector.indexFilePath(undefined, username)
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    vector.saveIndex({ meta: { model: 'fixture', provider: 'fixture', dimensions: 2, items: 0, createdAt: new Date().toISOString() }, data: [] }, undefined, username)
    for (const work of submissions) await append({ ...work, username })
    const incremental = vector.loadIndex(undefined, username)!.data.map(({ id, role, source, sleepSessionId }) => ({ id, role, source, sleepSessionId }))
    assert.equal(incremental.length, mode === 'user' ? 2 : 3)
    await vector.refreshMemoryIndex({ username, force: true })
    const rebuilt = vector.loadIndex(undefined, username)!.data.map(({ id, role, source, sleepSessionId }) => ({ id, role, source, sleepSessionId }))
    assert.deepEqual(rebuilt.sort((a, b) => a.id.localeCompare(b.id)), incremental.sort((a, b) => a.id.localeCompare(b.id)))
    const recalled = await MemoryRouterNode.execute({ userMessage: 'fixture', orchestratorHints: { needsMemory: true } }, { username }, { topK: 10 })
    assert.equal(recalled.memories.length, rebuilt.length)
    for (const purpose of ['task', 'conversation']) {
      const built = await environmentContextBuilderNode.execute({ userInstruction: 'Recall fixture',
        memories: recalled.memories, selectedTask: { program: null, taskDecision: null },
        routingAnalysis: { needsAction: true, needsResponse: true, taskContext: ['memory'], conversationContext: ['memory'] },
      }, {}, { purpose })
      const delivered = JSON.parse(built.message).memories
      assert.equal(delivered.length, recalled.memories.length)
      for (const item of delivered) {
        const recalledItem = recalled.memories.find((memory: any) => memory.id === item.id)
        assert.equal(item.role, recalledItem.role)
        assert.equal(item.source, recalledItem.source)
      }
    }
    for (const item of recalled.memories) {
      const original = submissions.find(work => work.input.id === item.id)!.input
      assert.equal(item.role, original.metadata.role)
      assert.equal(item.source, original.metadata.source)
      assert.equal(item.sleepSessionId, original.metadata.sleepSessionId)
      if (original.metadata.role === undefined) assert.equal(Object.hasOwn(item, 'role'), false)
      if (original.metadata.source === undefined) assert.equal(Object.hasOwn(item, 'source'), false)
    }
  }
})

test('selected memory candidates retain their scores for model relevance decisions', async () => {
  const records = [
    { id: 'candidate-a', text: 'Avery builds bicycle frames.', vector: [0.2, Math.sqrt(.96)] },
    { id: 'candidate-b', text: 'Avery paints landscapes.', vector: [-0.2, Math.sqrt(.96)] },
  ].map(item => ({ ...item, path: '', type: 'episodic' as const, memoryType: 'conversation',
    role: 'user' as const, source: 'conversation', timestamp: '2026-10-14T00:00:00Z' }))
  vector.saveIndex({ meta: { model: 'fixture', provider: 'fixture', dimensions: 2,
    items: records.length, createdAt: new Date().toISOString() }, data: records }, undefined, username)
  for (const memoryTypes of [undefined, ['conversation']]) {
    const hints = { needsMemory: true, memoryQuery: 'Personal background', memoryTypes }
    const direct = await MemoryRouterNode.execute({ orchestratorHints: hints }, { username }, { topK: 2 })
    assert.deepEqual(direct.memories.map((item: any) => item.id), ['candidate-a', 'candidate-b'])
    assert.ok(direct.memories.every((item: any) => item.score < .5))
    assert.equal(direct.memories[0].role, 'user')
    const reused = await MemoryRouterNode.execute({ orchestratorHints: hints,
      selectedContext: direct.selectedContext }, { username }, { topK: 2 })
    assert.deepEqual(reused.memories, direct.memories)
    assert.equal(reused.searchPerformed, false)
    let work: any
    const dispatched = await MemoryRouterNode.execute({ orchestratorHints: hints }, {
      username, graphExecution: { dispatch: (request: any) => { work = request.payload; return { effectId: 'candidates' } } },
    }, { dispatch: true, topK: 2 })
    const receipt = await (engine as any).handlers.get('vector.semantic-search')(work)
    const built = await environmentContextBuilderNode.execute({ userInstruction: 'What is recorded?',
      memoryWork: dispatched.work, routingAnalysis: { needsResponse: true, needsAction: false,
        taskContext: [], conversationContext: ['memory'] },
    }, { graphExecution: { events: () => [{ eventId: 'candidate-receipt', kind: 'work_result', payload: {
      effectId: 'candidates', result: { state: 'completed', result: receipt },
    } }], pendingEvents: () => [] } }, { purpose: 'conversation' })
    assert.deepEqual(JSON.parse(built.message).memories, direct.memories)
  }
})

test('temporal recall combines exact session, time and type while newest bypasses similarity', async () => {
  const current = { id: 'new-cycle', username, state: 'running', startedAt: '2026-10-14T02:00:00Z', stages: [] }
  fs.mkdirSync(path.dirname(SLEEP_RUNTIME_FILE), { recursive: true })
  fs.writeFileSync(SLEEP_RUNTIME_FILE, JSON.stringify({ version: 1, phase: 'sleeping', currentSession: current,
    recentSessions: [
      { id: 'other-profile', username: 'different-user', state: 'completed', startedAt: '2026-10-14T04:00:00Z', stages: [] },
      { id: 'old-cycle', username, state: 'completed', startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T01:00:00Z', stages: [] },
    ] }))
  const records = [
    { id: 'prior', sleepSessionId: 'old-cycle', timestamp: '2026-10-14T00:30:00Z', memoryType: 'dream' },
    { id: 'latest-dream', sleepSessionId: 'new-cycle', timestamp: '2026-10-14T02:20:00Z', memoryType: 'dream' },
    { id: 'at-inclusive-start', sleepSessionId: 'new-cycle', timestamp: '2026-10-14T02:10:00Z', memoryType: 'dream' },
    { id: 'at-exclusive-end', sleepSessionId: 'new-cycle', timestamp: '2026-10-14T02:30:00Z', memoryType: 'dream' },
    { id: 'no-session', timestamp: '2026-10-14T02:25:00Z', memoryType: 'dream' },
    { id: 'wrong-type', sleepSessionId: 'new-cycle', timestamp: '2026-10-14T02:29:00Z', memoryType: 'conversation' },
  ].map(item => ({ ...item, path: '', type: 'episodic' as const, text: 'Low similarity evidence', vector: [0, 1] }))
  vector.saveIndex({ meta: { model: 'fixture', provider: 'fixture', dimensions: 2, items: records.length, createdAt: new Date().toISOString() }, data: records }, undefined, username)
  const hints = { needsMemory: true, memoryTypes: ['dream'], memoryOrder: 'newest', memorySleepCycle: 'latest',
    memoryTimeRange: { from: '2026-10-14T02:10:00Z', before: '2026-10-14T02:30:00Z' } }
  const direct = await MemoryRouterNode.execute({ userMessage: 'Unrelated wording', orchestratorHints: hints }, { username }, { topK: 3 })
  assert.deepEqual(direct.memories.map((x: any) => x.id), ['latest-dream', 'at-inclusive-start'])
  assert.deepEqual(direct.selectedSleepCycle, { id: current.id, startedAt: current.startedAt, state: 'running' })
  let work: any
  const dispatched = await MemoryRouterNode.execute({ userMessage: 'Unrelated wording', orchestratorHints: hints }, {
    username, graphExecution: { dispatch: (request: any) => { work = request.payload; return { effectId: 'temporal' } } },
  }, { dispatch: true, topK: 3 })
  const receipt = await (engine as any).handlers.get('vector.semantic-search')(work)
  assert.deepEqual(receipt.map((x: any) => x.item.id), ['latest-dream', 'at-inclusive-start'])
  for (const purpose of ['task', 'conversation']) {
    const built = await environmentContextBuilderNode.execute({ userInstruction: 'Recall selected sleep cycle', memoryWork: dispatched.work,
      selectedTask: { program: null, taskDecision: null }, routingAnalysis: { needsAction: true, needsResponse: true, taskContext: ['memory'], conversationContext: ['memory'] },
    }, { graphExecution: { events: () => [{ eventId: 'temporal-receipt', kind: 'work_result', payload: {
      effectId: 'temporal', result: { state: 'completed', result: receipt },
    } }], pendingEvents: () => [] } }, { purpose })
    const delivered = JSON.parse(built.message)
    assert.deepEqual(delivered.selectedSleepCycle, direct.selectedSleepCycle)
    assert.deepEqual(delivered.memories.map((x: any) => x.id), ['latest-dream', 'at-inclusive-start'])
    assert.ok(delivered.memories.every((x: any) => x.sleepSessionId === current.id))
  }
  const empty = await MemoryRouterNode.execute({ userMessage: 'Unrelated wording', orchestratorHints: {
    ...hints, memoryTimeRange: { from: '2026-10-14T03:00:00Z' },
  } }, { username }, { topK: 3 })
  assert.deepEqual(empty.memories, [])
  fs.writeFileSync(SLEEP_RUNTIME_FILE, JSON.stringify({ version: 1, phase: 'awake', recentSessions: [] }))
  const missing = await MemoryRouterNode.execute({ userMessage: 'Unrelated wording', orchestratorHints: hints }, { username }, {})
  assert.deepEqual(missing.memories, [])
  assert.equal(missing.selectedSleepCycle, null)
})

const { UserInputNode } = await import('./nodes/input/user-input.node.js')

test('same-turn recall excludes only the saved input identity before ranking', async () => {
  const input = await withUserContext({ userId: username, username, role: 'owner' }, () => UserInputNode.execute({}, {
    username, userId: username, userMessage: 'Identical request', recordPersonaMemory: true,
    memoryTimestamp: '2026-10-14T02:00:00.000Z', idempotencyKey: 'current-request',
  }, { saveToLongTermMemory: true }))
  const captured = submissions.at(-1)!.input
  assert.equal(input.currentMemoryId, captured.id)
  const noSave = await UserInputNode.execute({}, { userMessage: 'Unsaved input' }, {})
  assert.equal(noSave.currentMemoryId, undefined)
  const indexPath = vector.indexFilePath(undefined, username)
  vector.saveIndex({ meta: { model: 'fixture', provider: 'fixture', dimensions: 2, items: 3, createdAt: new Date().toISOString() }, data: [
    { id: captured.id, path: '', timestamp: '2026-10-14T02:00:00.000Z', type: 'episodic', memoryType: 'conversation', text: 'Identical request', vector: [1, 0] },
    { id: 'earlier-identical', path: '', timestamp: '2026-10-14T01:00:00.000Z', type: 'episodic', memoryType: 'conversation', text: 'Identical request', vector: [1, 0] },
    { id: 'different', path: '', timestamp: '2026-10-14T00:00:00.000Z', type: 'episodic', memoryType: 'conversation', text: 'Different evidence', vector: [0, 1] },
  ] }, undefined, username)
  const semanticSearch = (engine as any).handlers.get('vector.semantic-search')
  for (const memoryOrder of ['relevance', 'newest']) for (const currentMemoryId of [input.currentMemoryId, undefined, 'unknown-record']) {
    const expected = currentMemoryId === captured.id ? 'earlier-identical' : captured.id
    const direct = await MemoryRouterNode.execute({ userMessage: 'Identical request', currentMemoryId,
      orchestratorHints: { needsMemory: true, memoryOrder },
    }, { username }, { topK: 1 })
    assert.equal(direct.memories.length, 1)
    assert.equal(direct.memories[0].id, expected)
    let dispatched: any
    await MemoryRouterNode.execute({ userMessage: 'Identical request', currentMemoryId,
      orchestratorHints: { needsMemory: true, memoryOrder },
    }, { username, graphExecution: { dispatch: (work: any) => { dispatched = work.payload; return { effectId: 'fixture' } } } }, { dispatch: true, topK: 1 })
    const queued = await semanticSearch(dispatched)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].item.id, expected)
  }
})
