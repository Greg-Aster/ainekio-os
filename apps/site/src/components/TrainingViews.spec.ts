import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compile, parse } from 'svelte/compiler'

const componentRequire = createRequire(import.meta.url)
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const settled = () => new Promise(resolve => setImmediate(resolve))
type Call = { url: string; options?: RequestInit }
const runLabel = '2026-11-05T10-20-30-000Z'
const current = { success: true, running: true, pid: 4321, method: 'full-cycle-local', runLabel, logFile: `full-cycle-local-${runLabel}.log`, cancelling: false }
const operation = (id: string, progress = 25) => ({ operation: id, overallStatus: 'running', overallProgress: progress,
  currentStage: 'training', stages: [{ name: 'training', status: 'in_progress', progress, message: `Progress ${progress}` }],
  startTime: '2026-11-05T10:20:30Z', lastHeartbeat: '2026-11-05T10:21:30Z', metadata: { model: 'fixture-base', samples: 4 }, elapsedSeconds: 60 })
const savedRun = (id: string) => ({ id, startTime: '2026-11-05T10:20:30Z', status: 'completed', method: 'local-lora', logFile: `${id}.log` })
const candidate = (reviewId: string) => ({ runLabel, status: 'candidate', method: 'local-lora', target: 'llama-cpp', baseModel: 'fixture-base', candidateDirectory: '/fixture/adapter',
  review: { id: reviewId, createdAt: '2026-11-05T11:00:00Z', model: 'fixture-candidate', baselineProvider: 'llama-cpp', baselineModel: 'fixture-base',
    cases: [{ prompt: 'Fixture prompt', baseline: 'Baseline answer', candidate: 'Candidate answer' }] } })

function fixture(name: 'TrainingHistory' | 'TrainingMonitor', respond: (call: Call) => Response | Promise<Response>) {
  const source = readFileSync(new URL(`./${name}.svelte`, import.meta.url), 'utf8')
  const scriptText = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]
  const script = ts.createSourceFile(`${name}.ts`, scriptText, ts.ScriptTarget.Latest, true)
  const calls: Call[] = []
  const timers = new Map<number, { callback: () => unknown; ms: number }>()
  const listeners = new Map<string, () => void>()
  const destroy: Array<() => void> = []
  const navigation: string[] = []
  const document = { hidden: false, addEventListener: (type: string, callback: () => void) => listeners.set(type, callback),
    removeEventListener: (type: string) => listeners.delete(type) }
  let mounted!: () => void | (() => void)
  let timerId = 0
  const setInterval = (callback: () => unknown, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId }
  const context = vm.createContext({ AbortController, AbortSignal, URLSearchParams, document,
    onMount: (callback: typeof mounted) => { mounted = callback }, onDestroy: (callback: () => void) => destroy.push(callback),
    apiFetch: async (url: string, options?: RequestInit) => { const call = { url, options }; calls.push(call); return respond(call) },
    activeView: { set: (value: string) => navigation.push(value) }, systemSection: { set: (value: string) => navigation.push(value) },
    window: { setInterval }, setInterval, clearInterval: (id: number) => timers.delete(id),
    tick: async () => {}, setTimeout: (callback: () => void) => { callback(); return 0 }, requestAnimationFrame: (callback: () => void) => callback(),
    console: { error() {}, warn() {} }, alert() {}, confirm: () => false,
  })
  const reactivity = () => script.statements.filter(ts.isLabeledStatement).forEach(node => vm.runInContext(transpile(node.getText(script)), context))
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isLabeledStatement(node)).map(node => node.getText(script)).join('\n')), context)
  reactivity()
  return { calls, timers, document, listeners, navigation, context,
    mount() { const cleanup = mounted(); return () => { cleanup?.(); destroy.forEach(callback => callback()) } },
    run(expression: string): any {
      const result = vm.runInContext(expression, context)
      if (result?.then) return result.finally(reactivity)
      reactivity()
      return result
    },
    snapshot(expression: string) { reactivity(); return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) },
    click(text: string) {
      let expression = ''
      function visit(node: any) {
        if (!node || typeof node !== 'object') return
        if (node.name === 'button' && source.slice(node.start, node.end).includes(text)) {
          const event = node.attributes.find((attribute: any) => attribute.type === 'OnDirective' && attribute.name === 'click')
          if (event) expression = source.slice(event.expression.start, event.expression.end)
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value === 'object') visit(value)
        }
      }
      visit(parse(source, { modern: true }))
      assert.ok(expression, `actual ${text} button has a click handler`)
      return this.run(transpile(`(${expression})();`))
    },
    render(values: Record<string, unknown>) {
      let component = source
      const offset = source.indexOf(scriptText)
      const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      for (const node of declarations.reverse()) {
        if (node.initializer && Object.hasOwn(values, node.name.getText(script))) {
          component = component.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[node.name.getText(script)]) + component.slice(offset + node.initializer.end)
        }
      }
      const code = ts.transpileModule(compile(component, { filename: `${name}.svelte`, generate: 'server' }).js.code,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
      const rendering = vm.createContext({ exports: {}, AbortController, AbortSignal, require: (id: string) => id === 'svelte' ? { onMount() {}, onDestroy() {}, tick: async () => {} }
        : id === '../lib/client/api-config' ? { apiFetch() { assert.fail('template rendering must not call services') } }
        : id === '../stores/navigation' ? {} : componentRequire(id) })
      vm.runInContext(code, rendering)
      return componentRequire('svelte/server').render(rendering.exports.default).body
    },
  }
}

test('Monitor selects from the current operations snapshot without a second detail request or stale selected copy', async () => {
  let operations = [operation('run-a'), operation('run-b', 40)]
  const f = fixture('TrainingMonitor', () => json({ operations }))
  const cleanup = f.mount()
  await settled()
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].ms, 5000)
  assert.equal(f.snapshot('selectedOperationId'), 'run-a')
  f.run("op = operations[1]")
  await f.click('selectedOperation?.operation === op.operation')
  assert.equal(f.snapshot('selectedOperationId'), 'run-b')
  assert.equal(f.calls.length, 1, 'selecting an existing snapshot must not fetch its duplicate')
  operations = [operation('run-a', 50), operation('run-b', 80)]
  await [...f.timers.values()][0].callback()
  assert.deepEqual(f.calls.map(call => call.url), ['/api/training/status', '/api/training/status'])
  const html = f.render({ loading: false, operations, selectedOperationId: f.snapshot('selectedOperationId') })
  assert.match(html, /Progress 80/)
  assert.doesNotMatch(html, /Progress 40/)
  operations = [operation('run-a', 60)]
  await f.run('loadOperations()')
  assert.equal(f.snapshot('selectedOperationId'), 'run-a')
  cleanup()
  assert.equal(f.timers.size, 0)
})

test('Monitor exposes failed initial reads and successful retry clears the error while later failure retains the last snapshot', async () => {
  let fail = true
  const f = fixture('TrainingMonitor', () => fail ? json({ error: 'Operations unavailable' }, 503) : json({ operations: [operation('run-a')] }))
  await f.run('loadOperations()')
  let html = f.render({ loading: false, error: f.snapshot('error') })
  assert.match(html, /Operations unavailable/)
  assert.match(html, /Retry training operations/)
  assert.doesNotMatch(html, /No training operations found/)
  fail = false
  await f.click('Retry training operations')
  assert.equal(f.snapshot('error'), '')
  fail = true
  await f.run('loadOperations()')
  html = f.render({ loading: false, error: f.snapshot('error'), operations: f.snapshot('operations'), selectedOperationId: f.snapshot('selectedOperationId') })
  assert.match(html, /Operations unavailable/)
  assert.match(html, /Progress 25/)
})

test('Monitor displays actual worker errors and leaves absent stage percentages unreported', () => {
  const f = fixture('TrainingMonitor', () => json({ operations: [] }))
  const fallback = { ...operation('local-run'), stages: [{ name: 'preparing', status: 'in_progress' }] }
  let html = f.render({ loading: false, operations: [fallback], selectedOperationId: 'local-run' })
  assert.doesNotMatch(html, /width: undefined%|>undefined%|>%<\/span>/)
  const failed = { ...operation('failed-run'), overallStatus: 'failed', error: 'Worker result verification failed',
    stages: [{ name: 'upload', status: 'skipped' }, { name: 'training', status: 'failed', error: 'Trainer exited unsuccessfully' }] }
  html = f.render({ loading: false, operations: [failed], selectedOperationId: 'failed-run' })
  assert.match(html, /Worker result verification failed/)
  assert.match(html, /Trainer exited unsuccessfully/)
})

test('History uses registered live metadata without an audit-derived start time, fake method or repeated timer resets', async () => {
  const f = fixture('TrainingHistory', call => json(call.url.endsWith('/running') ? current
    : call.url.endsWith('/history') ? { success: true, runs: [], candidates: [], cleanup: [] } : { success: true, logs: [] }))
  const cleanup = f.mount()
  await settled()
  assert.equal(f.snapshot('currentRun.method'), 'full-cycle-local')
  assert.equal(f.snapshot('currentRun.runLabel'), runLabel)
  assert.equal(f.calls.some(call => call.url.includes('maxLines=1')), false)
  const logTimer = [...f.timers].find(([, timer]) => timer.ms === 5000)![0]
  await f.run('loadTrainingHistory()')
  assert.equal([...f.timers].find(([, timer]) => timer.ms === 5000)![0], logTimer)
  const html = f.render({ loading: false, currentRun: current })
  assert.match(html, /full-cycle-local/)
  assert.ok(html.includes(new Date('2026-11-05T10:20:30.000Z').toLocaleString()))
  assert.doesNotMatch(html, /Invalid Date/)
  cleanup()
  assert.equal(f.timers.size, 0)
  assert.equal(f.listeners.size, 0)
})

test('History retains successful independent reads and exposes each failed read instead of reporting an empty history', async () => {
  let fail = true
  const f = fixture('TrainingHistory', call => fail && call.url.endsWith('/running') ? json({ error: 'Running observation unavailable' }, 503)
    : json(call.url.endsWith('/history') ? { success: true, runs: [savedRun('saved-a')], candidates: [], cleanup: [] }
    : { success: true, running: false, pid: null }))
  await f.run('loadTrainingHistory()')
  assert.equal(f.snapshot('pastRuns.length'), 1)
  assert.equal(f.snapshot('readErrors.status'), 'Running observation unavailable')
  let html = f.render({ loading: false, pastRuns: f.snapshot('pastRuns'), readErrors: f.snapshot('readErrors') })
  assert.match(html, /Running observation unavailable/)
  fail = false
  await f.click('Retry training reads')
  assert.deepEqual(f.snapshot('readErrors'), {})
  const failed = fixture('TrainingHistory', () => json({ error: 'History unavailable' }, 503))
  await failed.run('loadTrainingHistory()')
  html = failed.render({ loading: false, readErrors: failed.snapshot('readErrors') })
  assert.match(html, /History unavailable/)
  assert.doesNotMatch(html, /No past training runs found|No candidate runs have been produced/)
})

test('History navigation and hiding release existing timers; late initial reads cannot restart them', async () => {
  for (const leave of ['hide', 'navigate']) {
    let finish!: (response: Response) => void
    const f = fixture('TrainingHistory', call => call.url.endsWith('/running') ? new Promise(resolve => { finish = resolve })
      : json({ success: true, runs: [], candidates: [], cleanup: [] }))
    const cleanup = f.mount()
    if (leave === 'hide') { f.document.hidden = true; f.listeners.get('visibilitychange')!() } else cleanup()
    finish(json(current))
    await settled()
    assert.equal(f.timers.size, 0)
    if (leave === 'hide') cleanup()
  }
})

test('History archived-log selection owns its response across switching, collapse and reopening', async () => {
  const responses: Array<(response: Response) => void> = []
  const f = fixture('TrainingHistory', () => new Promise(resolve => responses.push(resolve)))
  f.run(`pastRuns = ${JSON.stringify([savedRun('saved-a'), savedRun('saved-b')])}`)
  const first = f.run("toggleRunDetails('saved-a')")
  const second = f.run("toggleRunDetails('saved-b')")
  responses[1](json({ success: true, logs: ['B output'] }))
  await second
  responses[0](json({ success: true, logs: ['Old A output'] }))
  await first
  assert.deepEqual(f.snapshot('expandedLogs'), ['B output'])
  const oldA = f.run("toggleRunDetails('saved-a')")
  await f.run("toggleRunDetails('saved-a')")
  const newA = f.run("toggleRunDetails('saved-a')")
  responses[3](json({ success: true, logs: ['New A output'] }))
  await newA
  responses[2](json({ success: true, logs: ['Stale A output'] }))
  await oldA
  assert.deepEqual(f.snapshot('expandedLogs'), ['New A output'])
  assert.equal(f.snapshot('loadingLogs'), false)
})

test('History keeps notes, associates response checks with their serving review, and preserves review/cleanup action payloads', async () => {
  let review = candidate('review-a')
  const f = fixture('TrainingHistory', call => {
    if (call.options?.method === 'POST') return json({ success: true, result: { model: 'fixture-candidate', cases: review.review.cases, confirmedAt: 'fixture-time' } })
    return json(call.url.endsWith('/history') ? { success: true, runs: [], candidates: [review], cleanup: [] }
      : { success: true, running: false, pid: null })
  })
  await f.run('loadTrainingHistory()')
  f.run(`selectedCandidate = '${runLabel}'; checks = [true]; notes = 'Read this comparison'; baselineModel = 'fixture-base'; prompts = ${JSON.stringify('One\nTwo\nThree')}`)
  await f.run('loadTrainingHistory()')
  assert.deepEqual(f.snapshot('checks'), [true])
  assert.equal(f.snapshot('notes'), 'Read this comparison')
  review = candidate('review-b')
  await f.run('loadTrainingHistory()')
  assert.deepEqual(f.snapshot('checks'), [])
  assert.equal(f.snapshot('notes'), 'Read this comparison')
  assert.match(f.snapshot('reviewMessage'), /comparison changed/)
  f.run("notes = 'Read new comparison'; checks = [true]")
  for (const action of ['prepare', 'test', 'decide', 'reopen']) {
    if (action === 'decide') f.run("checks = [true]; notes = 'All new responses reviewed'")
    await f.run(`reviewAction('${action}', ${action === 'decide' ? "'accepted'" : 'undefined'})`)
  }
  await f.run("reviewAction('decide', 'rejected')")
  await f.run(`recoverCleanup('${runLabel}')`)
  const writes = f.calls.filter(call => call.options?.method === 'POST').map(call => JSON.parse(String(call.options?.body)))
  assert.deepEqual(writes.map(body => body.action), ['prepare', 'test', 'decide', 'reopen', 'decide', 'recover-cleanup'])
  assert.equal(writes[2].reviewId, 'review-b')
  assert.equal(writes[2].decision, 'accepted')
  assert.deepEqual(writes[2].checks, [true])
  assert.equal(writes[4].decision, 'rejected')
  assert.deepEqual(writes[1].prompts, ['One', 'Two', 'Three'])
  f.run('openModels(); openBackend()')
  assert.deepEqual(f.navigation, ['settings', 'system', 'backend', 'system'])
})

test('History cancellation retains the live run until the canonical status changes and reports backend errors', async () => {
  let fail = false
  const f = fixture('TrainingHistory', call => call.options?.method === 'POST' ? json(fail ? { success: false, error: 'Worker cancellation rejected' } : { success: true }, fail ? 503 : 200)
    : json(call.url.endsWith('/running') ? current : call.url.endsWith('/history') ? { success: true, runs: [], candidates: [], cleanup: [] } : { success: true, logs: [] }))
  f.run(`currentRun = ${JSON.stringify(current)}`)
  await f.run('cancelTraining()')
  assert.equal(f.snapshot('currentRun.pid'), 4321)
  fail = true
  await f.run('cancelTraining()')
  assert.equal(f.snapshot('error'), 'Worker cancellation rejected')
})

test('History does not apply an older running observation to a newer run', async () => {
  let finish!: (response: Response) => void
  const f = fixture('TrainingHistory', () => new Promise(resolve => { finish = resolve }))
  f.run(`currentRun = ${JSON.stringify(current)}`)
  const old = f.run('loadRunningTraining()')
  f.run(`currentRun = ${JSON.stringify({ ...current, runLabel: 'newer-run', pid: 5678 })}`)
  finish(json({ success: true, running: false, pid: null }))
  await old
  assert.equal(f.snapshot('currentRun.pid'), 5678)
  assert.equal(f.snapshot('currentRun.runLabel'), 'newer-run')
})

test('History retries failed console/events reads independently and does not apply them after the run changes', async () => {
  let fail = true
  const f = fixture('TrainingHistory', call => json(call.url.endsWith('/running') ? current
    : call.url.endsWith('/history') ? { success: true, runs: [], candidates: [], cleanup: [] }
    : fail ? { success: false, error: 'Output observation unavailable' } : { success: true, logs: [] }))
  await f.run('loadTrainingHistory()')
  await settled()
  assert.equal(f.snapshot('readErrors.console'), 'Output observation unavailable')
  assert.equal(f.snapshot('readErrors.events'), 'Output observation unavailable')
  fail = false
  await f.click('Retry training reads')
  assert.deepEqual(f.snapshot('readErrors'), {})
  const pending: Array<(response: Response) => void> = []
  const old = fixture('TrainingHistory', () => new Promise(resolve => pending.push(resolve)))
  old.run(`currentRun = ${JSON.stringify(current)}`)
  const reading = old.run('loadCurrentLogs()')
  old.run(`currentRun = ${JSON.stringify({ ...current, runLabel: 'newer-run', pid: 5678 })}; consoleLogs = ['New output']`)
  pending[0](json({ success: true, logs: [{ event: 'old_event' }] }))
  pending[1](json({ success: false, error: 'Old run read error' }, 503))
  await reading
  assert.deepEqual(old.snapshot('consoleLogs'), ['New output'])
  assert.deepEqual(old.snapshot('readErrors'), {})
})

test('a history read started before a review cannot rebind its checks during the action or overwrite its acknowledged result', async () => {
  for (const arrival of ['during', 'after']) {
    let saved = candidate('review-a')
    let holdHistory = false
    let finishHistory!: (response: Response) => void
    let finishAction!: (response: Response) => void
    const history = (value: ReturnType<typeof candidate>) => json({ success: true, runs: [], candidates: [value], cleanup: [] })
    const f = fixture('TrainingHistory', call => {
      if (call.options?.method === 'POST') return new Promise(resolve => { finishAction = resolve })
      if (call.url.endsWith('/history')) {
        if (holdHistory) { holdHistory = false; return new Promise(resolve => { finishHistory = resolve }) }
        return history(saved)
      }
      return json({ success: true, running: false, pid: null })
    })
    await f.run('loadTrainingHistory()')
    f.run(`selectedCandidate = '${runLabel}'; checks = [true]; notes = 'Draft review notes'`)
    holdHistory = true
    const previousRead = f.run('loadPastRuns()')
    const action = f.run("reviewAction('test')")
    if (arrival === 'during') {
      finishHistory(history(candidate('stale-review')))
      await previousRead
      assert.equal(f.snapshot('candidates[0].review.id'), 'review-a')
      assert.deepEqual(f.snapshot('checks'), [true])
      assert.equal(f.snapshot('notes'), 'Draft review notes')
    }
    saved = candidate('review-b')
    finishAction(json({ success: true, result: saved.review }))
    await action
    if (arrival === 'after') { finishHistory(history(candidate('stale-review'))); await previousRead }
    assert.equal(f.snapshot('candidates[0].review.id'), 'review-b')
    assert.deepEqual(f.snapshot('checks'), [])
    assert.equal(f.snapshot('notes'), 'Draft review notes')
  }
})
