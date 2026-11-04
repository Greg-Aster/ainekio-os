import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { get } from 'svelte/store'
import { projectBufferFeed, replaceBufferSlice } from '../lib/client/buffer-feed.js'
import { useMessages } from '../lib/client/composables/useMessages.js'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const chat = read('./ChatInterface.svelte')
const script = ts.createSourceFile('ChatInterface.ts', chat.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true)
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const names = ['toggleView', 'connectMultipleBufferStreams', 'disconnectAllBufferStreams', 'sendMessage', 'clearChat']
const declarations = script.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => ['selectedViews', 'composeOptions', 'composeTarget'].includes(declaration.name.getText(script))))
const handlers = script.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name!.text))
const routing = script.statements.filter(statement => ts.isLabeledStatement(statement)
  && /^\$:\s*(availableComposeOptions|showComposeSelector|if \(availableComposeOptions)/.test(statement.getText(script)))

function fixture(terminalSelected = false) {
  const streams: Array<{ url: string; closed: boolean; close(): void; onmessage?: (message: { data: string }) => void }> = []
  const sent: string[] = []
  const errors: string[] = []
  let state: vm.Context
  const messagesApi = useMessages({ getMode: () => vm.runInContext("composeTarget ?? 'conversation'", state) })
  const messages = messagesApi.messages
  state = vm.createContext({ Set, terminalSelected, bufferStream: null,
    availableComposeOptions: [], showComposeSelector: false, $isOwner: true,
    document: { hidden: false }, input: '', sendInProgress: false,
    messages, messagesApi, liveConversationMessages: [], replaceBufferSlice,
    thinkingTraceApi: { stop() {} }, reasoningStages: [],
    apiEventSource: (url: string) => { const source = { url, closed: false, close() { this.closed = true } }; streams.push(source); return source },
    terminalChat: { send: async (message: string) => { sent.push(message) } },
    showTransientSystemMessage: (message: string) => errors.push(message),
    reportChatError: async () => {},
    interruptAssistantSpeech: () => { assert.fail('terminal input must not enter the persona/TTS admission path') },
    console: { log() {}, error() {} },
  })
  vm.runInContext(transpile([...declarations, ...handlers].map(statement => statement.getText(script)).join('\n')), state)
  const sync = () => vm.runInContext(transpile(routing.map(statement => statement.getText(script)).join('\n')), state)
  if (terminalSelected) state.toggleView('terminal', true)
  sync()
  state.connectMultipleBufferStreams()
  const snapshot = () => JSON.parse(vm.runInContext('JSON.stringify({ views: [...selectedViews], target: composeTarget, selector: showComposeSelector, choices: availableComposeOptions.map(option => option.target) })', state))
  const toggle = (view: string) => { state.toggleView(view); sync() }
  return { state, streams, sent, errors, messages, sync, snapshot, toggle }
}

test('startup selects only Conversation; all four tabs combine without replacing one another', () => {
  const f = fixture()
  assert.deepEqual(f.snapshot(), { views: ['conversation'], target: 'conversation', selector: false, choices: ['conversation'] })
  f.state.connectMultipleBufferStreams()
  assert.equal(f.streams.at(-1)!.url, '/api/buffer-stream?mode=conversation')
  for (const view of ['inner', 'system', 'terminal']) f.toggle(view)
  assert.deepEqual(f.snapshot().views, ['conversation', 'inner', 'system', 'terminal'])
  assert.equal(f.snapshot().selector, true)
  assert.deepEqual(f.snapshot().choices, ['conversation', 'inner', 'terminal'])
  assert.equal(f.streams.at(-1)!.url, '/api/buffer-stream?mode=conversation,inner,system,terminal,robot')
  assert.ok(f.streams.slice(0, -1).every(source => source.closed), 'view changes replace the one buffer reader')
})

test('single-tab input follows that tab; mixed views preserve a valid chosen destination; System remains read-only', () => {
  const f = fixture()
  f.toggle('terminal')
  vm.runInContext("composeTarget = 'terminal'", f.state); f.sync()
  f.toggle('conversation')
  assert.deepEqual(f.snapshot(), { views: ['terminal'], target: 'terminal', selector: false, choices: ['terminal'] })
  f.toggle('inner')
  assert.equal(f.snapshot().target, 'terminal')
  assert.equal(f.snapshot().selector, true)
  f.toggle('terminal')
  assert.equal(f.snapshot().target, 'inner')
  assert.equal(f.snapshot().selector, false)
  f.toggle('system'); f.toggle('inner')
  assert.deepEqual(f.snapshot(), { views: ['system'], target: null, selector: false, choices: [] })
  f.toggle('system')
  assert.deepEqual(f.snapshot().views, ['system'], 'the original tab owner keeps at least one view selected')
  f.toggle('conversation')
  assert.equal(f.snapshot().target, 'conversation')
  assert.equal(f.snapshot().selector, true)
})

test('initial buffer snapshots and remounts project the same stored mixed history', () => {
  const records = [
    { mode: 'conversation', role: 'user', content: 'persisted conversation', timestamp: 3 },
    { mode: 'inner', role: 'thought', content: 'persisted thought', timestamp: 1 },
    { mode: 'system', role: 'system', content: 'persisted event', timestamp: 4 },
    { mode: 'robot', role: 'robot', content: 'persisted robot result', timestamp: 2 },
    { mode: 'terminal', role: 'assistant', content: 'persisted Big Brother reply', timestamp: 5, meta: { source: 'big-brother' } },
  ]
  for (let mount = 0; mount < 2; mount++) {
    const f = fixture()
    for (const view of ['inner', 'system', 'terminal']) f.toggle(view)
    for (const { mode, ...record } of records) f.streams.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'update', mode, messages: [record] }) })
    assert.deepEqual(projectBufferFeed(get(f.messages), new Set(f.snapshot().views)).map(record => record.content),
      ['persisted thought', 'persisted robot result', 'persisted conversation', 'persisted event', 'persisted Big Brother reply'])
  }
})

test('terminal submits repeated unchanged messages while mixed with Conversation and keeps rejected drafts', async () => {
  const f = fixture(true)
  assert.deepEqual(f.snapshot().views, ['conversation', 'terminal'], 'sidebar Terminal includes its feed without replacing Conversation')
  assert.deepEqual(f.sent, [])
  vm.runInContext("composeTarget = 'terminal'", f.state); f.sync()
  for (const message of ['first request\ncomplete message', 'follow-up']) {
    f.state.input = message
    await f.state.sendMessage()
    assert.equal(f.state.input, '')
    assert.equal(f.state.sendInProgress, false)
  }
  assert.deepEqual(f.sent, ['first request\ncomplete message', 'follow-up'])
  f.state.terminalChat.send = async () => { throw new Error('provider unavailable') }
  f.state.input = 'retained draft'
  await f.state.sendMessage()
  assert.equal(f.state.input, 'retained draft')
  assert.deepEqual(f.errors, ['provider unavailable'])
})

test('single System view has no implicit Conversation write path', async () => {
  const f = fixture()
  f.toggle('system'); f.toggle('conversation')
  f.state.input = 'keep this draft'
  await f.state.sendMessage()
  assert.equal(f.state.input, 'keep this draft')
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.errors, ['The selected view is read-only.'])
})

test('the original template binds the same tab set, routing choices and read-only input without terminal-only selection code', () => {
  assert.match(chat, /\{#if showComposeSelector\}/)
  assert.match(chat, /\{#each availableComposeOptions as option\}/)
  assert.match(chat, /readOnly=\{!composeTarget\}/)
  for (const view of ['conversation', 'inner', 'system', 'terminal']) assert.ok(chat.includes(`toggleView('${view}')`))
  assert.doesNotMatch(chat, /terminalVisible|selectTerminal|hideTerminal|previousTerminalSelected|fetchAllSelectedBuffers|fetchSingleBuffer|TerminalPanel|TerminalView|terminal-split-panel/)
})


test('clearing terminal history uses its existing buffer owner and preserves other selected histories', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (url, options) => {
    requests.push(`${options?.method} ${url}`)
    return new Response(JSON.stringify({ success: true, cleared: true }), { status: 200 })
  }
  try {
    const f = fixture(true)
    vm.runInContext("composeTarget = 'terminal'", f.state); f.sync()
    f.messages.set([
      { role: 'assistant', content: 'keep conversation', timestamp: 1, meta: { bufferSource: 'conversation' } },
      { role: 'assistant', content: 'clear terminal', timestamp: 2, meta: { bufferSource: 'terminal' } },
    ])
    await f.state.clearChat()
    assert.deepEqual(requests, ['DELETE /api/conversation-buffer?mode=terminal'])
    assert.deepEqual(get(f.messages).map(message => message.content), ['keep conversation'])
  } finally { globalThis.fetch = originalFetch }
})
