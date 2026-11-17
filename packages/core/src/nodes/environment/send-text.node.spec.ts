import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-body-control-text-out-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => {
  throw new Error('Unexpected network call in send-text fixture')
}

const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('../../audit.js')
setAuditEnabled(false)
const voice = await import('../../tts/robot-speech.js')
mock.module(new URL('../../tts/robot-speech.ts', import.meta.url).href, {
  namedExports: {
    ...voice,
    getSpeechOutputSettings: () => ({ provider: 'kokoro', outputTarget: 'robot', speechDisabled: false }),
    getRobotSpeakerSession: () => 'fixture-body-session',
  },
})

const { createUser } = await import('../../users.js')
const { withUserContext } = await import('../../context.js')
const { getQueueManager } = await import('../../queue/unified-queue-manager.js')
const { runDurableGraph, withGraphWork } = await import('../../durable-execution/runtime.js')
const { loadGraphForMode } = await import('../../graph-streaming.js')
const {
  drainEnvironmentBridgeText,
  recordEnvironmentObservation,
  setEnvironmentBridgeEnabled,
} = await import('../../environment-interface/store.js')
const {
  getNodeColors,
  getNodeExecutor,
  getNodeFunctionalCategory,
  getNodeSchema,
} = await import('../index.js')
const { getNodeSchema: getBrowserSchema } = await import('../schemas.js')
const { consumeActionStream } = await import('../../../../../brain/agents/environment-bridge/core.js')

const username = 'body-control-text-fixture'
createUser(username, 'fixture-only-password', 'owner')
fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
fs.cpSync(path.join(repo, 'etc/cognitive-graphs'), path.join(root, 'etc/cognitive-graphs'), { recursive: true })
const manager = getQueueManager()

test('Body Control Text Out registers as a green Output node with alias and browser schema', () => {
  const canonical = getNodeSchema('environment_send_text')
  const aliased = getNodeSchema('body_control_text_out')
  assert.ok(canonical)
  assert.equal(aliased?.id, 'environment_send_text')
  assert.equal(canonical.name, 'Body Control Text Out')
  assert.equal(getNodeFunctionalCategory(canonical), 'output')
  assert.equal(getNodeColors(canonical).color, '#4ade80')

  const browserSchema = getBrowserSchema('environment_send_text')
  assert.ok(browserSchema)
  assert.equal(browserSchema.name, 'Body Control Text Out')
  assert.equal(browserSchema.color, '#4ade80')
})

test('Body Control Text Out skips cleanly when Environment Bridge has no connected session', async () => {
  setEnvironmentBridgeEnabled(false)
  const execute = getNodeExecutor('environment_send_text')!
  const result = await execute({ text: 'Hello remote operator' }, { username } as any, {})
  assert.equal(result.sent, false)
  assert.equal(result.status, 'bridge_disabled')
})

test('environment-conversation-mode streams reply to Body Control once across durable resume without stealing bodyLease', async () => {
  const sessionId = 'fixture-body-session'
  setEnvironmentBridgeEnabled(true)
  recordEnvironmentObservation({
    id: 'obs-1',
    sessionId,
    environmentId: 'ainekio-gateway',
    adapter: 'ainekio-body-control',
    timestamp: new Date().toISOString(),
    capabilities: { actions: ['sendText'] },
    state: {
      adapterConnected: true,
      body: { robotId: 'p4', authenticated: true },
    },
  })

  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const { graph } = await loadGraphForMode('environment-conversation', username)
    const reply = 'Standing steady on the desk — camera feed looks clear.'
    const metadata = {
      source: 'environment',
      dialogueSource: 'voice-turn',
      correlationId: 'turn-42',
    }
    const work = manager.enqueue({
      type: 'generic',
      handler: 'graph.resume',
      source: 'user',
      username,
      maxAttempts: 1,
      input: {},
    })
    assert.ok(manager.claim(work.id))

    const started = await withGraphWork(
      work,
      id => manager.attachExecution(work.id, id),
      () => runDurableGraph({
        graph,
        context: {
          username,
          userId: username,
          cognitiveMode: 'environment',
          allowMemoryWrites: true,
          environmentConversationMetadata: metadata,
          environmentConversationResponse: reply,
        },
      }),
      async input => manager.enqueue(input),
    )

    assert.equal(started.error, undefined)

    // Durable resume must not enqueue a duplicate text-stream message.
    await runDurableGraph({ graph, executionId: started.executionId, context: { username } })

    const envCommands = manager.getAllTasks().filter(item => item.type === 'environment_command')
    assert.equal(envCommands.length, 0, 'Text streaming must never enqueue physical environment_command tasks')
    assert.equal(
      manager.getAllTasks().some(item => item.bodyLease !== undefined),
      false,
      'Text streaming must never acquire or mutate bodyLease',
    )

    const drained = drainEnvironmentBridgeText(sessionId)
    assert.equal(drained.length, 1)
    assert.equal(drained[0].text, reply)
    assert.equal(drained[0].role, 'assistant')
    assert.equal(drained[0].source, 'voice-turn')
    assert.equal(drained[0].executionId, started.executionId)
    assert.equal(drained[0].cognitiveMode, 'environment')
    assert.equal(drainEnvironmentBridgeText(sessionId).length, 0, 'Drained messages are removed from the pending queue')
  })
})

test('consumeActionStream forwards SSE messages events to sendTextStream callback', async () => {
  const controller = new AbortController()
  const delivered: Record<string, unknown>[] = []
  const ssePayload = `event: messages\ndata: ${JSON.stringify({
    messages: [
      {
        id: 'msg-1',
        sessionId: 'fixture-body-session',
        text: 'Hello Ainekio Cockpit',
        role: 'assistant',
        source: 'environment',
        timestamp: '2026-11-16T18:00:00.000Z',
      },
    ],
  })}\n\n`

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (!sent) {
          sent = true
          streamController.enqueue(encoder.encode(ssePayload))
          return
        }
        controller.abort()
        streamController.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  try {
    await consumeActionStream(
      {
        coreUrl: 'http://127.0.0.1:4321',
        adapterUrl: 'ws://127.0.0.1:8765/environment',
        serviceToken: 'fixture-token',
        adapterToken: 'fixture-adapter-token',
        sessionId: 'fixture-body-session',
        environmentId: 'ainekio-gateway',
        adapterName: 'ainekio-body-control',
        reconnectMs: 500,
      } as any,
      'fixture-body-session',
      async () => {},
      controller.signal,
      () => {},
      () => {},
      () => {},
      message => {
        delivered.push(message)
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].id, 'msg-1')
  assert.equal(delivered[0].text, 'Hello Ainekio Cockpit')
  assert.equal(delivered[0].role, 'assistant')
})

after(() => {
  eventBus.disconnect()
  mock.restoreAll()
  fs.rmSync(root, { recursive: true, force: true })
})
