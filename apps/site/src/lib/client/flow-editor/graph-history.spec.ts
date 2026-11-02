import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyGraphHistory,
  recordGraphHistory,
  redoGraphHistory,
  undoGraphHistory,
} from './graph-history'

test('graph history records, undoes, and redoes snapshots', () => {
  let history = emptyGraphHistory<number>()
  history = recordGraphHistory(history, 1)
  history = recordGraphHistory(history, 2)

  const undone = undoGraphHistory(history, 3)
  assert.equal(undone.value, 2)
  assert.deepEqual(undone.history, { past: [1], future: [3] })

  const redone = redoGraphHistory(undone.history, 2)
  assert.equal(redone.value, 3)
  assert.deepEqual(redone.history, { past: [1, 2], future: [] })
})

test('new edits clear redo history and history is bounded', () => {
  const history = recordGraphHistory({ past: [1, 2], future: [4] }, 3, 2)
  assert.deepEqual(history, { past: [2, 3], future: [] })
})

// Exercise the actual editor callbacks at the XYFlow before/after mutation
// boundary. The library owns mutation; the editor owns history and persistence.
test('canvas connect, reconnect and deletion publish once and preserve pre-change undo state', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: vm } = await import('node:vm')
  const { default: ts } = await import('typescript')
  const { connectionProblem, decorateEdge } = await import('./graph-authoring')
  const component = readFileSync(new URL('../../../components/flow-editor/FlowEditor.svelte', import.meta.url), 'utf8')
  const source = ts.createSourceFile('FlowEditor.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true)
  const names = ['cloneValue', 'captureSnapshot', 'recordHistory', 'notifyHistoryChange', 'notifyGraphChange',
    'updateUnconnectedStatusInternal', 'getCurrentGraph', 'handleBeforeConnect',
    'handleBeforeReconnect', 'handleBeforeDelete']
  const code = ts.transpileModule(source.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name!.text))
    .map(statement => statement.getText(source).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const published: unknown[] = []
  const state = vm.createContext({
    nodes: ['a', 'b', 'c'].map(id => ({ id, data: { schema: { inputs: [{ name: 'in' }], outputs: [{ name: 'out' }] } }, position: { x: 0, y: 0 } })),
    edges: [], history: emptyGraphHistory(), viewport: { x: 0, y: 0, zoom: 1 },
    graphName: 'Fixture', graphDescription: '', scheduler: {}, cognitiveMode: undefined,
    clipboard: null, lastHistoryKey: '', lastHistoryAt: 0,
    onHistoryChange() {}, onGraphChange: (graph: unknown) => published.push(structuredClone(graph)),
    recordGraphHistory, connectionProblem, decorateEdge,
  })
  vm.runInContext(code, state)
  const invoke = (prop: string, ...args: unknown[]) => {
    const handler = component.match(new RegExp(`\\b${prop}=\\{(\\w+)\\}`))?.[1]
    return handler ? state[handler](...args) : undefined
  }
  const connection = { source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }
  const initial = structuredClone(state.captureSnapshot())
  const edge = invoke('onbeforeconnect', connection) ?? { id: 'library-edge', ...connection }
  state.edges = [...state.edges, edge]
  invoke('onconnect', connection)
  assert.equal(state.edges.length, 1, 'library and editor must not both create an edge')
  assert.equal(published.length, 1, 'a new connection must reach the save consumer')
  assert.deepEqual(structuredClone(state.history.past.at(-1)), initial)
  assert.equal(state.edges[0].data.kind, 'data')

  const connected = structuredClone(state.captureSnapshot())
  const next = { ...connection, target: 'c' }
  const replacement = invoke('onbeforereconnect', { ...edge, ...next }, edge) ?? { ...edge, ...next }
  state.edges = [replacement]
  invoke('onreconnect', edge, next)
  assert.equal(published.length, 2)
  assert.deepEqual(structuredClone(state.history.past.at(-1)), connected, 'undo must restore the previous endpoint')
  assert.equal(state.edges[0].target, 'c')

  const reconnected = structuredClone(state.captureSnapshot())
  assert.equal(await invoke('onbeforedelete', { nodes: [state.nodes[2]], edges: [replacement] }), true)
  const removed = state.nodes[2]
  state.nodes = state.nodes.slice(0, 2)
  state.edges = []
  invoke('ondelete', { nodes: [removed], edges: [replacement] })
  assert.equal(published.length, 3, 'combined node/edge deletion publishes the final graph once')
  assert.deepEqual(structuredClone(state.history.past.at(-1)), reconnected)
  const undone = undoGraphHistory(state.history, state.captureSnapshot())
  assert.deepEqual(structuredClone(undone.value), reconnected)
  assert.deepEqual(structuredClone(redoGraphHistory(undone.history, undone.value).value), structuredClone(state.captureSnapshot()))
})
