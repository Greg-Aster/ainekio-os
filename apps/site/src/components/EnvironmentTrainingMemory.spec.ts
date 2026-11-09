import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compile } from 'svelte/compiler'

const source = readFileSync(new URL('./EnvironmentTrainingMemory.svelte', import.meta.url), 'utf8')
const scriptText = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]
const script = ts.createSourceFile('EnvironmentTrainingMemory.ts', scriptText, ts.ScriptTarget.Latest, true)
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const componentRequire = createRequire(import.meta.url)
const item = (id: string) => ({ id, bank: 'decision', specialist: 'intent', recordedAt: '2026-11-04T12:00:00Z', executionId: `execution-${id}`, preview: `output-${id}`, review: 'pending' })
const detail = (id: string, review: unknown = null, proposal: unknown = null) => ({ candidate: { id, executionId: `execution-${id}`, system: 'Original model instructions', user: 'Original input', observedOutput: `output-${id}` }, review, proposal,
  executionEvidence: { scope: 'Evidence from the same execution; no implied physical completion', events: [{ id: `event-${id}` }], dispatches: [{ id: `dispatch-${id}` }] } })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
type Call = { url: string; options?: RequestInit }

function fixture(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = []
  let mount!: () => void
  let destroy: () => void = () => {}
  const context = vm.createContext({ AbortController, onMount: (callback: () => void) => { mount = callback },
    onDestroy: (callback: () => void) => { destroy = callback },
    apiFetch: (url: string, options?: RequestInit) => { const call = { url, options }; calls.push(call); return respond(call) },
  })
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(script)).join('\n')), context)
  return { calls, mount: () => mount(), destroy: () => destroy(), run: (code: string) => vm.runInContext(code, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) }
}

function renderState(values: Record<string, unknown>): string {
  let component = source
  const offset = source.indexOf(scriptText)
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  for (const node of declarations.reverse()) {
    if (node.initializer && Object.hasOwn(values, node.name.getText(script))) {
      component = component.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[node.name.getText(script)]) + component.slice(offset + node.initializer.end)
    }
  }
  const code = ts.transpileModule(compile(component, { filename: 'EnvironmentTrainingMemory.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const context = vm.createContext({ exports: {}, AbortController, require: (id: string) => id === 'svelte' ? { onMount() {}, onDestroy() {} }
    : id === '../lib/client/api-config' ? { apiFetch() { assert.fail('rendering must not request or review data') } } : componentRequire(id) })
  vm.runInContext(code, context)
  return componentRequire('svelte/server').render(context.exports.default).body
}

test('each mount reads the inventory once and navigation releases its pending read without admitting a review', async () => {
  for (let mount = 0; mount < 3; mount++) {
    let finish!: (response: Response) => void
    const f = fixture(() => new Promise(resolve => { finish = resolve }))
    f.mount()
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, '/api/environment-training')
    f.destroy()
    assert.equal(f.calls[0].options?.signal?.aborted, true)
    finish(json({ items: [item('a')] }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.snapshot('items'), [])
    assert.equal(f.snapshot('error'), '')
    assert.equal(f.calls.length, 1)
  }
})

test('out-of-order detail replies and errors cannot replace a newer selection or its draft', async () => {
  for (const rejectOlder of [false, true]) {
    let finishOlder!: (response: Response) => void
    const f = fixture(call => call.url.endsWith('id=a') ? new Promise(resolve => { finishOlder = resolve }) : json(detail('b')))
    const older = f.run(`select(${JSON.stringify(item('a'))})`)
    await f.run(`select(${JSON.stringify(item('b'))})`)
    f.run("reason = 'Draft for b'")
    finishOlder(rejectOlder ? json({ error: 'Old selection failed' }, 500) : json(detail('a')))
    await older
    assert.equal(f.snapshot('selected.id'), 'b')
    assert.equal(f.snapshot('detail.candidate.id'), 'b')
    assert.equal(f.snapshot('reason'), 'Draft for b')
    assert.equal(f.snapshot('error'), '')
    assert.equal(f.calls[0].options?.signal?.aborted, true)
  }
})

test('the latest read wins even when the same list item is selected twice', async () => {
  const replies: Array<(response: Response) => void> = []
  const f = fixture(() => new Promise(resolve => replies.push(resolve)))
  f.run(`items = [${JSON.stringify(item('a'))}]`)
  const first = f.run('select(items[0])')
  const second = f.run('select(items[0])')
  replies[1](json(detail('a', { decision: 'reject', reason: 'Latest review' })))
  await second
  replies[0](json(detail('a', { decision: 'accept', reason: 'Older review' })))
  await first
  assert.equal(f.snapshot('decision'), 'reject')
  assert.equal(f.snapshot('reason'), 'Latest review')
})

test('saving a review preserves a newer selected record and edits made while the write is pending', async () => {
  for (const nextId of ['a', 'b']) {
    let finishWrite!: (response: Response) => void
    const f = fixture(call => call.options?.method === 'POST' ? new Promise(resolve => { finishWrite = resolve })
      : call.url.includes('id=') ? json(detail(call.url.endsWith('id=b') ? 'b' : 'a')) : json({ items: [item('a'), item('b')] }))
    await f.run(`select(${JSON.stringify(item('a'))})`)
    f.run("reason = 'Approved a'; decision = 'correct'; correctedOutput = '{\"approved\":true}'")
    const pending = f.run('submitReview()')
    if (nextId === 'b') await f.run(`select(${JSON.stringify(item('b'))})`)
    f.run("reason = 'Newer unsaved draft'; correctedOutput = 'newer draft output'")
    finishWrite(json({ reviewed: 'a', decision: 'correct' }))
    await pending
    assert.equal(f.snapshot('selected.id'), nextId)
    assert.equal(f.snapshot('detail.candidate.id'), nextId)
    assert.equal(f.snapshot('reason'), 'Newer unsaved draft')
    assert.equal(f.snapshot('correctedOutput'), 'newer draft output')
    const posted = f.calls.find(call => call.options?.method === 'POST')!
    assert.deepEqual(JSON.parse(String(posted.options?.body)), { bank: 'decision', id: 'a', decision: 'correct', reason: 'Approved a', correctedOutput: '{"approved":true}' })
    assert.equal(f.calls.filter(call => call.url.includes('id=')).length, nextId === 'b' ? 2 : 1, 'saving refreshes the list without reselecting the editor')
    assert.equal(f.snapshot('saving'), false)
  }
})

test('list reads release superseded requests and navigation prevents late reads or post-save reloads', async () => {
  const replies: Array<(response: Response) => void> = []
  const f = fixture(() => new Promise(resolve => replies.push(resolve)))
  const first = f.run('load()')
  const second = f.run('load()')
  replies[1](json({ items: [item('b')] }))
  await second
  replies[0](json({ items: [item('a')] }))
  await first
  assert.equal(f.snapshot('items[0].id'), 'b')
  const selection = f.run(`select(${JSON.stringify(item('b'))})`)
  f.destroy()
  replies[2](json(detail('b')))
  await selection
  assert.equal(f.calls[2].options?.signal?.aborted, true)
  assert.equal(f.snapshot('detail'), null)
  assert.equal(f.snapshot('error'), '')

  let finishWrite!: (response: Response) => void
  const saving = fixture(call => call.options?.method === 'POST' ? new Promise(resolve => { finishWrite = resolve }) : json(detail('a')))
  await saving.run(`select(${JSON.stringify(item('a'))})`)
  saving.run("reason = 'Approved before navigation'")
  const pending = saving.run('submitReview()')
  saving.destroy()
  finishWrite(json({ reviewed: 'a', decision: 'accept' }))
  await pending
  assert.equal(saving.calls.length, 2, 'the admitted write finishes without new reads after navigation')
  assert.equal(saving.calls[1].options?.signal, undefined, 'navigation must not abort or repeat the review write')
})

test('proposals seed a draft separately from saved reviews, and correction requirements and payloads remain unchanged', async () => {
  for (const [verdict, expected] of [['correct', 'accept'], ['incorrect', 'correct'], ['uncertain', 'defer']]) {
    const f = fixture(() => json(detail('a', null, { verdict, reason: 'Proposal evidence', correctedOutput: '{}' })))
    await f.run(`select(${JSON.stringify(item('a'))})`)
    assert.equal(f.snapshot('decision'), expected)
    assert.equal(f.snapshot('reason'), 'Proposal evidence')
    assert.equal(f.calls.length, 1, 'a proposal does not automatically submit a review')
  }
  const f = fixture(() => json(detail('a', { decision: 'reject', reason: 'Human decision' }, { verdict: 'correct', reason: 'Proposal' })))
  await f.run(`select(${JSON.stringify(item('a'))})`)
  assert.equal(f.snapshot('decision'), 'reject')
  assert.equal(f.snapshot('reason'), 'Human decision')
  f.run("reason = ' '; decision = 'correct'; correctedOutput = ''")
  await f.run('submitReview()')
  f.run("reason = 'Needs correction'")
  await f.run('submitReview()')
  assert.equal(f.calls.length, 1)
  const html = renderState({ selected: item('a'), detail: detail('a', null, { verdict: 'correct' }), reason: 'Human reason', decision: 'correct', correctedOutput: '{}' })
  for (const text of ['Original model instructions', 'Original input', 'output-a', 'event-a', 'dispatch-a', 'Curator suggestion', 'before training', 'Corrected JSON output']) assert.match(html, new RegExp(text))
})

test('read and write failures remain visible without asserting that no records exist or discarding the review draft', async () => {
  const f = fixture(() => json({ error: 'Profile unavailable' }, 500))
  await f.run('load()')
  assert.equal(f.snapshot('error'), 'Profile unavailable')
  const html = renderState({ loading: false, items: [], error: 'Profile unavailable' })
  assert.match(html, /Profile unavailable/)
  assert.doesNotMatch(html, /No saved model decisions yet/)
  f.run(`selected = ${JSON.stringify(item('a'))}; reason = 'Keep this draft'; decision = 'defer'`)
  await f.run('submitReview()')
  assert.equal(f.snapshot('error'), 'Profile unavailable')
  assert.equal(f.snapshot('reason'), 'Keep this draft')
  assert.equal(f.snapshot('saving'), false)
  assert.equal(f.calls.length, 2)
})
