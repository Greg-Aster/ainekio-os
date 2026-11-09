import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, mock, test } from 'node:test'

const repo = path.resolve(import.meta.dirname, '../../../../..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-wake-up-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => { throw new Error('No network or physical actions in wake-up tests') }
const identity = await import('../../identity.js')
mock.module('../../identity.js', { namedExports: { ...identity,
  loadPersonaWithFacet: () => ({ identity: { name: 'Fixture companion' }, personality: { description: 'Fixture personality' } }),
  getActiveFacet: () => null,
} })
const voice = await import('../../tts/robot-speech.js')
mock.module('../../tts/robot-speech.js', { namedExports: { ...voice,
  getRobotSpeakerSession: () => 'fixture-body',
  getSpeechOutputSettings: () => ({ provider: 'kokoro', outputTarget: 'robot', speechDisabled: false }),
} })
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('../../audit.js')
setAuditEnabled(false)
const { getProfilePaths } = await import('../../path-builder.js')
const { createUser } = await import('../../users.js')
const { withUserContext } = await import('../../context.js')
const { getQueueManager } = await import('../../queue/unified-queue-manager.js')
const { runDurableGraph, withGraphWork } = await import('../../durable-execution/runtime.js')
const { openExecutionStore } = await import('../../durable-execution/storage.js')
const { loadGraphForMode } = await import('../../graph-streaming.js')
const { writeEnvironmentBridgeState, subscribeEnvironmentActions } = await import('../../environment-interface/store.js')
const { loadBufferForUser } = await import('../../conversation-buffer.js')
const { getAllSchemas } = await import('../index.js')
const username = 'wake-fixture'
const user = createUser(username, 'fixture-only-password', 'owner')
fs.mkdirSync(path.join(root, 'etc/cognitive-graphs'), { recursive: true })
for (const file of ['robot-wake-up-mode.json', 'robot-speech-mode.json']) {
  fs.copyFileSync(path.join(repo, 'etc/cognitive-graphs', file), path.join(root, 'etc/cognitive-graphs', file))
}
const manager = getQueueManager()
after(() => { eventBus.disconnect(); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) })

test('wake-up reuses existing nodes and functional colors without a startup node type', async () => {
  const { graph } = await loadGraphForMode('robot-wake-up', username)
  const schemas = getAllSchemas()
  assert.equal(graph.nodes.length, 10)
  for (const type of ['robot_status', 'conversation_buffer', 'tts', 'stream_writer']) {
    assert.equal(graph.nodes.filter(node => node.data.nodeType === type).length, 1)
  }
  assert.ok(!graph.nodes.some(node => node.data.nodeType === 'memory_capture'))
  assert.ok(!graph.nodes.some(node => node.data.nodeType === 'environment_conversation_delivery'))
  assert.ok(!schemas.some(node => /robot_(startup|wake_up)/.test(node.id)))
  const colors = Object.fromEntries(schemas.map(node => [node.id, node.color]))
  for (const id of ['environment_bridge_input', 'environment_image_input', 'environment_result_wait', 'persona_loader', 'robot_status', 'environment_conversation_result']) assert.equal(colors[id], '#60a5fa')
  assert.equal(colors.environment_context_builder, '#22d3ee')
  assert.equal(colors.environment_conversation, '#ef4444')
  for (const id of ['environment_send_action', 'environment_conversation_delivery']) assert.equal(colors[id], '#4ade80')
  assert.ok(!graph.nodes.some(node => ['workflow_call', 'orchestrator_llm', 'execution_context', 'environment_send_action', 'environment_result_wait'].includes(node.data.nodeType)))
})

for (const failed of [false, true]) test(`wake-up uses one Persona call and one delivery with ${failed ? 'failed' : 'completed'} capture`, async () => {
  await withUserContext({ username, userId: user.id, role: 'owner' }, async () => {
    const { graph } = await loadGraphForMode('robot-wake-up', username)
    const now = new Date().toISOString(), sessionId = `body-${failed}`
    const recognition = { version: 1, robotId: 'fixture-body', gatewayInstance: 'fixture-gateway', epoch: 1,
      frameCounter: 2, observedAt: now, timeBasis: 'gateway_receipt', backend: 'fixture', model: 'fixture',
      summary: 'One enrolled face match', uncertainties: [], objects: [{ label: 'person', score: .9,
        box: { x: .1, y: .1, width: .5, height: .8 }, identity: { state: 'face_match', trackId: 'track',
          personId: 'person', name: 'Fixture Person', faceAgeMs: 0, similarity: .7 } }] }
    const frame = { id: `fresh-${failed}`, timestamp: now, mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2gAA/9k=',
      metadata: { bodyEventId: `boot-${failed}`, robotId: recognition.robotId, gatewayInstance: recognition.gatewayInstance,
        epoch: recognition.epoch, counter: recognition.frameCounter, recognition } }
    const status = { status_received_at: now, motion: { activity: 'gesture', asset: 'stretch' }, vbat: 7.4 }
    const observation = { sessionId, environmentId: 'fixture', adapter: 'fixture', timestamp: now,
      capabilities: { actions: ['robotCommand', 'captureImage'] as any[], robotCommands: ['stand', 'stretch'] },
      ...(!failed ? { visual: frame } : {}),
      state: { body: { robotId: 'fixture-body' }, gateway: { robots: { 'fixture-body': { status } } },
        bodyEvent: { name: 'body_event', event_id: `boot-${failed}`, data: { kind: 'wake', reason: 'boot',
          startup: { capture: { type: failed ? 'rejected' : 'completed' }, imageAvailable: !failed,
            stretch: { state: 'dispatched', sequence: 7 } } } } } }
    writeEnvironmentBridgeState({ enabled: true, updatedAt: now, feedback: [], sessions: {
      [sessionId]: { sessionId, environmentId: 'fixture', adapter: 'fixture', status: 'connected', firstSeenAt: now,
        lastSeenAt: now, latestObservation: observation },
    } })
    const unsubscribe = subscribeEnvironmentActions(sessionId, () => {})
    const work = manager.enqueue({ type: 'generic', handler: 'graph.resume', source: 'environment', username, input: {}, maxAttempts: 1 })
    assert.ok(manager.claim(work.id))
    const run = (executionId?: string) => withGraphWork(work, id => manager.attachExecution(work.id, id),
      () => runDurableGraph({ graph, executionId, context: { username, userId: user.id, cognitiveMode: 'environment',
        userMessage: '', environmentObservation: observation, environmentObservationCurrent: true, allowMemoryWrites: true } }),
      async input => manager.enqueue(input))
    const before = loadBufferForUser(username, 'conversation').messages.length
    try {
      let state = await run()
      assert.equal(state.error, undefined)
      assert.equal(state.status, 'waiting')
      const executionId = state.executionId!
      const store = openExecutionStore(username)
      try {
        assert.equal(manager.getAllTasks().filter(task => task.handler === 'environment.command' && task.durable?.executionId === executionId).length, 0)
        const inference = manager.getAllTasks().filter(task => task.handler === 'environment.conversation' && task.durable?.executionId === executionId)
        assert.equal(inference.length, 1)
        const messages = inference[0].input.messages.messages
        const content = messages[1].content
        const text = Array.isArray(content) ? content[0].text : content
        const evidence = JSON.parse(text.slice(text.indexOf('{')))
        assert.equal(evidence.inputSource, 'autonomy')
        const event = evidence.event.$ref === '#/currentEnvironment/state/bodyEvent'
          ? evidence.currentEnvironment.state.bodyEvent : evidence.event
        assert.deepEqual(event, observation.state.bodyEvent)
        assert.equal(evidence.activePersona.identity.name, 'Fixture companion')
        assert.equal(event.data.startup.stretch.state, 'dispatched')
        assert.equal(evidence.evidenceAvailability.environmentObservation, 'triggering')
        assert.equal(evidence.evidenceAvailability.currentVision, !failed)
        assert.equal(evidence.robotStatus.task ?? null, null)
        assert.equal(evidence.robotStatus.live.sessionId, sessionId)
        assert.ok(evidence.robotStatus.live.readAt)
        assert.equal(evidence.robotStatus.live.power.voltage, status.vbat)
        assert.equal(evidence.robotStatus.live.power.observedAt, now)
        assert.equal(text.includes('data:image'), false, 'Pixel bytes stay outside text')
        assert.equal(Array.isArray(content) ? content.length - 1 : 0, failed ? 0 : 1)
        if (!failed) {
          assert.equal(evidence.visualFrames[0].id, frame.id)
          assert.deepEqual(evidence.currentEnvironment.visualFrames[0].recognition, recognition,
            'The photo retains its recognition even without a separate live recognition update')
        }
        assert.equal(store.task(executionId), null)
        const greeting = state.nodes.get('greeting')!.outputs!.work
        store.appendEvent(executionId, { eventId: 'persona-reply', kind: 'work_result', payload: {
          effectId: greeting.effectId, result: { state: 'completed', result: { response: 'Good morning, Greg.' } },
        } })
        state = await run(executionId)
        assert.equal(state.error, undefined)
        assert.equal(state.nodes.get('feed')!.status, 'completed', 'A stretching body does not block the reply')
        let messagesInBuffer = loadBufferForUser(username, 'conversation').messages
        assert.equal(messagesInBuffer.length, before + 1)
        assert.equal(messagesInBuffer.at(-1)?.meta?.source, 'autonomy')
        assert.equal(messagesInBuffer.at(-1)?.meta?.dialogueSource, 'robot-wake-up')
        assert.ok(messagesInBuffer.at(-1)?.timestamp)
        assert.equal(state.nodes.get('tts')!.status, 'completed')
        assert.equal(state.nodes.get('feed')!.outputs!.output, 'Good morning, Greg.')
        const speech = () => manager.getAllTasks().filter(task => task.handler === 'tts.robot-speech' && task.durable?.executionId === executionId)
        assert.equal(speech().length, 1)
        assert.equal(speech()[0].input.text, 'Good morning, Greg.')
        const profile = getProfilePaths(username)
        const memories = () => fs.existsSync(profile.episodic)
          ? fs.readdirSync(profile.episodic, { recursive: true })
              .filter(file => String(file).endsWith('.json'))
              .map(file => JSON.parse(fs.readFileSync(path.join(profile.episodic, String(file)), 'utf8')))
              .filter(entry => entry.content === 'Good morning, Greg.')
          : []
        assert.equal(memories().length, 0, 'Wake-up greetings stay in short-term conversation buffer without polluting long-term episodic memory')
        await run(executionId)
        assert.equal(speech().length, 1)
        assert.equal(memories().length, 0)
        messagesInBuffer = loadBufferForUser(username, 'conversation').messages
        assert.equal(messagesInBuffer.length, before + 1, 'Replay does not publish again')
        assert.equal(manager.getAllTasks().filter(task => task.handler === 'environment.conversation' && task.durable?.executionId === executionId).length, 1)
      } finally { store.close() }
    } finally { unsubscribe(); manager.complete(work.id, true, {}) }
  })
})
