import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compile } from 'svelte/compiler'
import * as authoring from '../../lib/client/flow-editor/graph-authoring.js'
import * as converter from '../../lib/client/flow-editor/template-converter.js'
import * as history from '../../lib/client/flow-editor/graph-history.js'
import { withUpdatedNodeProperty } from '../../lib/client/flow-editor/node-property-state.js'
import { updateTimeline } from '../../lib/client/flow-editor/execution-observability.js'
import { readServerEvents } from '../../lib/client/sse.js'
import { groupWorkflows } from '../../lib/client/flow-editor/workflow-groups.js'
import { normalizeGraphFileName, overwritesDifferentGraph, saveDialogFileName } from '../../lib/client/flow-editor/graph-file-identity.js'

const require = createRequire(import.meta.url)
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const settled = () => new Promise(resolve => setImmediate(resolve))
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
type Call = { url: string; options?: RequestInit }

// Reuse the existing graph-history suite's real-component-script approach.
// Runes initialize view state; graph/stream behavior runs at its actual owner.
function component(file: string, bindings: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const scriptText = source.includes('<script') ? source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1] : source
  const script = ts.createSourceFile(file, scriptText, ts.ScriptTarget.Latest, true)
  const mounts: Array<() => unknown> = []
  const effects: Array<() => unknown> = []
  const destroys: Array<() => void> = []
  const context = vm.createContext({ ...authoring, ...converter, ...history, withUpdatedNodeProperty, updateTimeline, readServerEvents,
    groupWorkflows, normalizeGraphFileName, overwritesDifferentGraph, saveDialogFileName,
    AbortController, AbortSignal, Map, Set, crypto: { randomUUID: () => 'fixture-node' },
    $state: (value: unknown) => value, $derived: Object.assign((value: unknown) => value, { by: (fn: () => unknown) => fn() }),
    $effect: (fn: () => unknown) => effects.push(fn), untrack: (fn: () => unknown) => fn(), $props: () => ({}), BaseNode() {}, provideFlowEditorActions() {},
    onMount: (fn: () => unknown) => mounts.push(fn), onDestroy: (fn: () => void) => destroys.push(fn),
    window: { confirm: () => true, addEventListener() {}, removeEventListener() {} },
    console: { log() {}, error() {}, warn() {} }, setTimeout: () => 0, clearTimeout() {},
    apiFetch() { assert.fail('unexpected real API boundary') }, ...bindings,
  })
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(script).replace(/^export\s+/, '')).join('\n')), context)
  return { context, source, script, scriptText, mounts, effects, destroy: () => destroys.forEach(fn => fn()),
    run: (expression: string): any => vm.runInContext(expression, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
  }
}

function render(file: string, props: Record<string, unknown>, initial: Record<string, unknown> = {}): string {
  const f = component(file)
  let source = f.source
  const offset = source.indexOf(f.scriptText)
  const declarations = f.script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  for (const node of declarations.reverse()) {
    if (node.initializer && Object.hasOwn(initial, node.name.getText(f.script))) {
      source = source.slice(0, offset + node.initializer.getStart(f.script)) + JSON.stringify(initial[node.name.getText(f.script)]) + source.slice(offset + node.initializer.end)
    }
  }
  const code = ts.transpileModule(compile(source, { filename: file, generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const componentRequire = createRequire(new URL(file, import.meta.url))
  const context = vm.createContext({ exports: {}, require: (id: string) => id === 'svelte' ? { onMount() {} }
    : id.endsWith('/api-config') ? { apiFetch() { assert.fail('SSR must not fetch') } } : componentRequire(id) })
  vm.runInContext(code, context)
  return require('svelte/server').render(context.exports.default, { props }).body
}

function editor() {
  const f = component('./FlowEditor.svelte')
  f.run(`nodes = ['a', 'b', 'c'].map(id => ({ id, type: 'genericNode', position: { x: 0, y: 0 }, data: {
    nodeType: 'fixture', schema: { id: 'fixture', name: 'Fixture', category: 'utility', inputs: [], outputs: [],
      propertySchemas: {}, execution: { activation: 'any-input', requiredInputs: [] } }, properties: {}, executionState: 'idle' } }))`)
  const names = ['getCurrentGraph', 'getGraphIdentity', 'resetExecutionStates', 'setNodeExecutionState', 'updateNodeOutputs', 'updateDisplayNodes', 'addNode', 'clearGraph', 'loadGraph']
  return { ...f, methods: Object.fromEntries(names.map(name => [name, f.run(`typeof ${name} === 'function' ? ${name} : undefined`)])) }
}

function pendingRead() {
  let finish!: (response: Response) => void
  const promise = new Promise<Response>(resolve => { finish = resolve })
  return { promise, finish: (response: Response) => finish(response) }
}

test('automatic first fit updates only baseline viewport; real graph edits and later view changes remain dirty', () => {
  for (const editBeforeFit of [false, true]) {
    const canvas = editor()
    const f = component('./FlowEditorLayout.svelte')
    canvas.context.callback = f.run('handleGraphChange')
    canvas.run('onGraphChange = callback')
    f.context.canvas = canvas.methods
    f.run('flowEditorRef = canvas; handleGraphChange(canvas.getCurrentGraph())')
    if (editBeforeFit) canvas.run("updateNodeProperty('a', 'text', 'Keep edit')")
    canvas.run('handleViewportMoveEnd(null, {x:29,y:275,zoom:0.95})')
    assert.equal(f.run('isDirty'), editBeforeFit)
    assert.equal(f.snapshot('JSON.parse(cleanGraphSignature).viewport.x'), 29)
    canvas.run("updateNodeProperty('a', 'text', 'Later edit')")
    assert.equal(f.run('isDirty'), true)
    f.run('markGraphClean(canvas.getCurrentGraph())')
    canvas.run('handleViewportMoveEnd(null, {x:30,y:275,zoom:0.95})')
    assert.equal(f.run('isDirty'), true, 'subsequent control-driven viewport changes are document edits')
  }
})

test('only the latest selected workflow can replace the canvas, including after New', async () => {
  for (const next of ['load', 'new']) {
    const reads = [pendingRead(), pendingRead()]
    let index = 0
    const canvas = editor()
    const graph = canvas.snapshot('getCurrentGraph()')
    const f = component('./FlowEditorLayout.svelte', { apiFetch: () => reads[index++].promise, loadSchemas: async () => [] })
    f.context.canvas = canvas.methods
    f.run('flowEditorRef = canvas')
    const first = f.run("loadGraph('first')")
    if (next === 'load') {
      const second = f.run("loadGraph('second')")
      reads[1].finish(json({ graph: { ...graph, name: 'Second' }, name: 'second' }))
      await second
    } else f.run('newGraph()')
    reads[0].finish(json({ graph: { ...graph, name: 'First' }, name: 'first' }))
    await first
    assert.equal(canvas.snapshot('getCurrentGraph().name'), next === 'load' ? 'Second' : 'Untitled Graph')
    assert.equal(f.run('graphFileName'), next === 'load' ? 'second' : '')
  }
})

test('leaving a running graph detaches its stream without writing old results into the next document', async () => {
  for (const next of ['load', 'new']) {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const canvas = editor()
    const graph = canvas.snapshot('getCurrentGraph()')
    const f = component('./FlowEditorLayout.svelte', { loadSchemas: async () => [], apiFetch: async (url: string) => url.includes('execute-graph')
      ? new Response(new ReadableStream({ start(controller) { stream = controller }, cancel() { cancelled = true } }))
      : json({ graph: { ...graph, name: 'Second' }, name: 'second' }) })
    f.context.canvas = canvas.methods
    f.run('flowEditorRef = canvas')
    const running = f.run('executeGraph()')
    await settled()
    if (next === 'load') await f.run("loadGraph('second')")
    else {
      f.run('newGraph()')
      canvas.run(`loadGraph(${JSON.stringify({ ...graph, name: 'New with same node IDs' })})`)
    }
    if (!cancelled) {
      stream.enqueue(new TextEncoder().encode('event: node_complete\ndata: {"nodeId":"a"}\n\nevent: graph_complete\ndata: {"response":"Old response","nodeOutputs":{"a":{"output":"old"}}}\n\n'))
      stream.close()
    }
    await running
    assert.equal(f.run('executionOutcome'), 'idle')
    assert.equal(f.run('isExecuting'), false)
    assert.deepEqual(f.snapshot('lastNodeOutputs'), {})
    assert.equal(canvas.snapshot('nodes[0].data.executionState'), 'idle')
    assert.equal(cancelled, true, 'only the observation ends; no job cancellation endpoint is called')
  }
})

test('the initial mode read shares the file-loading owner and cannot undo manual Load or New', async () => {
  for (const next of ['load', 'new']) {
    const initial = pendingRead()
    const canvas = editor()
    const graph = canvas.snapshot('getCurrentGraph()')
    const calls: string[] = []
    const f = component('./FlowEditorLayout.svelte', { $props: () => ({ cognitiveMode: 'dual' }), loadSchemas: async () => [],
      apiFetch: (url: string) => {
        calls.push(url)
        return url.includes('dual-mode') ? initial.promise : Promise.resolve(json({ graph: { ...graph, name: 'Manual' }, name: 'manual' }))
      } })
    f.context.canvas = canvas.methods
    f.run('flowEditorRef = canvas')
    f.effects[0]()
    assert.match(calls[0], /name=dual-mode/)
    if (next === 'load') await f.run("loadGraph('manual')")
    else f.run('newGraph()')
    initial.finish(json({ graph: { ...graph, name: 'Initial mode' }, name: 'dual-mode', scope: 'builtin' }))
    await settled()
    assert.equal(canvas.snapshot('getCurrentGraph().name'), next === 'load' ? 'Manual' : 'Untitled Graph')
    assert.equal(f.run('graphLoading'), false)
    assert.equal(f.run('graphLoadError'), '')
    assert.equal(f.run('isDirty'), false)
  }
})

test('a failed initial load remains recoverable through the same Load and New controls', async () => {
  for (const next of ['load', 'new', 'retry']) {
    let fail = true
    const canvas = editor()
    const graph = canvas.snapshot('getCurrentGraph()')
    const f = component('./FlowEditorLayout.svelte', { $props: () => ({ cognitiveMode: 'dual' }), loadSchemas: async () => [],
      apiFetch: async () => fail ? json({ error: 'Initial file unavailable' }, 503) : json({ graph: { ...graph, name: 'Recovered' }, name: 'recovered' }) })
    f.context.canvas = canvas.methods
    f.run('flowEditorRef = canvas')
    f.effects[0]()
    await settled()
    assert.equal(f.run('graphLoadError'), 'Initial file unavailable')
    assert.equal(f.run('graphLoading'), false)
    fail = false
    if (next === 'retry') {
      f.run('retryGraphLoad()')
      await settled()
    } else if (next === 'load') await f.run("loadGraph('recovered')")
    else f.run('newGraph()')
    assert.equal(f.run('graphLoadError'), '')
    assert.equal(f.run('graphLoading'), false)
    assert.equal(canvas.snapshot('getCurrentGraph().name'), next === 'new' ? 'Untitled Graph' : 'Recovered')
  }
})

test('superseded and unmounted trace reads release their transport and cannot replace newer evidence', async () => {
  const reads = [pendingRead(), pendingRead(), pendingRead()]
  const signals: AbortSignal[] = []
  const f = component('./ExecutionPanel.svelte', { $props: () => ({ graph: null, entries: [], nodeOutputs: {}, status: 'idle' }),
    apiFetch: (_url: string, options: RequestInit) => { signals.push(options.signal as AbortSignal); return reads[signals.length - 1].promise } })
  const cleanup = f.mounts[0]() as () => void
  const second = f.run('refreshTraces()')
  reads[1].finish(json({ traces: [{ graph: 'Newer' }] }))
  await second
  reads[0].finish(json({ traces: [{ graph: 'Older' }] }))
  await settled()
  assert.equal(signals[0].aborted, true)
  assert.equal(f.snapshot('traces[0].graph'), 'Newer')
  const third = f.run('refreshTraces()')
  cleanup()
  reads[2].finish(json({ traces: [{ graph: 'After unmount' }] }))
  await third
  assert.equal(signals[2].aborted, true)
  assert.equal(f.snapshot('traces[0].graph'), 'Newer')
})

test('unmount releases pending file and execution observations without late state changes or replay', async () => {
  const read = pendingRead()
  const canvas = editor()
  const f = component('./FlowEditorLayout.svelte', { loadSchemas: async () => [], apiFetch: () => read.promise })
  f.context.canvas = canvas.methods
  f.run('flowEditorRef = canvas')
  const loading = f.run("loadGraph('pending')")
  f.destroy()
  read.finish(json({ graph: { ...canvas.snapshot('getCurrentGraph()'), name: 'Late' }, name: 'pending' }))
  await loading
  assert.equal(canvas.snapshot('getCurrentGraph().name'), 'Untitled Graph')
  assert.equal(f.run('graphFileName'), '')
})

function execution(frames: Array<[string, Record<string, unknown>]>, status = 200) {
  const calls: Call[] = []
  const canvas = editor()
  const f = component('./FlowEditorLayout.svelte', { apiFetch: async (url: string, options?: RequestInit) => {
    calls.push({ url, options })
    assert.equal(url, '/api/execute-graph-stream')
    return status === 200 ? new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
      : json({ error: 'Execution request rejected' }, status)
  } })
  f.context.canvas = canvas.methods
  f.run('flowEditorRef = canvas')
  return { ...f, canvas, calls }
}

test('execution outcome comes from the graph receipt, including waiting, failure and recovered node errors', async () => {
  for (const [event, outcome] of [['graph_waiting', 'waiting'], ['graph_error', 'failed'], ['graph_complete', 'completed']]) {
    const f = execution([['node_start', { nodeId: 'a' }], ['node_error', { nodeId: 'a', error: 'Node error' }],
      [event, { status: outcome, executionId: 'saved-execution', error: event === 'graph_error' ? 'Graph failed' : undefined, durationMs: 12 }]])
    await f.run('executeGraph()')
    assert.equal(f.run('isExecuting'), false)
    const html = render('./ExecutionPanel.svelte', { graph: null, entries: f.snapshot('executionTimeline'), nodeOutputs: {}, status: outcome })
    assert.match(html, new RegExp(`>${outcome}<`))
    assert.equal(f.run('executionOutcome'), outcome)
    if (outcome !== 'completed') assert.doesNotMatch(html, />complete</)
    assert.equal(f.calls.length, 1, 'an observed outcome must not replay execution')
  }
})

test('stream end without a graph receipt remains interrupted rather than successful or a fabricated node failure', async () => {
  const f = execution([['node_start', { nodeId: 'a' }]])
  await f.run('executeGraph()')
  const html = render('./ExecutionPanel.svelte', { graph: null, entries: f.snapshot('executionTimeline'), nodeOutputs: {}, status: 'interrupted' })
  assert.match(html, />interrupted</)
  assert.equal(f.run('executionOutcome'), 'interrupted')
  assert.equal(f.canvas.snapshot('nodes[0].data.executionState'), 'running')
  assert.equal(f.canvas.snapshot('nodes[1].data.executionState'), 'idle')
  assert.match(f.run('executionError'), /outcome|unconfirmed/i)
})

test('an explicit graph error retains completed and skipped node receipts', async () => {
  const f = execution([['node_start', { nodeId: 'a' }], ['node_complete', { nodeId: 'a' }],
    ['node_skip', { nodeId: 'b', reason: 'inactive branch' }], ['graph_error', { error: 'Graph failed elsewhere' }]])
  await f.run('executeGraph()')
  assert.deepEqual(f.canvas.snapshot('nodes.map(node => node.data.executionState)'), ['completed', 'skipped', 'idle'])
  assert.equal(f.run('executionError'), 'Graph failed elsewhere')
})

test('HTTP rejection does not claim that unexecuted nodes failed', async () => {
  const f = execution([], 503)
  await f.run('executeGraph()')
  assert.deepEqual(f.canvas.snapshot('nodes.map(node => node.data.executionState)'), ['idle', 'idle', 'idle'])
  assert.equal(f.run('executionOutcome'), 'failed')
  assert.equal(f.run('executionError'), 'Execution request rejected')
  assert.deepEqual(f.canvas.snapshot('nodes.map(node => node.data.executionState)'), ['idle', 'idle', 'idle'])
})

test('display formatting preserves node execution receipts instead of marking skipped widgets complete', () => {
  const f = editor()
  f.run("nodes[0].data.schema.id = 'chat_view'; nodes[0].data.executionState = 'skipped'")
  f.run("updateDisplayNodes('Fixture response', {})")
  assert.equal(f.snapshot('nodes[0].data.executionState'), 'skipped')
})

test('one schema loader supports failure recovery, shared pending reads, cached results and alias lookup', async () => {
  let fail = true
  let finish!: (response: Response) => void
  const calls: string[] = []
  const schema = { id: 'fixture-input', name: 'Fixture Input', category: 'input', color: '#60a5fa', bgColor: '#1e3a8a',
    aliases: ['fixture-alias'], inputs: [], outputs: [], properties: { text: 'Keep default' }, propertySchemas: {}, execution: { activation: 'any-input', requiredInputs: [] } }
  const f = component('../../lib/client/flow-editor/template-converter.ts', { apiFetch: (url: string) => {
    calls.push(url)
    return fail ? Promise.resolve(json({ error: 'Schema catalog unavailable' }, 503)) : new Promise(resolve => { finish = resolve })
  } })
  await assert.rejects(f.run('loadSchemas()'), /Schema catalog unavailable/)
  fail = false
  const first = f.run('loadSchemas()')
  const second = f.run('loadSchemas()')
  finish(json([schema]))
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), [schema])
  assert.deepEqual(JSON.parse(JSON.stringify(await second)), [schema])
  assert.deepEqual(JSON.parse(JSON.stringify(await f.run('loadSchemas()'))), [schema])
  assert.equal(calls.length, 2, 'retry and concurrent consumers must share the existing cache')
  assert.equal(f.run("getCachedSchema('cognitive/fixture-alias').id"), 'fixture-input')
})

test('Palette failure is visible, retry keeps search choices, and selection uses the canonical cached schema', async () => {
  let fail = true
  const schema = { id: 'fixture-input', name: 'Fixture Input', category: 'input', description: 'Fixture source', color: '#60a5fa', bgColor: '#1e3a8a',
    inputs: [], outputs: [], properties: { text: 'Keep default' }, propertySchemas: {}, execution: { activation: 'any-input', requiredInputs: [] } }
  const apiFetch = async () => fail ? json({ error: 'Catalog unavailable' }, 503) : json([schema])
  const cache = component('../../lib/client/flow-editor/template-converter.ts', { apiFetch })
  const f = component('../NodePalette.svelte', { apiFetch, loadSchemas: cache.run('loadSchemas'), $props: () => ({ onNodeSelected() {} }) })
  await f.mounts[0]()
  await settled()
  const error = f.run("typeof catalogError === 'string' ? catalogError : ''")
  const html = render('../NodePalette.svelte', { onNodeSelected() {} }, { loading: false, catalogError: error })
  assert.match(html, /Catalog unavailable/)
  assert.match(html, /Retry node catalog/)
  assert.doesNotMatch(html, /No nodes available/)
  f.run("searchQuery = 'fixture'")
  fail = false
  await f.run('loadNodes()')
  assert.equal(f.run('catalogError'), '')
  assert.equal(f.run('searchQuery'), 'fixture')
  assert.equal(f.snapshot('allNodes[0].id'), 'fixture-input')
  const canvas = editor()
  const layout = component('./FlowEditorLayout.svelte', { getCachedSchema: cache.run('getCachedSchema') })
  layout.context.canvas = canvas.methods
  layout.run('flowEditorRef = canvas; handleNodeSelected("cognitive/fixture-input")')
  assert.equal(canvas.snapshot('nodes.at(-1).data.schema.id'), 'fixture-input')
  assert.equal(canvas.snapshot('nodes.at(-1).data.properties.text'), 'Keep default')
})

test('trace reads expose loading and errors while preserving last successful evidence and a failed trace reason', async () => {
  let fail = false
  const traces = [{ timestamp: '2026-11-05T00:00:00Z', graph: 'Fixture', status: 'failed', error: 'Recorded graph error' }]
  const f = component('./ExecutionPanel.svelte', { $props: () => ({ graph: null, entries: [], nodeOutputs: {}, status: 'idle' }),
    apiFetch: async () => fail ? json({ error: 'Trace store unavailable' }, 503) : json({ traces }) })
  await f.run('refreshTraces()')
  fail = true
  await f.run('refreshTraces()')
  const html = render('./ExecutionPanel.svelte', { graph: null, entries: [], nodeOutputs: {}, status: 'idle' },
    { traces: f.snapshot('traces'), traceError: f.run('traceError') })
  assert.match(html, /Trace store unavailable/)
  assert.match(html, /Recorded graph error/)
  fail = false
  await f.run('refreshTraces()')
  assert.equal(f.run('traceError'), '')
})

test('workflow catalog and file-read failures remain recoverable without replacing the current graph', async () => {
  let fail = true
  const canvas = editor()
  const original = canvas.snapshot('getCurrentGraph()')
  const f = component('./FlowEditorLayout.svelte', { loadSchemas: async () => [], apiFetch: async (url: string) => fail ? json({ error: 'Workflow store unavailable' }, 503)
    : json(url.includes('cognitive-graphs?') ? { graphs: [{ name: 'saved', title: 'Saved', scope: 'custom' }], backups: [] }
    : { graph: { ...original, name: 'Loaded fixture' }, name: 'saved', scope: 'custom' }) })
  f.context.canvas = canvas.methods
  f.run('flowEditorRef = canvas; showLoadMenu = true')
  await f.run('refreshSavedGraphs()')
  assert.equal(f.run('graphListError'), 'Workflow store unavailable')
  await f.run("loadGraph('saved')")
  assert.equal(f.run('graphLoadError'), 'Workflow store unavailable')
  assert.equal(f.run('showLoadMenu'), true)
  assert.deepEqual(canvas.snapshot('getCurrentGraph()'), original)
  fail = false
  await f.run('refreshSavedGraphs()')
  assert.equal(f.run('graphListError'), '')
  assert.equal(f.snapshot('savedGraphs[0].name'), 'saved')
  await f.run("loadGraph('saved')")
  assert.equal(f.run('graphLoadError'), '')
  assert.equal(f.run('showLoadMenu'), false)
  assert.equal(f.run('graphFileName'), 'saved')
  assert.equal(canvas.snapshot('getCurrentGraph().name'), 'Loaded fixture')
})

test('a completed save retains newer edits and cannot replace a document opened after the request', async () => {
  for (const next of ['edit', 'new']) {
    let finish!: (response: Response) => void
    const canvas = editor()
    const f = component('./FlowEditorLayout.svelte', { apiFetch: async (_url: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise(resolve => { finish = resolve }) : json({ graphs: [], backups: [] }) })
    f.context.canvas = canvas.methods
    f.run("flowEditorRef = canvas; saveFileName = 'saved-old'; showSaveDialog = true")
    const saving = f.run('saveGraph()')
    // Cancel closes the dialog; the admitted write still owns its original payload.
    f.run('closeSaveDialog()')
    if (next === 'new') f.run('newGraph()')
    else canvas.run("updateNodeProperty('a', 'newer', 'Keep this edit')")
    finish(json({ success: true }))
    await saving
    if (next === 'new') {
      assert.equal(f.run('graphFileName'), '')
      assert.equal(f.snapshot('currentGraph.nodes.length'), 0)
    } else {
      assert.equal(f.run('isDirty'), true)
      assert.equal(f.snapshot('currentGraph.nodes[0].data.properties.newer'), 'Keep this edit')
    }
  }
})
