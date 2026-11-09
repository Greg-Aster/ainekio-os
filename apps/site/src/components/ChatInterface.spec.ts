import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { get } from 'svelte/store'
import { projectBufferFeed, receiveLiveConversation, replaceBufferSlice } from '../lib/client/buffer-feed.js'
import { useMessages } from '../lib/client/composables/useMessages.js'
import { buildConversationParams, buildResponsePipelineRequestBody, responsePipelineCardTypeForReply, parseConversationStreamEvent } from '../lib/client/conversation-transport.js'

const chat = readFileSync(new URL('./ChatInterface.svelte', import.meta.url), 'utf8')
const script = ts.createSourceFile('ChatInterface.ts', chat.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true)
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const names = ['toggleView', 'connectMultipleBufferStreams', 'disconnectAllBufferStreams', 'sendMessage', 'clearChat', 'enqueueUserMessageTask', 'openChatTaskStream', 'showChatError', 'pushComposedInput', 'pushGeneratedResponse', 'stopRequest']
const declarations = script.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => ['selectedViews', 'composeOptions', 'composeTarget'].includes(declaration.name.getText(script))))
const handlers = script.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name!.text))
const terminalSelection = script.statements.find(statement => ts.isLabeledStatement(statement)
  && /^\$:\s*if \(terminalSelected\)/.test(statement.getText(script)))!
const routing = script.statements.filter(statement => ts.isLabeledStatement(statement)
  && /^\$:\s*(availableComposeOptions|showComposeSelector|if \(availableComposeOptions)/.test(statement.getText(script)))

function fixture(terminalSelected = false) {
  const streams: Array<{ url: string; closed: boolean; close(): void; onmessage?: (message: { data: string }) => void }> = []
  const sent: string[] = []
  const errors: string[] = []
  let state: vm.Context
  const messagesApi = useMessages({ getMode: () => vm.runInContext("composeTarget ?? 'conversation'", state) })
  const messages = messagesApi.messages
  state = vm.createContext({ terminalSelected, bufferStream: null,
    availableComposeOptions: [], showComposeSelector: false, $isOwner: true,
    document: { hidden: false }, input: '', sendInProgress: false,
    messages, messagesApi, replaceBufferSlice, receiveLiveConversation,
    liveConversationMessages: [], queuedChatStreams: new Map(), activeChatTaskId: null,
    isComponentMounted: true, loading: false, mode: 'conversation',
    $conversationSessionId: 'original-session', $selectedMessage: null, $currentMode: 'dual', $yoloModeStore: false,
    reasoningDepth: 2, URLSearchParams, EventSource: { CLOSED: 2 },
    buildConversationParams, buildResponsePipelineRequestBody, responsePipelineCardTypeForReply, parseConversationStreamEvent,
    readLlmOptions: () => ({ temperature: 0.7 }),
    activityApi: { signalActivity() {} }, ttsEnabled: false,
    ttsApi: { async ensureAudioUnlocked() {}, prefetchVoiceResources() {} },
    localStorage: { setItem() {} },
    thinkingTraceApi: { stop() {}, setActive() {}, setStatusLabel() {}, setTrace() {}, appendTrace() {} }, reasoningStages: [],
    apiEventSource: (url: string) => { const source = { url, closed: false, close() { this.closed = true } }; streams.push(source); return source },
    terminalChat: { send: async (message: string) => { sent.push(message) } },
    showTransientSystemMessage: (message: string) => errors.push(message),
    reportChatError: async () => {},
    interruptAssistantSpeech: () => { assert.fail('terminal input must not enter the persona/TTS admission path') },
    console: { log() {}, error() {}, warn() {} },
  })
  vm.runInContext(transpile([...declarations, ...handlers].map(statement => statement.getText(script)).join('\n')), state)
  const sync = () => vm.runInContext(transpile(routing.map(statement => statement.getText(script)).join('\n')), state)
  vm.runInContext(transpile(terminalSelection.getText(script)), state)
  sync()
  state.connectMultipleBufferStreams()
  const snapshot = () => JSON.parse(vm.runInContext('JSON.stringify({ views: [...selectedViews], target: composeTarget, selector: showComposeSelector, choices: availableComposeOptions.map(option => option.target) })', state))
  const toggle = (view: string) => { state.toggleView(view); sync() }
  return { state, streams, sent, errors, messages, messagesApi, sync, snapshot, toggle }
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

test('buffer snapshots replace only their source while preserving the other selected histories', () => {
  const records = [
    { mode: 'conversation', role: 'user', content: 'persisted conversation', timestamp: 3 },
    { mode: 'inner', role: 'thought', content: 'persisted thought', timestamp: 1 },
    { mode: 'system', role: 'system', content: 'persisted event', timestamp: 4 },
    { mode: 'robot', role: 'robot', content: 'persisted robot result', timestamp: 2 },
    { mode: 'terminal', role: 'assistant', content: 'persisted Big Brother reply', timestamp: 5, meta: { source: 'big-brother' } },
  ]
  const f = fixture()
  for (const view of ['inner', 'system', 'terminal']) f.toggle(view)
  for (const { mode, ...record } of records) f.streams.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'update', mode, messages: [record] }) })
  const before = get(f.messages)
  assert.deepEqual(before.map(record => record.meta?.bufferSource), ['inner', 'robot', 'conversation', 'system', 'terminal'])
  const update = { type: 'update', mode: 'terminal', messages: [{ role: 'assistant', content: 'latest Big Brother reply', timestamp: 6 }] }
  for (let replay = 0; replay < 2; replay++) f.streams.at(-1)!.onmessage!({ data: JSON.stringify(update) })
  const after = get(f.messages)
  assert.deepEqual(after.filter(record => record.meta?.bufferSource !== 'terminal'),
    before.filter(record => record.meta?.bufferSource !== 'terminal'))
  assert.deepEqual(after.filter(record => record.meta?.bufferSource === 'terminal').map(record => record.content), ['latest Big Brother reply'])
})

test('terminal submits repeated unchanged messages while mixed with Conversation and keeps rejected drafts', async () => {
  const f = fixture(true)
  assert.deepEqual(f.snapshot().views, ['conversation', 'terminal'], 'sidebar Terminal includes its feed without replacing Conversation')
  assert.deepEqual(f.sent, [])
  vm.runInContext("composeTarget = 'terminal'", f.state); f.sync()
  for (const message of ['first request\ncomplete message', 'first request\ncomplete message', 'follow-up']) {
    f.state.input = message
    await f.state.sendMessage()
    assert.equal(f.state.input, '')
    assert.equal(f.state.sendInProgress, false)
  }
  assert.deepEqual(f.sent, ['first request\ncomplete message', 'first request\ncomplete message', 'follow-up'])
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

test('the template binds the shared TerminalChat, tab selection, compose choices and read-only input', () => {
  assert.match(chat, /import TerminalChat from ['"]\.\/terminal\/TerminalChat\.svelte['"];/)
  assert.equal((chat.match(/<TerminalChat\b/g) || []).length, 1)
  assert.match(chat, /\{#if showComposeSelector\}/)
  assert.match(chat, /\{#each availableComposeOptions as option\}/)
  assert.match(chat, /readOnly=\{!composeTarget\}/)
  for (const view of ['conversation', 'inner', 'system', 'terminal']) assert.ok(chat.includes(`toggleView('${view}')`))
})

test('terminal clear uses its buffer owner, preserves other histories and retains messages on failure', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  try {
    for (const status of [200, 500]) {
      globalThis.fetch = async (url, options) => {
        requests.push(`${options?.method} ${url}`)
        return new Response(JSON.stringify(status === 200 ? { success: true, cleared: true } : { error: 'Storage unavailable' }), { status })
      }
      const f = fixture(true)
      vm.runInContext("composeTarget = 'terminal'", f.state); f.sync()
      f.messages.set([
        { role: 'assistant', content: 'keep conversation', timestamp: 1, meta: { bufferSource: 'conversation' } },
        { role: 'assistant', content: 'clear terminal', timestamp: 2, meta: { bufferSource: 'terminal' } },
      ])
      await f.state.clearChat()
      assert.deepEqual(get(f.messages).map(message => message.content),
        status === 200 ? ['keep conversation'] : ['keep conversation', 'clear terminal'])
    }
    assert.deepEqual(requests, Array(2).fill('DELETE /api/conversation-buffer?mode=terminal'))
  } finally { globalThis.fetch = originalFetch }
})


function chatFixture() {
  const f = fixture()
  const admitted: any[] = []
  f.state.interruptAssistantSpeech = async () => {}
  f.state.apiFetch = async (url: string, options: any = {}) => {
    assert.equal(url, '/api/unified-queue', 'Send relies on authenticated admission without duplicate preflights')
    admitted.push(JSON.parse(options.body))
    return Response.json({ success: true, task: { id: `accepted-${admitted.length}` } })
  }
  return { ...f, admitted }
}

for (const route of ['conversation', 'inner', 'focused'] as const) {
  test(`${route} Send captures text, reply and session before awaits and preserves newer drafts and selections`, async () => {
    const f = chatFixture()
    f.state.mode = route === 'inner' ? 'inner' : 'conversation'
    const reply = { role: 'assistant' as const, content: 'Original selected content', timestamp: 1,
      meta: route === 'focused' ? { questionId: 'original-question', isCuriosityQuestion: true } : {} }
    const newerReply = { role: 'assistant' as const, content: 'Newer selected content', timestamp: 2 }
    f.messagesApi.selectMessage(reply, 0); f.state.$selectedMessage = get(f.messagesApi.selectedMessage)
    f.state.input = '  Original submitted input  '
    let release!: () => void
    f.state.interruptAssistantSpeech = () => new Promise<void>(resolve => { release = resolve })
    const pending = f.state.sendMessage()
    assert.equal(f.admitted.length, 0)
    f.state.input = 'Newer draft'
    f.state.$conversationSessionId = 'newer-session'
    f.state.mode = route === 'inner' ? 'conversation' : 'inner'
    f.messagesApi.selectMessage(newerReply, 1); f.state.$selectedMessage = get(f.messagesApi.selectedMessage)
    release(); await pending
    const admitted = f.admitted[0].input
    const request = route === 'focused' ? admitted.responsePipeline : admitted.personaChat
    assert.equal(request.message, 'Original submitted input')
    assert.equal(request.sessionId, 'original-session')
    if (route === 'focused') {
      assert.equal(admitted.kind, 'response-pipeline')
      assert.equal(request.cardData.questionId, 'original-question')
      assert.equal(request.cardData.content, 'Original selected content')
    } else {
      assert.equal(admitted.kind, 'persona-chat')
      assert.equal(request.mode, route)
      assert.equal(request.replyToContent, 'Original selected content')
      assert.equal(request.reasoningDepth, '2')
      assert.deepEqual(JSON.parse(request.llm), { temperature: 0.7 })
    }
    assert.equal(f.state.input, 'Newer draft')
    assert.equal(get(f.messagesApi.selectedMessage), newerReply)
    assert.equal(f.state.sendInProgress, false, 'Admission guard is released while task execution continues')
    assert.equal(get(f.messages).at(-1)?.content, 'Original submitted input', 'Only acknowledged input is echoed')
    assert.equal(f.streams.filter(stream => stream.url.includes('/tasks/')).length, 1)
  })
}

test('failed admission retains the submitted draft and selection, surfaces the actual error and allows another Send', async () => {
  const f = chatFixture()
  const reply = { role: 'assistant' as const, content: 'Question', timestamp: 1 }
  f.messagesApi.selectMessage(reply, 0); f.state.$selectedMessage = get(f.messagesApi.selectedMessage)
  f.state.input = 'Retained rejected input'
  f.state.apiFetch = async () => Response.json({ error: 'Admission rejected' }, { status: 401 })
  await f.state.sendMessage()
  assert.equal(f.state.input, 'Retained rejected input')
  assert.equal(get(f.messagesApi.selectedMessage), reply)
  assert.equal(f.state.sendInProgress, false)
  assert.equal(f.state.loading, false)
  assert.equal(get(f.messages).filter(message => message.role === 'user').length, 0)
  assert.match(get(f.messages).at(-1)!.content, /Admission rejected/)
  f.state.apiFetch = async () => Response.json({ success: true, task: { id: 'accepted-after-rejection' } })
  await f.state.sendMessage()
  assert.equal(f.state.input, '')
  assert.equal(f.state.queuedChatStreams.size, 1)
})

test('late admission after destroy does not reopen a task reader or cancel accepted work', async () => {
  const f = chatFixture()
  let accept!: (response: Response) => void
  f.state.apiFetch = () => new Promise<Response>(resolve => { accept = resolve })
  f.state.input = 'Accepted after close'
  const pending = f.state.sendMessage()
  while (!accept) await Promise.resolve()
  f.state.isComponentMounted = false
  accept(Response.json({ success: true, task: { id: 'late-task' } }))
  await pending
  assert.equal(f.streams.filter(stream => stream.url.includes('/tasks/')).length, 0)
  assert.equal(f.state.queuedChatStreams.size, 0)
})

test('Stop uses the accepted Work task identity and reports cancellation errors without claiming completion', async () => {
  const f = chatFixture(), requests: string[] = []
  f.state.input = 'Long-running work'; await f.state.sendMessage()
  f.state.apiFetch = async (url: string, options: RequestInit) => {
    requests.push(`${options.method} ${url}`)
    return Response.json({ error: 'Cancellation unavailable' }, { status: 500 })
  }
  await f.state.stopRequest()
  assert.deepEqual(requests, ['DELETE /api/unified-queue/tasks/accepted-1'])
  assert.equal(f.state.loading, true)
  assert.equal(f.state.queuedChatStreams.size, 1)
  assert.match(get(f.messages).at(-1)!.content, /Cancellation unavailable/)
})

test('acknowledged clear removes only the target projections; failed clear retains histories and session identity', async () => {
  for (const target of ['conversation', 'inner'] as const) {
    for (const success of [false, true]) {
      const f = fixture()
      vm.runInContext(`composeTarget = '${target}'`, f.state)
      f.messagesApi.conversationSessionId.set('retained-session')
      f.messages.set(['conversation', 'inner'].map(mode => ({ role: 'assistant', content: `${mode} saved`, timestamp: 1, meta: { bufferSource: mode } })))
      f.state.liveConversationMessages = ['conversation', 'inner'].flatMap(mode => [
        { role: 'assistant', content: `${mode} raw`, timestamp: 2, taskId: `${mode}-task`, responseEntry: { mode, id: `${mode}-id` }, meta: { bufferSource: mode } },
        { role: 'assistant', content: `${mode} custom`, timestamp: 3, taskId: `${mode}-custom`, meta: { bufferSource: mode } },
      ])
      f.messagesApi.clearServerBuffer = async () => success
      await f.state.clearChat()
      const projected = projectBufferFeed(get(f.messages), new Set<'conversation' | 'inner'>(['conversation', 'inner']), f.state.liveConversationMessages)
      assert.equal(projected.filter(message => message.meta?.bufferSource === target).length, success ? 0 : 3)
      assert.equal(projected.filter(message => message.meta?.bufferSource !== target).length, 3)
      if (!success) assert.equal(get(f.messagesApi.conversationSessionId), 'retained-session')
    }
  }
})
