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
record({ boot: true, args: process.argv.slice(2), home: process.env.HOME });
let sessionCounter = 0;
const closeErrorSessions = new Set();
const chunkFlushTimers = new Map();
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ message: msg });
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === 'session/new') {
    const sid = 'acp-sess-' + (++sessionCounter);
    const agyHome = require('path').join(process.env.HOME || '', '.gemini', 'antigravity-cli');
    fs.mkdirSync(require('path').join(agyHome, 'conversations'), { recursive: true });
    fs.mkdirSync(require('path').join(agyHome, 'brain', sid), { recursive: true });
    fs.mkdirSync(require('path').join(agyHome, 'annotations'), { recursive: true });
    fs.writeFileSync(require('path').join(agyHome, 'conversations', sid + '.db'), 'db');
    fs.writeFileSync(require('path').join(agyHome, 'conversations', sid + '.db-wal'), 'wal');
    fs.writeFileSync(require('path').join(agyHome, 'brain', sid, 'state.json'), '{}');
    fs.writeFileSync(require('path').join(agyHome, 'annotations', sid + '.pbtxt'), 'note: 1');
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } });
  } else if (msg.method === 'session/close') {
    const flushTimer = chunkFlushTimers.get(msg.params.sessionId);
    if (flushTimer) {
      setTimeout(() => {
        clearInterval(flushTimer);
        chunkFlushTimers.delete(msg.params.sessionId);
      }, 25);
    }
    if (closeErrorSessions.has(msg.params.sessionId)) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'close failed' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
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
    if (text.includes('flush-chunks-on-cancel')) {
      const chunksDir = require('path').join(
        process.env.HOME || '',
        '.gemini',
        'antigravity-cli',
        'brain',
        sid,
        '.system_generated',
        'logs',
        'chunks',
      );
      let seq = 0;
      const timer = setInterval(() => {
        try {
          fs.mkdirSync(chunksDir, { recursive: true });
          fs.writeFileSync(require('path').join(chunksDir, 'chunk-' + (++seq) + '.txt'), 'flushing');
        } catch {}
      }, 2);
      chunkFlushTimers.set(sid, timer);
      return;
    }
    if (text.includes('break-stdin-pipe')) {
      setInterval(() => {}, 1000);
      try { fs.closeSync(0); } catch {}
      process.stdin.destroy();
      return;
    }
    if (text.includes('close-error')) {
      closeErrorSessions.add(sid);
    }
    if (text.includes('slow-reply')) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Slow reply completed' } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, 60);
      return;
    }
    if (text.includes('duplicate-json-replay')) {
      const payload = JSON.stringify({ updates: [{ action: 'keep', id: 'g1' }], assessmentReason: 'Clear path', memoryRequest: null });
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: payload } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: payload } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, 10);
      return;
    }
    if (text.includes('retry-after-user-chunk')) {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"stale":true' } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed prompt' } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"updates":[],"assessmentReason":"Recovered","memoryRequest":null}' } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, 10);
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
      args: ['--model', 'gemini-4-hydrogen-low'],
      dangerouslySkipPermissions: true,
      reasoningEffort: 'low',
    },
  },
}))

const { GeminiAcpServer, normalizeAcpTurnOutput, purgeClosedSessionArtifacts } = await import('./gemini-acp-server.js')
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
        model: 'gemini-4-hydrogen-low',
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
        model: 'gemini-4-hydrogen-low',
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

    // Allow background replenishment to settle, then verify the next pure turn without system blocks
    // sends session/prompt on an ALREADY-created and model-configured session (zero session/new or session/set_model on critical path)
    await new Promise(resolve => setTimeout(resolve, 25))
    const preTurnCount = readRecords().length

    const turn3 = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [
          { role: 'user', content: 'Instant prewarmed turn' },
        ],
      },
    }, new AbortController().signal, async () => {}, () => {})

    assert.equal(turn3.success, true)
    assert.equal(turn3.output, 'Warm reply: Instant prewarmed turn')

    const turn3Records = readRecords().slice(preTurnCount)
    const promptIdx = turn3Records.findIndex(r =>
      r.message?.method === 'session/prompt'
      && r.message.params.sessionId === turn3.metadata?.threadId
    )
    assert.equal(promptIdx, 0, 'Pre-warmed turn must dispatch session/prompt immediately before any replenishment RPCs')
    assert.deepEqual(
      turn3Records[promptIdx].message.params.prompt,
      [{ type: 'text', text: 'Instant prewarmed turn' }],
    )
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
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'hold-until-cancel' }] },
    }, cancelController.signal, async () => {}, () => {})
    assert.equal(cancelled.success, false)
    assert.match(cancelled.error || '', /User interrupted/)
    assert.equal(readRecords().filter(r => r.boot).length, 1, 'Cancellation must not kill the warm ACP server')
    assert.equal(readRecords().some(r => r.message?.method === 'session/cancel'), true)

    // Crash recovery spawns a replacement daemon on the following turn
    const crashed = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'crash-daemon' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(crashed.success, false)

    const recovered = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
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

test('GeminiAcpServer isolates HOME using jetski_state.pbtxt credentials and recovers replayed JSON chunks without masking distinct errors', async () => {
  const fakeHome = fs.mkdtempSync(path.join(root, 'fake-home-'))
  const agyDir = path.join(fakeHome, '.gemini', 'antigravity-cli')
  fs.mkdirSync(agyDir, { recursive: true })
  fs.writeFileSync(path.join(agyDir, 'jetski_state.pbtxt'), 'oauth_state: "present"\n')
  fs.writeFileSync(path.join(agyDir, 'installation_id'), 'install-123\n')
  const prevHome = process.env.HOME
  process.env.HOME = fakeHome
  const preCount = readRecords().length

  const server = new GeminiAcpServer(receipts)
  try {
    const dupTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [{ role: 'user', content: 'duplicate-json-replay' }],
        responseInstructions: 'Respond with valid JSON matching the schema.',
      },
    }, new AbortController().signal, async () => {}, () => {})

    assert.equal(dupTurn.success, true)
    assert.deepEqual(JSON.parse(dupTurn.output), {
      updates: [{ action: 'keep', id: 'g1' }],
      assessmentReason: 'Clear path',
      memoryRequest: null,
    })

    const retryTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [{ role: 'user', content: 'retry-after-user-chunk' }],
        responseInstructions: 'Respond with valid JSON matching the schema.',
      },
    }, new AbortController().signal, async () => {}, () => {})

    assert.equal(retryTurn.success, true)
    assert.deepEqual(JSON.parse(retryTurn.output), {
      updates: [],
      assessmentReason: 'Recovered',
      memoryRequest: null,
    })

    const boots = readRecords().slice(preCount).filter(r => r.boot)
    assert.equal(boots.length, 1)
    assert.notEqual(boots[0].home, fakeHome, 'Daemon must run in isolated HOME when jetski_state.pbtxt exists without antigravity-oauth-token')
    assert.equal(fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt')), true)
    assert.equal(fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'settings.json')), true)
  } finally {
    process.env.HOME = prevHome
    await server.stop()
  }

  assert.equal(
    normalizeAcpTurnOutput('```json\n{"ok":true}\n```', 'Return JSON.'),
    '{"ok":true}',
  )
  assert.equal(
    normalizeAcpTurnOutput('Here is the JSON:\n```json\n{"ok":true}\n```\nDone.', 'Return JSON.'),
    '{"ok":true}',
  )
  assert.equal(
    normalizeAcpTurnOutput('```json\n{"ok":true}\n```\n```json\n{"ok":true}\n```', 'Return JSON.'),
    '{"ok":true}',
  )
  assert.equal(
    normalizeAcpTurnOutput('Assessment:\n{"ok":true}\nDone.', 'Return JSON.'),
    '{"ok":true}',
  )
  assert.equal(
    normalizeAcpTurnOutput('```json\n{"a":1}\n```\n```json\n{"b":2}\n```', 'Return JSON.'),
    '```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
    'Distinct fenced objects must not be silently collapsed',
  )
  assert.equal(
    normalizeAcpTurnOutput('{"a":1}{"b":2}', 'Return JSON.'),
    '{"a":1}{"b":2}',
    'Distinct concatenated objects must not be silently collapsed',
  )
  assert.equal(
    normalizeAcpTurnOutput('{"a":1}{"a":1}', undefined),
    '{"a":1}{"a":1}',
    'Plain-text turns without JSON instructions must remain untouched',
  )
})

test('GeminiAcpServer imposes no configured backend timeout on inference and recycles daemon when session/close fails', async () => {
  const toolConfigPath = path.join(root, 'etc', 'tool-executor.json')
  const originalConfig = fs.readFileSync(toolConfigPath, 'utf8')
  const parsed = JSON.parse(originalConfig)
  parsed.backends.gemini.timeout = 20
  fs.writeFileSync(toolConfigPath, JSON.stringify(parsed))

  const preCount = readRecords().length
  const server = new GeminiAcpServer(receipts)
  try {
    const slowTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'slow-reply' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(slowTurn.success, true)
    assert.equal(slowTurn.output, 'Slow reply completed')

    // When session/close fails, the daemon must be torn down so subsequent turns boot a clean process
    const closeFailTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'close-error' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(closeFailTurn.success, true)

    const cleanTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'After close failure' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(cleanTurn.success, true)
    assert.equal(cleanTurn.output, 'Warm reply: After close failure')

    const boots = readRecords().slice(preCount).filter(r => r.boot)
    assert.equal(boots.length, 2, 'Failed session/close must recycle the warm ACP daemon')
  } finally {
    fs.writeFileSync(toolConfigPath, originalConfig)
    await server.stop()
  }
})

test('GeminiAcpServer isolates HOME unconditionally for keyring auth, maps hydrogen effort, and purges closed turn artifacts', async () => {
  const emptyKeyringHome = fs.mkdtempSync(path.join(root, 'keyring-home-'))
  const prevHome = process.env.HOME
  process.env.HOME = emptyKeyringHome
  const preCount = readRecords().length

  const server = new GeminiAcpServer(receipts)
  try {
    const turn = await server.executeTurn({
      model: 'gemini-4-hydrogen-high',
      reasoningEffort: 'none',
      modelRequest: { messages: [{ role: 'user', content: 'Hydrogen keyring check' }] },
    }, new AbortController().signal, async () => {}, () => {})

    assert.equal(turn.success, true)
    assert.equal(turn.metadata?.model, 'gemini-4-hydrogen-low')
    const sid = typeof turn.metadata?.threadId === 'string' ? turn.metadata.threadId : ''
    assert.ok(sid)

    const boots = readRecords().slice(preCount).filter(r => r.boot)
    assert.equal(boots.length, 1)
    assert.notEqual(boots[0].home, emptyKeyringHome, 'Daemon must isolate HOME even when auth uses Linux keyring with no token files')
    assert.equal(
      fs.existsSync(path.join(boots[0].home, '.gemini', 'config', 'projects', 'default-cli-project.json')),
      true,
    )
    assert.equal(
      fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'conversations', `${sid}.db`)),
      false,
      'Closed turn SQLite database must be purged immediately',
    )
    assert.equal(
      fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'conversations', `${sid}.db-wal`)),
      false,
    )
    assert.equal(
      fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'brain', sid!)),
      false,
      'Closed turn brain directory must be purged immediately',
    )
    assert.equal(
      fs.existsSync(path.join(boots[0].home, '.gemini', 'antigravity-cli', 'annotations', `${sid}.pbtxt`)),
      false,
      'Closed turn annotations file must be purged immediately',
    )
    assert.equal(fs.existsSync(path.join(emptyKeyringHome, '.gemini')), false, 'Real HOME must remain untouched')
  } finally {
    process.env.HOME = prevHome
    await server.stop()
  }
})

test('GeminiAcpServer.warmup and TerminalRuntime.warmupConfiguredProviders pre-warm ACP sessions before first user turn and retarget switched models', async () => {
  const { saveUserConfig } = await import('../../config.js')
  const { TerminalRuntime } = await import('../runtime.js')

  const preCount = readRecords().length
  const server = new GeminiAcpServer(receipts)
  try {
    const warmed = await server.warmup({ model: 'gemini-4-hydrogen-low' })
    assert.equal(warmed.modelId, 'gemini-4-hydrogen-low')

    const afterWarmup = readRecords().slice(preCount)
    assert.equal(afterWarmup.filter(r => r.boot).length, 1, 'warmup() must boot agy acp before any user turn')
    assert.equal(
      afterWarmup.filter(r => r.message?.method === 'session/new').length,
      2,
      'warmup() must resolve only after warm pure-inference sessions are ready',
    )
    assert.equal(
      afterWarmup.filter(r => r.message?.method === 'session/set_model' && r.message.params?.modelId === 'gemini-4-hydrogen-low').length,
      2,
    )

    // First turn after warmup must dispatch session/prompt immediately at index 0 (zero cold-start RPCs)
    const beforeFirstTurn = readRecords().length
    const firstTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'First spoken turn after enable' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(firstTurn.success, true)
    assert.equal(firstTurn.output, 'Warm reply: First spoken turn after enable')
    const firstTurnRecords = readRecords().slice(beforeFirstTurn)
    assert.equal(firstTurnRecords[0]?.message?.method, 'session/prompt')
    assert.equal(firstTurnRecords[0]?.message?.params?.sessionId, firstTurn.metadata?.threadId)

    // Switching reasoningEffort/model via warmup() retargets idle warm sessions in place
    const switched = await server.warmup({ model: 'gemini-4-hydrogen-low', reasoningEffort: 'high' })
    assert.equal(switched.modelId, 'gemini-4-hydrogen-high')

    const beforeSwitchedTurn = readRecords().length
    const secondTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      reasoningEffort: 'high',
      modelRequest: { messages: [{ role: 'user', content: 'Turn after effort switch' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(secondTurn.success, true)
    assert.equal(secondTurn.metadata?.model, 'gemini-4-hydrogen-high')
    const secondTurnRecords = readRecords().slice(beforeSwitchedTurn)
    assert.equal(secondTurnRecords[0]?.message?.method, 'session/prompt')
    assert.equal(
      secondTurnRecords.some(r =>
        r.message?.method === 'session/set_model'
        && r.message.params?.sessionId === secondTurn.metadata?.threadId
      ),
      false,
      'Retargeted warm session must already have session/set_model completed before turn starts',
    )
  } finally {
    await server.stop()
  }

  // TerminalRuntime.warmupConfiguredProviders() warms GeminiAcpServer on terminal daemon startup when enabled
  saveUserConfig('operator.json', {
    bigBrotherMode: {
      enabled: true,
      provider: 'gemini',
      model: 'gemini-4-hydrogen-low',
      reasoningEffort: 'medium',
      delegateAll: true,
    },
  }, 'warmup-operator')

  const runtimePreCount = readRecords().length
  const runtime = new TerminalRuntime(receipts)
  try {
    assert.equal(readRecords().slice(runtimePreCount).filter(r => r.boot).length, 0, 'Constructor remains side-effect free')
    await runtime.warmupConfiguredProviders()
    const runtimeRecords = readRecords().slice(runtimePreCount)
    assert.equal(runtimeRecords.filter(r => r.boot).length, 1, 'warmupConfiguredProviders() boots ACP daemon for enabled Gemini profile')
    assert.equal(
      runtimeRecords.filter(r => r.message?.method === 'session/set_model' && r.message.params?.modelId === 'gemini-4-hydrogen-medium').length,
      2,
    )
  } finally {
    await runtime.stop()
  }
})

test('GeminiAcpServer survives post-close ENOTEMPTY chunk flushes and recovers cleanly from dead stdin pipes (EPIPE)', async () => {
  const preCount = readRecords().length
  const server = new GeminiAcpServer(receipts)
  try {
    // 1. Concurrent chunk writes racing session/cancel + session/close must not throw ENOTEMPTY out of executeTurn
    const cancelController = new AbortController()
    const cancelled = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'flush-chunks-on-cancel' }] },
    }, cancelController.signal, async () => {}, ev => {
      if (ev.threadId) {
        setTimeout(() => cancelController.abort(new Error('Cancelled during chunk flush')), 15)
      }
    })

    assert.equal(cancelled.success, false)
    assert.match(cancelled.error || '', /Cancelled during chunk flush/)

    // Verify rmSync receives maxRetries: 5, retryDelay: 50 and persistent ENOTEMPTY cannot clobber executeTurn result
    const seenRmOptions: fs.RmOptions[] = []
    const originalRmSync = fs.rmSync
    try {
      fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
        if (options) seenRmOptions.push(options)
        if (String(target).includes(`${path.sep}brain${path.sep}`)) {
          throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(target)}'`), {
            code: 'ENOTEMPTY',
          })
        }
        return originalRmSync(target, options)
      }) as typeof fs.rmSync

      const simulatedDir = fs.mkdtempSync(path.join(root, 'agy-purge-sim-'))
      assert.doesNotThrow(() => purgeClosedSessionArtifacts(simulatedDir, 'sim-session'))
      assert.equal(
        seenRmOptions.some(opt => opt.recursive === true && opt.force === true && opt.maxRetries === 5 && opt.retryDelay === 50),
        true,
        'purgeClosedSessionArtifacts must pass recursive, force, maxRetries: 5, retryDelay: 50 to fs.rmSync',
      )

      const turnDuringPersistentBusy = await server.executeTurn({
        model: 'gemini-4-hydrogen-low',
        modelRequest: { messages: [{ role: 'user', content: 'Turn with busy brain dir' }] },
      }, new AbortController().signal, async () => {}, () => {})
      assert.equal(turnDuringPersistentBusy.success, true)
      assert.equal(turnDuringPersistentBusy.output, 'Warm reply: Turn with busy brain dir')
    } finally {
      fs.rmSync = originalRmSync
    }

    assert.equal(
      readRecords().slice(preCount).filter(r => r.boot).length,
      1,
      'Post-close artifact cleanup races must keep the warm ACP daemon alive',
    )

    // 2. Dead pipe (EPIPE when child closes fd 0 without exiting) tears down broken daemon and spawns fresh daemon on next turn
    const pipeCancel = new AbortController()
    const pipeFailed = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'break-stdin-pipe' }] },
    }, pipeCancel.signal, async () => {}, ev => {
      if (ev.threadId) {
        setTimeout(() => pipeCancel.abort(new Error('Cancel broken pipe turn')), 20)
      }
    })
    assert.equal(pipeFailed.success, false)

    const recoveredAfterEpipe = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'After EPIPE' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(recoveredAfterEpipe.success, true)
    assert.equal(recoveredAfterEpipe.output, 'Warm reply: After EPIPE')
    assert.equal(
      readRecords().slice(preCount).filter(r => r.boot).length,
      2,
      'Broken stdin pipe must tear down the broken daemon and boot a fresh daemon on the next turn',
    )

    // 3. Destroyed parent stdin stream before next turn is detected and replaced cleanly without write-after-destroy errors
    const activeDaemon = (server as any).daemon
    assert.ok(activeDaemon)
    activeDaemon.child.stdin.destroy()

    const recoveredAfterDestroy = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: { messages: [{ role: 'user', content: 'After stdin destroy' }] },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(recoveredAfterDestroy.success, true)
    assert.equal(recoveredAfterDestroy.output, 'Warm reply: After stdin destroy')
    assert.equal(
      readRecords().slice(preCount).filter(r => r.boot).length,
      3,
      'Destroyed stdin stream must spawn a fresh daemon on the next turn',
    )
  } finally {
    await server.stop()
  }
  assert.deepEqual(fs.readdirSync(receipts), [], 'All daemon process receipts must be released after EPIPE/destroy recovery and stop')
})

test('GeminiAcpServer attaches native _meta.antigravity.systemPrompt.append with disableBuiltInTools on pure turns with system messages or responseInstructions while keeping bare turns on warmSessions', async () => {
  const server = new GeminiAcpServer(receipts)
  try {
    await server.warmup({ model: 'gemini-4-hydrogen-low' })
    const preBareCount = readRecords().length

    const bareTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [{ role: 'user', content: 'Bare single user turn' }],
      },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(bareTurn.success, true)
    assert.equal(bareTurn.output, 'Warm reply: Bare single user turn')

    const bareRecords = readRecords().slice(preBareCount)
    assert.equal(
      bareRecords[0]?.message?.method,
      'session/prompt',
      'Pure turn without system blocks must claim from pre-warmed session pool',
    )
    assert.deepEqual(
      bareRecords[0]?.message?.params?.prompt,
      [{ type: 'text', text: 'Bare single user turn' }],
    )

    const preStructuredCount = readRecords().length
    const systemAndSchemaTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [
          { role: 'system', content: 'Pure system context.' },
          { role: 'user', content: 'Structured assessment payload' },
        ],
        responseInstructions: 'Return JSON matching required boolean fields.',
      },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(systemAndSchemaTurn.success, true)
    assert.equal(systemAndSchemaTurn.output, 'Warm reply: Structured assessment payload')

    const schemaOnlyTurn = await server.executeTurn({
      model: 'gemini-4-hydrogen-low',
      modelRequest: {
        messages: [{ role: 'user', content: 'Large user context payload' }],
        responseInstructions: 'Return JSON only.',
      },
    }, new AbortController().signal, async () => {}, () => {})
    assert.equal(schemaOnlyTurn.success, true)
    assert.equal(schemaOnlyTurn.output, 'Warm reply: Large user context payload')

    const structuredRecords = readRecords().slice(preStructuredCount)
    const daemonTempRoot = (server as any).daemon?.tempRoot
    assert.ok(daemonTempRoot)

    const systemAndSchemaNew = structuredRecords.find(r =>
      r.message?.method === 'session/new'
      && r.message.params?._meta?.antigravity?.systemPrompt?.append?.includes('Pure system context.')
    )
    assert.ok(systemAndSchemaNew, 'Pure turn with system + responseInstructions must create session/new with native systemPrompt.append')
    assert.equal(systemAndSchemaNew.message.params.cwd, daemonTempRoot)
    assert.deepEqual(systemAndSchemaNew.message.params.mcpServers, [])
    assert.deepEqual(systemAndSchemaNew.message.params._meta, {
      antigravity: {
        disableBuiltInTools: true,
        systemPrompt: {
          append: 'Pure system context.\n\nReturn JSON matching required boolean fields.',
        },
      },
    })

    const setModelCalls = structuredRecords.filter(r =>
      r.message?.method === 'session/set_model'
      && r.message.params?.sessionId === systemAndSchemaTurn.metadata?.threadId
    )
    assert.equal(setModelCalls.length, 1, 'Pure session with systemPrompt must call session/set_model exactly once')
    assert.equal(setModelCalls[0].message.params.modelId, 'gemini-4-hydrogen-low')

    const systemAndSchemaPrompt = structuredRecords.find(r =>
      r.message?.method === 'session/prompt'
      && r.message.params.sessionId === systemAndSchemaTurn.metadata?.threadId
    )
    assert.deepEqual(
      systemAndSchemaPrompt?.message.params.prompt,
      [{ type: 'text', text: 'Structured assessment payload' }],
      'User promptBlocks must contain clean user text without [System]: or [User]: role-prefix hacks',
    )

    const schemaOnlyNew = structuredRecords.find(r =>
      r.message?.method === 'session/new'
      && r.message.params?._meta?.antigravity?.systemPrompt?.append === 'Return JSON only.'
    )
    assert.ok(schemaOnlyNew, 'Pure turn with responseInstructions only must pass native systemPrompt.append with disableBuiltInTools')
    assert.equal(schemaOnlyNew.message.params._meta.antigravity.disableBuiltInTools, true)

    const schemaOnlyPrompt = structuredRecords.find(r =>
      r.message?.method === 'session/prompt'
      && r.message.params.sessionId === schemaOnlyTurn.metadata?.threadId
    )
    assert.deepEqual(
      schemaOnlyPrompt?.message.params.prompt,
      [{ type: 'text', text: 'Large user context payload' }],
    )

    assert.equal(
      fs.readdirSync(terminalJobs).some(name => name.startsWith('metahuman-gemini-turn-')),
      false,
      'Pure turns with systemBlocks must reuse daemon.tempRoot without allocating per-turn temp directories',
    )
  } finally {
    await server.stop()
  }
})
