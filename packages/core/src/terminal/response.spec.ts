import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-terminal-response-'))
process.env.METAHUMAN_ROOT = root
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { createUser } = await import('../users.js')
const { getProfilePaths } = await import('../paths.js')
const { withUserContext } = await import('../context.js')
const { openExecutionStore } = await import('../durable-execution/storage.js')
const { ExecutionEngine } = await import('../queue/execution-engine.js')
const { UnifiedQueueManager } = await import('../queue/unified-queue-manager.js')
const { loadBufferForUser, retireBufferAdmissions } = await import('../conversation-buffer.js')
const { peekTTSQueue } = await import('../tts/delivery-queue.js')
const { admitTerminalResponse } = await import('./response.js')
const { runGraph } = await import('../graph-runtime.js')
const { loadGraphForMode } = await import('../graph-streaming.js')
const { recordEnvironmentObservation } = await import('../environment-interface/store.js')
const username = 'terminal-response-owner'
createUser(username, 'fixture-only-password', 'owner')
const profile = getProfilePaths(username)
fs.mkdirSync(path.dirname(profile.voiceConfig), { recursive: true })
fs.writeFileSync(profile.voiceConfig, JSON.stringify({ tts: { outputTarget: 'local', speechDisabled: false } }))
fs.mkdirSync(path.join(root, 'etc/cognitive-graphs'), { recursive: true })
fs.copyFileSync(new URL('../../../../etc/cognitive-graphs/big-brother-response-mode.json', import.meta.url), path.join(root, 'etc/cognitive-graphs/big-brother-response-mode.json'))
fs.copyFileSync(new URL('../../../../etc/cognitive-graphs/robot-speech-mode.json', import.meta.url), path.join(root, 'etc/cognitive-graphs/robot-speech-mode.json'))
const manager = new UnifiedQueueManager()
const engine = new ExecutionEngine({}, manager)
let unavailable = false
const coordinator = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  res.writeHead(unavailable ? 503 : 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(unavailable ? { error: 'fixture coordinator unavailable' } : { task: manager.enqueue(JSON.parse(body)) }))
})
await new Promise<void>(resolve => coordinator.listen(0, '127.0.0.1', resolve))
process.env.MH_WORK_COORDINATOR_URL = `http://127.0.0.1:${(coordinator.address() as import('node:net').AddressInfo).port}`
fs.mkdirSync(path.join(root, 'logs/run/queue'), { recursive: true })
fs.writeFileSync(path.join(root, 'logs/run/queue/service-token'), 'fixture-response-token')
test.after(async () => { eventBus.disconnect(); await new Promise<void>(resolve => coordinator.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }) })
const turn = (submissionId: string): Parameters<typeof admitTerminalResponse>[0] => ({ username, sessionId: 'native-session', submissionId, threadId: 'native-thread',
  message: 'Original terminal request', receivedAt: '2026-11-03T12:00:00Z',
  result: { success: true, output: 'Exact Big Brother final answer.\nSecond line.', executionTime: 1, metadata: {} } })
async function deliver(executionId: string) {
  const task = manager.getAllTasks().find(task => task.input.executionId === executionId)!
  assert.ok(task)
  assert.ok(manager.claim(task.id))
  await (engine as unknown as { execute(task: import('../queue/types.js').QueuedTask): Promise<void> }).execute(task)
  assert.equal(manager.getTask(task.id)?.state, 'completed', JSON.stringify(manager.getTask(task.id)?.error))
}

test('completed reply uses the real graph, terminal buffer, metadata and existing speech queue once across reopen/resume', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const original = turn('first')
    const id = await admitTerminalResponse(original)
    assert.equal(await admitTerminalResponse(original), id, 'admission reuses the submission identity')
    assert.equal(manager.getAllTasks().filter(task => task.input.executionId === id).length, 1)
    await deliver(id)
    const entries = loadBufferForUser(username, 'terminal').messages
    assert.deepEqual(entries.map(entry => entry.content), [original.message, original.result.output])
    assert.equal(entries[0].timestamp, Date.parse(original.receivedAt))
    assert.equal(entries[1].meta.speaker, 'Big Brother')
    assert.equal(entries[1].meta.source, 'big-brother')
    assert.equal(entries[1].meta.terminalSessionId, original.sessionId)
    assert.equal(entries[1].meta.submissionId, original.submissionId)
    assert.equal(loadBufferForUser(username, 'conversation').messages.length, 0)
    assert.deepEqual(peekTTSQueue(username).map(item => item.text), [original.result.output])
    assert.equal(peekTTSQueue(username)[0].source, 'big-brother')
    const { graph } = await loadGraphForMode('big-brother-response', username)
    await runGraph({ graph, context: { username }, executionId: id })
    assert.equal(loadBufferForUser(username, 'terminal').messages.length, 2)
    assert.equal(peekTTSQueue(username).length, 1)
    await retireBufferAdmissions(username, id)
    assert.deepEqual(loadBufferForUser(username, 'terminal').executionAdmissions, {})
  })
})

test('failed coordinator admission retains the completed response in the existing execution store and recovers without rerunning Codex', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    unavailable = true
    const original = turn('offline')
    await assert.rejects(admitTerminalResponse(original), /coordinator unavailable/)
    const reopened = openExecutionStore(username)
    const savedId = reopened.admittedExecutionId(username, 'terminal-response:offline')!
    assert.ok(savedId)
    assert.equal(reopened.entry(savedId).context.environmentConversationResponse, original.result.output)
    assert.equal(reopened.pendingDispatches(savedId).length, 1)
    reopened.close()
    unavailable = false
    const id = await admitTerminalResponse(original)
    assert.equal(id, savedId)
    await deliver(id)
    assert.equal(loadBufferForUser(username, 'terminal').messages.filter(entry => entry.meta.submissionId === 'offline').length, 2)
  })
})

test('speech disabled preserves the visible failure reply without enqueuing audio', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    fs.writeFileSync(profile.voiceConfig, JSON.stringify({ tts: { outputTarget: 'local', speechDisabled: true } }))
    const before = peekTTSQueue(username).length
    const original = turn('failed-provider')
    original.result = { ...original.result, success: false, output: '', error: 'Codex provider failed' }
    const id = await admitTerminalResponse(original)
    await deliver(id)
    const reply = loadBufferForUser(username, 'terminal').messages.at(-1)!
    assert.equal(reply.content, 'Codex provider failed')
    assert.equal(reply.meta.success, false)
    assert.equal(peekTTSQueue(username).length, before)
  })
})

test('Big Brother TTS admits Body Control computer speech with no physical robot', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    fs.writeFileSync(profile.voiceConfig, JSON.stringify({ tts: { provider: 'kokoro', outputTarget: 'robot', speechDisabled: false } }))
    recordEnvironmentObservation({ environmentId: 'ainekio', adapter: 'ainekio-gateway', sessionId: 'body-control-computer',
      timestamp: new Date().toISOString(), capabilities: { actions: ['speak'] },
      state: { adapterConnected: true, body: { authenticated: false, motionAvailable: false,
        speakerReady: true, speechPlaybackTarget: 'computer' } } })
    const before = peekTTSQueue(username).length
    const original = turn('computer-speech')
    await deliver(await admitTerminalResponse(original))
    const speech = manager.getAllTasks().find(task => task.handler === 'tts.robot-speech')!
    assert.ok(speech, 'The real response graph must admit speech through the existing Coordinator')
    assert.equal(speech.input.sessionId, 'body-control-computer')
    assert.equal(speech.input.text, original.result.output)
    assert.equal(peekTTSQueue(username).length, before)
    assert.equal(loadBufferForUser(username, 'terminal').messages.at(-1)!.content, original.result.output)
  })
})
