import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-terminal-service-'))
process.env.METAHUMAN_ROOT = root
fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
fs.writeFileSync(path.join(root, 'codex-calls.jsonl'), '')
fs.writeFileSync(path.join(root, 'etc', 'agents.json'), JSON.stringify({ agents: {} }))
const executable = path.join(root, 'provider.cjs')
fs.writeFileSync(executable, `#!/usr/bin/env node
let prompt = '';
if (process.argv.includes('app-server')) {
  const messages=[];
  require('readline').createInterface({input:process.stdin}).on('line', line=>{
    const message=JSON.parse(line);messages.push(message);
    const reply = result => console.log(JSON.stringify({id:message.id,result}));
    if(message.method==='initialize') reply({userAgent:'fixture'});
    if(message.method==='thread/start') reply({thread:{id:'fixture-native-thread'}});
    if(message.method==='thread/inject_items') reply({});
    if(message.method==='turn/start') {
      require('fs').appendFileSync(${JSON.stringify(path.join(root, 'codex-calls.jsonl'))}, JSON.stringify({args:process.argv.slice(2),messages})+'\\n');
      reply({turn:{id:'native-turn',status:'inProgress',items:[]}});
      const item={type:'agentMessage',id:'native-answer',phase:'final_answer',text:'{"reply":"native model result"}'};
      console.log(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'fixture-native-thread',turnId:'native-turn',itemId:item.id,delta:item.text}}));
      console.log(JSON.stringify({method:'item/completed',params:{threadId:'fixture-native-thread',turnId:'native-turn',item}}));
      console.log(JSON.stringify({method:'turn/completed',params:{threadId:'fixture-native-thread',turn:{id:'native-turn',status:'completed',items:[item]}}}));
    }
  });
} else {
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  if (process.argv.includes('exec')) {
    require('fs').appendFileSync(${JSON.stringify(path.join(root, 'codex-calls.jsonl'))}, JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-diagnostic-thread'}));
    if (prompt.includes('hold-diagnostic')) return setInterval(() => {}, 1000);
    return setTimeout(() => {
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'diagnostic fixture result'}}));
      process.exit(prompt.includes('fail-diagnostic') ? 1 : 0);
    }, 150);
  }
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'fixture response'}]}}));
  if (prompt.includes('wait')) setInterval(() => {}, 1000);
});
}
`, { mode: 0o700 })
const desktopBin = path.join(root, 'desktop-bin')
fs.mkdirSync(desktopBin)
fs.writeFileSync(path.join(desktopBin, 'x-terminal-emulator'), `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(path.join(root, 'desktop-calls.jsonl'))}, JSON.stringify(process.argv.slice(2))+'\\n');
process.on('SIGUSR1', () => { process.stderr.write('fixture desktop failed\\n'); process.exit(23); });
setInterval(() => {}, 1000);
`, { mode: 0o700 })
fs.writeFileSync(path.join(root, 'etc', 'tool-executor.json'), JSON.stringify({ backends: {
  'claude-code': { enabled: true, command: executable, args: [], timeout: 15000 },
  codex: { enabled: true, command: executable, args: [], timeout: 15000 },
} }))
fs.writeFileSync(path.join(root, 'etc', 'services.json'), JSON.stringify({ services: { terminal: {
  id: 'terminal', enabled: true, type: 'manual', agentPath: 'services/terminal.ts', startOnSystemBoot: false, autoRestart: false,
} } }))
fs.mkdirSync(path.join(root, 'brain', 'services'), { recursive: true })
fs.writeFileSync(path.join(root, 'brain', 'services', 'terminal.ts'), "export { runTerminalService as default } from '@metahuman/core/terminal/service'\n")
fs.symlinkSync(path.join(repo, 'packages'), path.join(root, 'packages'), 'dir')
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
const client = await import('./client.js')
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { terminalSocket, terminalReceipts } = await import('./paths.js')
const { defaultAgentCatalogEntry } = await import('../agent-monitor-descriptors.js')
const script = path.join(root, 'run.mjs')
fs.writeFileSync(script, `import { eventBus } from ${JSON.stringify(new URL('../infrastructure/event-bus/client.ts', import.meta.url).href)}; eventBus.disconnect(); const { runTerminalService } = await import(${JSON.stringify(new URL('./service.ts', import.meta.url).href)}); await runTerminalService();`)
let service: ReturnType<typeof spawn> | undefined
let diagnostics = ''
const env: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/bash', PATH: `${desktopBin}:${process.env.PATH}` }
delete env.NODE_TEST_CONTEXT
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) { if (await check()) return; await delay(25) }
  assert.fail(`Service evidence timed out: ${diagnostics}`)
}
async function launch() {
  service = spawn(process.execPath, ['--import', 'tsx', script], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  service.stdout!.on('data', chunk => diagnostics += chunk)
  service.stderr!.on('data', chunk => diagnostics += chunk)
  service.on('error', error => { diagnostics += error.message })
  await eventually(async () => (await client.getTerminalState()).status === 'running')
}
async function waitForExit() { await eventually(() => service?.exitCode !== null || service?.signalCode !== null) }
function terminalAudit(event: string, sessionId: string) {
  const directory = path.join(root, 'logs', 'audit')
  return fs.readdirSync(directory).flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n'))
    .map(line => JSON.parse(line)).filter(entry => entry.event === event && entry.details?.sessionId === sessionId)
}

test.after(async () => {
  try { await client.stopTerminalService() } finally {
    if (service?.exitCode === null && service.signalCode === null) { service.kill('SIGTERM'); await waitForExit() }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('service is off on import and catalog registration is on-demand', async () => {
  assert.deepEqual(await client.getTerminalState(), { status: 'stopped', sessions: [] })
  const registration = defaultAgentCatalogEntry('terminal', 'service')
  assert.equal(registration.startOnSystemBoot, false)
  assert.equal(registration.autoRestart, false)
  await assert.rejects(client.terminalCall('/create', { kind: 'shell' }), /Terminal agent is stopped/)
  assert.equal(fs.existsSync(terminalSocket), false)
})

test('private service retains sessions across stream disconnects and preserves screen order', async () => {
  await launch()
  assert.equal(fs.statSync(terminalSocket).mode & 0o777, 0o600)
  assert.deepEqual((await client.getTerminalState()).sessions, [])
  const session = await client.terminalCall<{ id: string }>('/create', { kind: 'shell' })
  const first = await client.terminalRequest(`/events?id=${session.id}`)
  first.destroy()
  await client.terminalCall('/input', { id: session.id, data: "printf '\\033[2J\\033[Hreconnected-screen'\n" })
  await delay(100)
  const second = await client.terminalRequest(`/events?id=${session.id}`)
  second.setEncoding('utf8')
  let data = ''
  for await (const chunk of second) { data += chunk; if (data.includes('reconnected-screen')) break }
  second.destroy()
  assert.match(data, /"type":"screen"/)
  assert.equal((await client.getTerminalState()).sessions.length, 1)
  await client.terminalCall('/close', { id: session.id })
  assert.deepEqual((await client.getTerminalState()).sessions, [])
})

test('provider calls overlap with independent results and targeted cancellation', async () => {
  const work = client.executeInBigBrotherSession('claude-code', 'wait')
  await eventually(async () => (await client.getBigBrotherSessionState()).processRunning)
  const first = (await client.getBigBrotherSessionState()).id!
  const visibility = await client.terminalRequest('/events')
  visibility.destroy()
  const second = await client.executeInBigBrotherSession('codex', 'second')
  assert.equal(second.success, true, second.error)
  assert.equal(second.output, 'diagnostic fixture result')
  assert.equal((await client.getBigBrotherSessionState()).id, first)
  assert.equal((await client.getBigBrotherSessionState()).processRunning, true)
  const third = client.executeInBigBrotherSession('claude-code', 'wait-third')
  await eventually(async () => (await client.getTerminalState()).sessions.filter(s => s.phase === 'running').length === 2)
  await client.terminalCall('/close', { id: first })
  assert.equal((await client.getBigBrotherSessionState()).processRunning, true, 'closing one call does not cancel its sibling')
  await client.stopBigBrotherSession()
  const result = await work
  assert.equal(result.success, false)
  assert.match(result.error || '', /closed/)
  assert.equal((await third).success, false)
  assert.deepEqual((await client.getTerminalState()).sessions, [])
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
})

test('graph messages retain native roles through the private terminal service and return final JSON', async () => {
  const chunks: string[] = []
  const result = await client.executeInBigBrotherSession('codex', '', {
    modelRequest: { messages: [
      { role: 'system', content: 'Original graph instructions' },
      { role: 'user', content: 'Previous request' },
      { role: 'assistant', content: 'Previous reply' },
      { role: 'user', content: 'Current request' },
    ], contextWindow: 872000 }, enableThinking: false, onChunk: text => chunks.push(text),
  })
  assert.equal(result.success, true, result.error)
  assert.deepEqual(JSON.parse(result.output), { reply: 'native model result' })
  assert.ok(chunks.join('').includes('native model result'))
  const call = JSON.parse(fs.readFileSync(path.join(root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').at(-1)!)
  assert.equal(call.args[0], 'app-server')
  assert.ok(call.args.includes('model_context_window=872000'))
  assert.equal(call.messages.find((message: any) => message.method === 'thread/start').params.baseInstructions, 'Original graph instructions')
  assert.deepEqual(call.messages.find((message: any) => message.method === 'thread/inject_items').params.items.map((item: any) => item.role), ['user', 'assistant', 'user'])
  assert.deepEqual(call.messages.at(-1).params.input, [])
  assert.equal(call.messages.at(-1).params.effort, 'none')
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  await client.stopBigBrotherSession()
})

test('stream authentication is revoked after logout without terminating the shell', async () => {
  const { createSession, deleteSession } = await import('../sessions.js')
  const { handleTerminalEvents } = await import('../api/handlers/terminal.js')
  const auth = createSession('terminal-test-owner', 'owner')
  const terminal = await client.terminalCall<{ id: string }>('/create', { kind: 'shell' })
  const abort = new AbortController()
  const response = await handleTerminalEvents({ path: '/api/terminal/events', method: 'GET',
    user: { userId: auth.userId, username: 'terminal-test-owner', role: 'owner', isAuthenticated: true },
    sessionId: auth.id, query: { id: terminal.id }, signal: abort.signal })
  assert.equal(response.status, 200)
  const iterator = response.stream![Symbol.asyncIterator]()
  await iterator.next()
  deleteSession(auth.id)
  await client.terminalCall('/input', { id: terminal.id, data: "printf 'revoked-session-check\\n'\n" })
  const next = await iterator.next()
  assert.match(next.value || '', /access expired/)
  assert.equal((await iterator.next()).done, true)
  assert.equal((await client.getTerminalState()).sessions.some(item => item.id === terminal.id), true)
  await client.terminalCall('/close', { id: terminal.id })
})

test('provider completes without a browser and cancellation/timeout keep the sole owner', async () => {
  const result = await client.executeInBigBrotherSession('claude-code', 'complete')
  assert.equal(result.success, true, result.error)
  assert.equal(result.output, 'fixture response')
  const timed = await client.executeInBigBrotherSession('claude-code', 'wait', { timeout: 100 })
  assert.equal(timed.success, false)
  assert.match(timed.error || '', /Timed out/)
  const abort = new AbortController()
  const work = client.executeInBigBrotherSession('claude-code', 'wait', { signal: abort.signal })
  const rejected = assert.rejects(work, /aborted/)
  await eventually(async () => (await client.getBigBrotherSessionState()).processRunning)
  abort.abort()
  await rejected
  await eventually(async () => !(await client.getBigBrotherSessionState()).processRunning)
  await client.stopBigBrotherSession()
})

test('SIGTERM stops children, restart starts empty, and explicit stop exits', async () => {
  await client.terminalCall('/create', { kind: 'shell' })
  service!.kill('SIGTERM')
  await waitForExit()
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  assert.equal((await client.getTerminalState()).status, 'stopped')
  await launch()
  assert.deepEqual((await client.getTerminalState()).sessions, [])
  await client.stopTerminalService()
  await waitForExit()
  assert.equal(fs.existsSync(terminalSocket), false)
})

test('offline stop recovers the saved sessions after the agent is killed', async () => {
  await launch()
  await client.terminalCall('/create', { kind: 'shell' })
  service!.kill('SIGKILL')
  await waitForExit()
  assert.ok(fs.readdirSync(terminalReceipts).length > 0)
  await client.stopTerminalService()
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  assert.equal(fs.existsSync(terminalSocket), false)
})

test('missing provider executable returns a failure and releases admission without an unhandled error', async () => {
  await launch()
  fs.renameSync(executable, `${executable}.saved`)
  try {
    const result = await client.executeInBigBrotherSession('claude-code', 'complete')
    assert.equal(result.success, false)
    assert.match(result.error || '', /ENOENT/)
    await client.stopBigBrotherSession()
  } finally { fs.renameSync(`${executable}.saved`, executable) }
  assert.equal((await client.executeInBigBrotherSession('claude-code', 'complete')).success, true)
  await client.stopTerminalService()
  await waitForExit()
})

test('Agent Monitor launcher starts the same service and stop removes its registry ownership', async () => {
  const state = await client.startTerminalService('test')
  assert.equal(state.status, 'running')
  await client.stopTerminalService()
  await eventually(() => !fs.existsSync(terminalSocket))
  const { isAgentRunning } = await import('../agent-monitor-registry.js')
  assert.equal(isAgentRunning('terminal'), false)
})

test('Big Brother starts the canonical service on demand and works again after a service stop', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await client.getTerminalState()).status, 'stopped');
    const result = await client.executeInBigBrotherSession('claude-code', 'complete');
    assert.equal(result.success, true, result.error);
    assert.equal(result.output, 'fixture response');
    assert.equal((await client.getTerminalState()).status, 'running');
    await client.stopTerminalService();
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.executeInBigBrotherSession('claude-code', 'complete', { signal: abort.signal }), /aborted/);
  assert.equal((await client.getTerminalState()).status, 'stopped');
});

test('diagnostic node opens one desktop, queues reports, resumes the exact thread and keeps chat separate', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  const previousCalls = fs.readFileSync(path.join(root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
  const { bigBrotherNode } = await import('../nodes/utility/big-brother.node.js')
  const first = await bigBrotherNode.execute({ data: { error: 'first diagnostic' }, data2: false },
    { username: 'fixture', userMessage: 'fixture request',
      graphNode: { id: '31', inputs: [{ source: { id: '17', label: 'User Input' } }] } },
    { model: 'fixture-model' })
  const second = await client.submitBigBrotherDiagnostic({ prompt: 'fixture', data: 'second diagnostic', username: 'fixture', reasoning: false, model: 'fixture-model-2' })
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(first.status, 'submitted')
  await eventually(async () => {
    const session = (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)
    return session?.phase === 'completed' && session.diagnostic?.submissionId === second.submissionId && session.diagnostic.pending === 0
  })
  const calls = fs.readFileSync(path.join(root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').slice(previousCalls).map(line => JSON.parse(line))
  assert.equal(calls.length, 2)
  assert.match(calls[0].prompt, /"data2": false/)
  assert.match(calls[0].prompt, /"label": "User Input"/)
  assert.match(calls[0].prompt, /"originalRequest": "fixture request"/)
  assert.match(calls[0].prompt, /graph-traces\.ndjson/)
  assert.ok(calls[0].args.includes('model_reasoning_effort="high"'), 'node defaults to high reasoning')
  assert.ok(calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'fixture-model')
  assert.ok(calls[1].args.includes('resume'))
  assert.equal(calls[1].args[calls[1].args.indexOf('resume') + 1], 'fixture-diagnostic-thread')
  assert.equal(calls[1].args.includes('--last'), false)
  assert.equal(calls[1].args.includes('model_reasoning_effort="high"'), false)
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'fixture-model-2')
  const desktopCalls = fs.readFileSync(path.join(root, 'desktop-calls.jsonl'), 'utf8').trim().split('\n')
  assert.equal(desktopCalls.length, 1)
  assert.ok(desktopCalls[0].includes('terminal'))
  const state = (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)!
  const log = fs.readFileSync(state.diagnostic!.repairLog, 'utf8')
  assert.ok(log.includes(first.submissionId))
  assert.ok(log.includes(second.submissionId))
  assert.match(log, /diagnostic fixture result/)
  assert.equal(log.includes('\x1b['), false, 'Terminal styling must not enter saved agent results')
  const screen = await client.terminalRequest(`/events?id=${first.sessionId}`)
  screen.setEncoding('utf8')
  let frames = ''
  try {
    for await (const chunk of screen) {
      frames += chunk
      if (frames.includes('"type":"screen"') && frames.endsWith('\n\n')) break
    }
  } finally { screen.destroy() }
  const snapshot = frames.split('\n\n').filter(frame => frame.startsWith('data: '))
    .map(frame => JSON.parse(frame.slice(6))).find(event => event.type === 'screen')
  assert.match(snapshot.data, /\x1b\[/, 'Connected viewers receive styled output')
  assert.match(snapshot.data, /diagnostic fixture result/)
  const chat = await client.executeInBigBrotherSession('claude-code', 'complete')
  assert.equal(chat.success, true)
  await client.stopBigBrotherSession()
  assert.ok((await client.getTerminalState()).sessions.some(s => s.id === first.sessionId))
  await client.terminalCall('/diagnostic-input', { id: first.sessionId, message: 'operator followup' })
  await eventually(async () => (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)?.phase === 'completed')
  await client.terminalCall('/close', { id: first.sessionId })
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  await client.stopTerminalService()
  await waitForExit()
})

test('diagnostic failures remain visible, new reports resume, and closing cancels active and pending work', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  const request = { prompt: 'fixture', data: 'fail-diagnostic', reasoning: true }
  const first = await client.submitBigBrotherDiagnostic(request)
  await eventually(async () => (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)?.phase === 'failed')
  const failed = (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)!
  assert.match(failed.error || '', /code 1/)
  const second = await client.submitBigBrotherDiagnostic({ ...request, data: 'hold-diagnostic' })
  await eventually(async () => (await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)?.phase === 'running')
  const ordinary = await client.executeInBigBrotherSession('claude-code', 'complete')
  assert.equal(ordinary.success, true, 'model calls do not wait for an independent diagnostic thread')
  await client.stopBigBrotherSession()
  assert.equal((await client.getTerminalState()).sessions.find(s => s.id === first.sessionId)?.phase, 'running')
  const pending = await client.submitBigBrotherDiagnostic({ ...request, data: 'pending-diagnostic' })
  assert.equal(second.sessionId, first.sessionId)
  await client.terminalCall('/close', { id: first.sessionId })
  const log = fs.readFileSync(failed.diagnostic!.repairLog, 'utf8')
  assert.match(log, /agent turn failed/)
  assert.ok(log.includes(`${pending.submissionId} · cancelled`))
  assert.deepEqual((await client.getTerminalState()).sessions, [])
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  await client.stopTerminalService()
  await waitForExit()
})

test('tool work returns Codex output through a desktop session separate from diagnostics', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  for (const session of (await client.getTerminalState()).sessions) await client.terminalCall('/close', { id: session.id })
  const diagnostic = await client.submitBigBrotherDiagnostic({ prompt: 'fixture diagnostic', data: 'original repair', reasoning: true, username: 'fixture' })
  const first = await client.executeBigBrotherTool({ prompt: 'fixture tool', data: { request: 'Inspect the fixture' },
    username: 'fixture', toolTaskId: 'tool-one', model: 'fixture-tool-model', reasoning: true })
  assert.equal(first.success, true)
  assert.equal(first.output, 'diagnostic fixture result')
  const state = await client.getTerminalState()
  assert.ok(state.sessions.find(s => s.id === diagnostic.sessionId))
  const tool = state.sessions.find(s => s.title === 'Big Brother Tools')!
  assert.ok(tool)
  assert.notEqual(tool.id, diagnostic.sessionId)
  const calls = fs.readFileSync(path.join(root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const execution = calls.slice().reverse().find(call => call.prompt.includes('tool-one'))
  assert.equal(execution.args.includes('resume'), false, 'Tool work cannot inherit an unrelated diagnostic thread')
  assert.ok(execution.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(execution.args.includes('model_reasoning_effort="high"'))
  assert.equal(execution.args[execution.args.indexOf('--model') + 1], 'fixture-tool-model')
  assert.equal(execution.prompt.includes('repairLog'), false)
  const failed = await client.executeBigBrotherTool({ prompt: 'fixture tool', data: 'fail-diagnostic', reasoning: false, toolTaskId: 'tool-two' })
  assert.equal(failed.success, false)
  assert.ok(failed.error)
  for (const session of (await client.getTerminalState()).sessions) await client.terminalCall('/close', { id: session.id })
})

test('closing the tool terminal settles its waiting caller and cancels owned work', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  const work = client.executeBigBrotherTool({ prompt: 'fixture tool', data: 'hold-diagnostic', reasoning: true, toolTaskId: 'tool-cancel' })
  await eventually(async () => (await client.getTerminalState()).sessions.some(s => s.title === 'Big Brother Tools' && s.phase === 'running'))
  const session = (await client.getTerminalState()).sessions.find(s => s.title === 'Big Brother Tools')!
  await client.terminalCall('/close', { id: session.id })
  const result = await work
  assert.equal(result.success, false)
  assert.match(result.error || '', /closed/)
})

test('native terminal viewer keeps tool work alive across ordinary model calls and closes its own work', async t => {
  await launch()
  const work = client.executeBigBrotherTool({ prompt: 'fixture tool', data: 'hold-diagnostic', reasoning: true, toolTaskId: 'native-viewer' })
  await eventually(async () => (await client.getTerminalState()).sessions.some(s => s.title === 'Big Brother Tools' && s.phase === 'running'))
  const session = (await client.getTerminalState()).sessions.find(s => s.title === 'Big Brother Tools')!
  const viewer = pty.spawn(path.join(repo, 'bin', 'mh'), ['terminal', 'view', session.id], {
    cwd: repo, env: env as Record<string, string>, cols: 100, rows: 30, name: 'xterm-256color',
  })
  let output = ''
  let viewerExit: number | undefined
  viewer.onData(chunk => { output += chunk })
  viewer.onExit(({ exitCode }) => { viewerExit = exitCode })
  t.after(async () => {
    if (viewerExit === undefined) viewer.kill('SIGTERM')
    await client.stopTerminalService()
    await work
    await waitForExit()
  })
  await eventually(() => output.includes('Big Brother · Codex diagnostics') || viewerExit !== undefined)
  assert.equal(viewerExit, undefined, output)
  for (let iteration = 0; iteration < 3; iteration++) {
    const replies = await Promise.all([
      client.executeInBigBrotherSession('claude-code', 'complete'),
      client.executeInBigBrotherSession('claude-code', 'complete'),
    ])
    assert.ok(replies.every(reply => reply.success))
    await client.stopBigBrotherSession()
    assert.equal((await client.getTerminalState()).sessions.find(s => s.id === session.id)?.phase, 'running', output)
  }
  assert.equal(viewerExit, undefined, output)
  assert.equal((await client.getTerminalState()).sessions.find(s => s.id === session.id)?.phase, 'running', output)
  viewer.write('\x04')
  const result = await work
  assert.equal(result.success, false)
  assert.match(result.error || '', /diagnostic terminal closed/)
  await eventually(() => viewerExit !== undefined)
  await eventually(async () => !(await client.getTerminalState()).sessions.some(s => s.id === session.id))
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  const closures = terminalAudit('big_brother_terminal_view_closed', session.id)
  assert.equal(closures.length, 1)
  assert.equal(closures[0].details.cause, 'input_closed')
  assert.equal(closures[0].details.viewerPid > 0, true)
})

test('desktop failure preserves its actual exit evidence after tool session removal', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  for (const signal of ['SIGUSR1', 'SIGTERM'] as const) {
    const taskId = 'desktop-exit-' + signal
    const work = client.executeBigBrotherTool({ prompt: 'fixture tool', data: 'hold-diagnostic', reasoning: true, toolTaskId: taskId })
    await eventually(async () => (await client.getTerminalState()).sessions.some(s => s.title === 'Big Brother Tools' && s.phase === 'running'))
    const session = (await client.getTerminalState()).sessions.find(s => s.title === 'Big Brother Tools')!
    await eventually(() => fs.readFileSync(path.join(root, 'codex-calls.jsonl'), 'utf8').includes(taskId))
    const desktopPid = fs.readdirSync(terminalReceipts).map(file => Number(path.basename(file, '.json')))
      .find(pid => fs.existsSync('/proc/' + pid + '/cmdline') && fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(path.join(desktopBin, 'x-terminal-emulator')))
    assert.ok(desktopPid)
    process.kill(desktopPid, signal)
    const result = await work
    assert.equal(result.success, false)
    assert.match(result.error || '', /diagnostic terminal closed/)
    await eventually(async () => !(await client.getTerminalState()).sessions.some(s => s.id === session.id))
    const exits = terminalAudit('big_brother_desktop_exited', session.id)
    assert.equal(exits.length, 1)
    assert.equal(exits[0].details.taskId, taskId)
    assert.equal(exits[0].details.ownerClosing, false)
    assert.equal(exits[0].details.exitCode, signal === 'SIGUSR1' ? 23 : null)
    assert.equal(exits[0].details.signal, signal === 'SIGTERM' ? 'SIGTERM' : null)
    if (signal === 'SIGUSR1') assert.match(exits[0].details.stderr, /fixture desktop failed/)
    assert.deepEqual(fs.readdirSync(terminalReceipts), [])
  }
})

test('viewer reports signal, stream failure and stream end without changing its close request', async () => {
  fs.mkdirSync(path.dirname(terminalSocket), { recursive: true })
  for (const cause of ['signal', 'viewer_error', 'stream_ended'] as const) {
    const id = 'viewer-' + cause
    let stream: http.ServerResponse | undefined
    let closes = 0
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) {
        stream = res
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ type: 'state', state: {
          status: 'running', sessions: [{ id, phase: 'running', diagnostic: { pending: 0 } }],
        } }) + '\n\n')
      } else if (req.url === '/close') {
        closes++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"success":true}')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(terminalSocket, resolve))
    const viewer = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'packages/cli/src/entry.ts'), 'terminal', 'view', id], {
      cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    viewer.stdout.on('data', chunk => { output += chunk })
    viewer.stderr.on('data', chunk => { output += chunk })
    try {
      await eventually(() => output.includes('running · 0 queued') || viewer.exitCode !== null)
      assert.equal(viewer.exitCode, null, output)
      if (cause === 'signal') viewer.kill('SIGHUP')
      else if (cause === 'viewer_error') stream!.destroy()
      else stream!.end()
      await eventually(() => viewer.exitCode !== null)
      assert.equal(closes, 1, output)
      const entries = terminalAudit('big_brother_terminal_view_closed', id)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].details.cause, cause)
      if (cause === 'signal') assert.equal(entries[0].details.signal, 'SIGHUP')
      if (cause === 'viewer_error') {
        assert.equal(entries[0].details.errorCode, 'ECONNRESET')
        assert.ok(entries[0].details.error)
      }
    } finally {
      if (viewer.exitCode === null && viewer.signalCode === null) viewer.kill('SIGTERM')
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})

test('tool caller disconnection retains the abort cause and cleans up only its session', async t => {
  await launch()
  t.after(async () => { await client.stopTerminalService(); await waitForExit() })
  const abort = new AbortController()
  const work = client.executeBigBrotherTool({ prompt: 'fixture tool', data: 'hold-diagnostic', reasoning: true, toolTaskId: 'caller-disconnect' }, abort.signal)
  await eventually(async () => (await client.getTerminalState()).sessions.some(s => s.title === 'Big Brother Tools' && s.phase === 'running'))
  const session = (await client.getTerminalState()).sessions.find(s => s.title === 'Big Brother Tools')!
  abort.abort(new Error('fixture caller cancelled'))
  await assert.rejects(work, /aborted|cancelled/)
  await eventually(async () => !(await client.getTerminalState()).sessions.some(s => s.id === session.id))
  const cancellations = terminalAudit('big_brother_tool_request_cancelled', session.id)
  assert.equal(cancellations.length, 1)
  assert.equal(cancellations[0].details.taskId, 'caller-disconnect')
  assert.equal(cancellations[0].details.reason, 'Terminal request disconnected')
  assert.deepEqual(fs.readdirSync(terminalReceipts), [])
})
