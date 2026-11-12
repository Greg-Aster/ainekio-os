import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ParsedBigBrotherEvent } from './cli.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-gemini-acp-'))
process.env.METAHUMAN_ROOT = root
fs.mkdirSync(path.join(root, 'etc'))
const receipts = path.join(root, 'receipts')
fs.mkdirSync(receipts)
const logPath = path.join(root, 'acp-calls.jsonl')
fs.writeFileSync(logPath, '')

const agyFixture = path.join(root, 'agy.cjs')
fs.writeFileSync(agyFixture, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const record = value => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
record({ boot: true, args: process.argv.slice(2) });
let sessionCounter = 0;
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ message: msg });
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === 'session/new') {
    const sid = 'acp-sess-' + (++sessionCounter);
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } });
  } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode' || msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = (msg.params.prompt || []).filter(p => p.type === 'text').map(p => p.text).join(' ');
    if (text.includes('crash-daemon')) {
      process.exit(2);
      return;
    }
    if (text.includes('hold-until-cancel')) {
      return;
    }
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Warm reply: ' + text } },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }, 15);
  }
});
`, { mode: 0o700 })

fs.writeFileSync(path.join(root, 'etc', 'tool-executor.json'), JSON.stringify({
  backends: {
    gemini: {
      enabled: true,
      command: agyFixture,
      args: ['--model', 'gemini-3.8-flash-low'],
      dangerouslySkipPermissions: true,
      reasoningEffort: 'low',
    },
  },
}))

const { GeminiAcpServer } = await import('./gemini-acp-server.js')
const { terminalJobs } = await import('../paths.js')
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()

const readRecords = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('GeminiAcpServer keeps one warm ACP daemon across concurrent and repeated turns, forwards inline images, recovers from crashes, and releases receipts on stop', async () => {
  const server = new GeminiAcpServer(receipts)
  try {
    const events1: ParsedBigBrotherEvent[] = []
    const events2: ParsedBigBrotherEvent[] = []

    const [turn1, turn2] = await Promise.all([
      server.executeTurn({
        model: 'gemini-3.8-flash-low',
        toolAccess: 'read-only',
        modelRequest: {
          messages: [
            { role: 'system', content: 'Ainekio OS system instructions.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Camera check' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } },
              ],
            },
          ],
          responseInstructions: 'Return JSON only.',
        },
      }, new AbortController().signal, async () => {}, ev => events1.push(ev)),
      server.executeTurn({
        model: 'gemini-3.8-flash-low',
        enableThinking: true,
        modelRequest: {
          messages: [{ role: 'user', content: 'Second concurrent check' }],
        },
      }, new AbortController().signal, async () => {}, ev => events2.push(ev)),
    ])

    assert.equal(turn1.success, true)
    assert.equal(turn1.output, 'Warm reply: Camera check')
    assert.equal(turn2.success, true)
    assert.equal(turn2.output, 'Warm reply: Second concurrent check')
    assert.equal(events1.some(e => e.threadId?.startsWith('acp-sess-')), true)

    const initialRecords = readRecords()
    const bootPids = initialRecords.filter(r => r.boot).map(r => r.pid)
    assert.equal(bootPids.length, 1, 'Only one warm agy acp process should boot for concurrent turns')

    const newSessions = initialRecords.filter(r => r.message?.method === 'session/new')
    const toolSession = newSessions.find(r => r.message.params._meta?.antigravity?.systemPrompt)
    assert.ok(toolSession, 'Read-only tool session must append systemPrompt on dedicated session/new')
    assert.deepEqual(toolSession.message.params.mcpServers, [])
    assert.match(toolSession.message.params._meta.antigravity.systemPrompt.append, /Ainekio OS system instructions/)
    assert.match(toolSession.message.params._meta.antigravity.systemPrompt.append, /Return JSON only/)

    const warmPureSessions = newSessions.filter(r => r.message.params._meta?.antigravity?.disableBuiltInTools === true)
    assert.ok(warmPureSessions.length >= 2, 'Daemon must pre-allocate warm pure-inference sessions with disableBuiltInTools')

    const prompts = initialRecords.filter(r => r.message?.method === 'session/prompt')
    const imagePrompt = prompts.find(r => r.message.params.prompt.some((p: any) => p.type === 'image'))
    assert.ok(imagePrompt, 'Inline base64 image block must be passed in session/prompt')
    assert.deepEqual(
      imagePrompt.message.params.prompt.find((p: any) => p.type === 'image'),
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' },
    )

    // Allow background replenishment to settle, then verify the next pure turn sends session/prompt
    // on an ALREADY-created and model-configured session (zero session/new or session/set_model on critical path)
    await new Promise(resolve => setTimeout(resolve, 25))
    const preTurnCount = readRecords().length

    const turn3 = await server.executeTurn({
      model: 'gemini-3.8-flash-low',
      modelRequest: {
        messages: [
          { role: 'system', content: 'Pure system context.' },
          { role: 'user', content: 'Instant prewarmed turn' },
        ],
        responseInstructions: 'Respond concisely.',
      },
    }, new AbortController().signal, async () => {}, () => {})

    assert.equal(turn3.success, true)
    assert.match(turn3.output, /Pure system context\./)
    assert.match(turn3.output, /Instant prewarmed turn/)
    assert.match(turn3.output, /Respond concisely\./)

    const turn3Records = readRecords().slice(preTurnCount)
    const promptIdx = turn3Records.findIndex(r =>
      r.message?.method === 'session/prompt'
      && r.message.params.sessionId === turn3.metadata?.threadId
    )
    assert.equal(promptIdx, 0, 'Pre-warmed turn must dispatch session/prompt immediately before any replenishment RPCs')
    assert.equal(
      turn3Records.some(r =>
        (r.message?.method === 'session/new' || r.message?.method === 'session/set_model')
        && r.message.params?.sessionId === turn3.metadata?.threadId
      ),
      false,
      'Pre-warmed session must already have session/new + session/set_model completed before the turn starts',
    )

    // Cancellation sends session/cancel and keeps the warm server alive
    const cancelController = new AbortController()
    setTimeout(() => cancelController.abort(new Error('User interrupted')), 25)
    const cancelled = await server.executeTurn({
      model: 'gemini-3.8-flash-low',
      modelRequest: { messages: [{ role: 'user', content: 'hold-until-cancel' }] },
    }, cancelController.signal, async () => {}, () => {})
    assert.equal(cancelled.success, false)
    assert.match(cancelled.error || '', /User interrupted/)
    assert.equal(readRecords().filter(r => r.boot).length, 1, 'Cancellation must not kill the warm ACP server')
    assert.equal(readRecords().some(r => r.message?.method === 'session/cancel'), true)

    // Crash recovery spawns a replacement daemon on the following turn
    const crashed = await server.executeTurn({
      model: 'gemini-3.8-flash-low',
      modelRequest: { messages: [{ role: 'user', content: 'crash-daemon' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(crashed.success, false)

    const recovered = await server.executeTurn({
      model: 'gemini-3.8-flash-low',
      modelRequest: { messages: [{ role: 'user', content: 'After crash' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(recovered.success, true)
    assert.equal(recovered.output, 'Warm reply: After crash')
    assert.equal(readRecords().filter(r => r.boot).length, 2)
  } finally {
    await server.stop()
  }

  assert.deepEqual(fs.readdirSync(receipts), [], 'All process receipts must be released on stop')
  assert.deepEqual(fs.readdirSync(terminalJobs), [], 'All job and isolated home directories must be removed on stop')
})
