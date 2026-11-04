import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildCanvas, type Architecture, type CanvasNode, type Position } from './canvas-model.ts'

const architecture: Architecture = JSON.parse(fs.readFileSync(new URL('./architecture.json', import.meta.url), 'utf8'))
const groupIds = architecture.groups.map(group => group.id)
const groupById = new Map(architecture.groups.map(group => [group.id, group]))
const originalConnections = new Map(architecture.edges.map(edge => [edge.id, edge]))
function members(groupId: string): Set<string> {
  return new Set([
    ...architecture.nodes.filter(node => node.group === groupId).map(node => node.id),
    ...architecture.groups.filter(group => group.parent === groupId).flatMap(group => [...members(group.id)]),
  ])
}
function ancestorGroups(groupId: string | null): string[] {
  return groupId ? [groupId, ...ancestorGroups(groupById.get(groupId)!.parent)] : []
}
function representative(nodeId: string, visible: CanvasNode[]): string {
  if (visible.some(node => node.id === nodeId)) return nodeId
  const collapsed = visible.filter(node => node.data.isGroup && !node.data.expanded && members(node.id).has(nodeId))
  assert.equal(collapsed.length, 1, `${nodeId} belongs to exactly one visible collapsed ancestor`)
  return collapsed[0].id
}
function overlaps(a: CanvasNode, b: CanvasNode): boolean {
  return a.position.x < b.position.x + b.width && b.position.x < a.position.x + a.width
    && a.position.y < b.position.y + b.height && b.position.y < a.position.y + a.height
}

test('every expansion combination preserves visibility, nested containment and every crossing connection exactly once', () => {
  const original = structuredClone(architecture)
  assert.equal(architecture.nodes.length, 67)
  assert.equal(architecture.edges.length, 93)
  assert.equal(architecture.edges.filter(edge => edge.id.startsWith('edge-')).length, 72, 'the original connections are retained')
  for (let combination = 0; combination < 2 ** groupIds.length; combination++) {
    const expanded = new Set(groupIds.filter((_, index) => combination & (1 << index)))
    const view = buildCanvas(architecture, expanded)
    const visible = new Map(view.nodes.map(node => [node.id, node]))
    assert.equal(visible.size, view.nodes.length)
    const expectedIds = [
      ...architecture.groups.filter(group => ancestorGroups(group.parent).every(id => expanded.has(id))).map(group => group.id),
      ...architecture.nodes.filter(node => ancestorGroups(node.group).every(id => expanded.has(id))).map(node => node.id),
    ]
    assert.deepEqual([...visible.keys()].sort(), expectedIds.sort(), `combination ${combination}: every visible component is present`)
    for (const [index, node] of view.nodes.entries()) {
      assert(Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
      assert(node.width > 0 && node.height > 0)
      const expectedParent = groupById.get(node.id)?.parent ?? architecture.nodes.find(original => original.id === node.id)?.group
      assert.equal(node.parentId, expectedParent ?? undefined)
      if (node.parentId) {
        const parent = visible.get(node.parentId)!
        assert(parent && parent.type === 'groupFrame')
        assert(view.nodes.indexOf(parent) < index, 'native parents are supplied before their children')
        assert.equal(node.extent, 'parent')
        assert(node.position.x >= 0 && node.position.y >= 0)
        assert(node.position.x + node.width <= parent.width, `${node.id} fits horizontally inside ${parent.id}`)
        assert(node.position.y + node.height <= parent.height, `${node.id} fits vertically inside ${parent.id}`)
      }
      if (node.data.isGroup) {
        assert.equal(node.type, expanded.has(node.id) ? 'groupFrame' : 'groupCard')
        assert.equal(node.data.expanded, expanded.has(node.id))
        assert.equal(node.data.count, members(node.id).size)
      }
    }
    // Packing leaves siblings, including root groups, apart at every expansion.
    for (let i = 0; i < view.nodes.length; i++) for (let j = i + 1; j < view.nodes.length; j++) {
      if (view.nodes[i].parentId === view.nodes[j].parentId) assert(!overlaps(view.nodes[i], view.nodes[j]), `${view.nodes[i].id} overlaps ${view.nodes[j].id}`)
    }
    const expected = architecture.edges.filter(edge => representative(edge.source, view.nodes) !== representative(edge.target, view.nodes))
    const counts = new Map<string, number>()
    for (const edge of view.edges) {
      assert(visible.has(edge.source) && visible.has(edge.target))
      assert.notEqual(edge.source, edge.target)
      assert(edge.data.connections.length > 0)
      for (const connection of edge.data.connections) {
        assert.deepEqual(connection, originalConnections.get(connection.id), 'full original connection data remains available')
        const source = representative(connection.source, view.nodes), target = representative(connection.target, view.nodes)
        const sameDirection = edge.source === source && edge.target === target
        const reverseDirection = edge.source === target && edge.target === source
        assert(sameDirection || (connection.bidirectional && reverseDirection), `${connection.id}: endpoint direction is preserved`)
        assert.equal(Boolean(edge.markerStart), connection.bidirectional, 'one-way and bidirectional connections are not conflated')
        counts.set(connection.id, (counts.get(connection.id) ?? 0) + 1)
      }
    }
    assert.deepEqual([...counts.keys()].sort(), expected.map(edge => edge.id).sort(), `combination ${combination}: all crossing connections retained`)
    assert([...counts.values()].every(count => count === 1), 'every retained original connection occurs once')
  }
  assert.deepEqual(architecture, original, 'expansion never mutates canonical architecture')
})

test('default canvas expands every group and exposes every component and connection', () => {
  const initial = buildCanvas(architecture)
  assert.deepEqual(initial.nodes.filter(node => node.type === 'groupFrame').map(node => node.id).sort(), [...groupIds].sort())
  assert.equal(initial.nodes.filter(node => node.type === 'groupCard').length, 0)
  assert.equal(initial.nodes.filter(node => node.type === 'mapNode').length, architecture.nodes.length)
  assert.equal(initial.edges.reduce((count, edge) => count + edge.data.connections.length, 0), architecture.edges.length)
  assert.deepEqual(initial, buildCanvas(architecture, new Set(groupIds)))
  const collapsed = buildCanvas(architecture, new Set())
  assert.equal(collapsed.nodes.filter(node => node.type === 'groupFrame').length, 0)
  assert(collapsed.nodes.some(node => node.id === 'MH' && node.type === 'groupCard'))
  assert(!collapsed.nodes.some(node => node.id === 'ENGINE' || node.id === 'AGENTS'))
})

test('saved positions override only their node, stay parent-relative and are not mutated by output dragging', () => {
  const expanded = new Set(['MH', 'ENGINE'])
  const positions: Record<string, Position> = {
    MH: { x: -1800, y: 75 },
    CORE: { x: 1000, y: 2000 },
  }
  const originalArchitecture = structuredClone(architecture)
  const originalPositions = structuredClone(positions)
  const originalExpanded = new Set(expanded)
  const view = buildCanvas(architecture, expanded, positions)
  const mh = view.nodes.find(node => node.id === 'MH')!
  const catalog = view.nodes.find(node => node.id === 'CORE')!
  const agents = view.nodes.find(node => node.id === 'ENGINE')!
  assert.deepEqual(mh.position, positions.MH, 'root positions remain root-relative')
  assert.deepEqual(catalog.position, positions.CORE, 'nested positions remain relative to their parent')
  assert.equal(catalog.parentId, 'ENGINE')
  assert(agents.width >= catalog.position.x + catalog.width && agents.height >= catalog.position.y + catalog.height, 'frame grows to encompass saved child positions')
  mh.position.x = 999
  catalog.position.y = 999
  assert.deepEqual(positions, originalPositions, 'the canvas does not retain mutable aliases to saved positions')
  assert.deepEqual(architecture, originalArchitecture)
  assert.deepEqual(expanded, originalExpanded)
  const emptySaved = buildCanvas(architecture, expanded, {})
  assert.notDeepEqual(emptySaved.nodes.find(node => node.id === 'CORE')!.position, positions.CORE)
})


test('semantic defaults follow the main interaction path and meaningful internal rows', () => {
  const initial = buildCanvas(architecture)
  const root = new Map(initial.nodes.map(node => [node.id, node]))
  assert(root.get('HUMAN')!.position.x < root.get('MH')!.position.x)
  assert.equal(root.get('INPUTS')!.parentId, 'MH')
  assert.equal(root.get('WEB')!.parentId, 'INPUTS')
  assert.equal(root.get('CLI')!.parentId, 'INPUTS')
  assert.equal(root.get('MOBILE')!.parentId, 'INPUTS')
  for (const id of ['CHAT', 'GRAPHEDITOR', 'ARCHMAP']) assert.equal(root.get(id)!.parentId, 'INPUTS')
  assert.equal(root.get('MH')!.data.groupLabel, 'Software system')
  assert.equal(root.get('ENGINE')!.data.groupLabel, 'Shared library')
  assert.equal(root.get('ENGINE')!.data.boundary, 'library')
  for (const id of ['WEB', 'CLI', 'MOBILEBACKEND']) assert.equal(root.get(id)!.data.runtime, 'process')
  for (const id of ['STATE', 'TRAINING']) assert.equal(root.get(id)!.parentId, 'MH')
  for (const id of ['BC', 'BODY', 'INFERENCE']) assert.equal(root.get(id)!.parentId, undefined)
  assert(root.get('MH')!.position.x < root.get('BC')!.position.x)
  assert(root.get('BC')!.position.x < root.get('BODY')!.position.x)
  assert.equal(root.get('MH')!.position.y, root.get('BC')!.position.y)
  assert(root.get('INFERENCE')!.position.y > root.get('MH')!.position.y)
  const full = buildCanvas(architecture, new Set(groupIds))
  const nodes = new Map(full.nodes.map(node => [node.id, node]))
  const rowOrder = (ids: string[]) => {
    for (let index = 1; index < ids.length; index++) {
      assert.equal(nodes.get(ids[index - 1])!.position.y, nodes.get(ids[index])!.position.y, `${ids.join(' → ')} shares a row`)
      assert(nodes.get(ids[index - 1])!.position.x < nodes.get(ids[index])!.position.x, `${ids.join(' → ')} reads left to right`)
    }
  }
  rowOrder(['CORE', 'TASKS', 'WORKFLOWS', 'ROUTER'])
  rowOrder(['CHAT', 'GRAPHEDITOR', 'ARCHMAP'])
  rowOrder(['ADAPTER', 'GW', 'MOTION', 'GEN'])
  rowOrder(['MIC', 'P4', 'BODYOUT'])
  const agents = full.nodes.filter(node => node.parentId === 'AGENTS').sort((a, b) => a.position.y - b.position.y)
  assert.equal(agents.length, 18)
  assert.deepEqual(agents.slice(0, 4).map(node => node.id), ['AGENTCONTROL', 'TRIGGERS', 'AGENTSERVICE', 'AGENTMONITOR'])
  assert.deepEqual(agents.filter(node => node.data.sectionTitle).map(node => node.data.sectionTitle), ['System infrastructure', 'Finite agents', 'Workflows', 'Persistent services'])
  assert.equal(agents[0].data.entryType, 'Registry')
  assert.equal(agents[0].data.entryCategory, 'infrastructure')
  for (const [index, node] of agents.entries()) {
    assert.equal(node.data.presentation, 'list')
    assert.equal(node.draggable, false)
    assert.equal(node.width, 480)
    assert.equal(node.height, 76)
    assert.equal(node.position.x, agents[0].position.x)
    assert.equal(node.data.runtime, ['agents', 'services'].includes(String(node.data.entryCategory)) ? 'process' : 'library')
    if (index) assert.equal(node.position.y, agents[index - 1].position.y + agents[index - 1].height + 8 + (node.data.sectionTitle ? 36 : 0))
  }
  const savedGrid = buildCanvas(architecture, new Set(groupIds), { AGENTCONTROL: { x: 1000, y: 2000 } })
  assert.deepEqual(savedGrid.nodes.find(node => node.id === 'AGENTCONTROL')!.position, agents.find(node => node.id === 'AGENTCONTROL')!.position, 'old card coordinates do not split the list apart')
  assert(nodes.get('INPUTS')!.position.y < nodes.get('ENGINE')!.position.y)
  assert.equal(nodes.get('AGENTS')!.position.y, nodes.get('STATE')!.position.y)
  assert(nodes.get('TRAINING')!.position.y > nodes.get('AGENTS')!.position.y)
  rowOrder(['UI', 'WEB', 'CLI'])
  assert(nodes.get('ENGINE')!.position.y < nodes.get('AGENTS')!.position.y)
  assert(nodes.get('API')!.position.y < nodes.get('QWEN9')!.position.y)
  assert(nodes.get('API')!.position.y < nodes.get('FMODEL')!.position.y)
})

test('ports use facing sides derived from absolute nested centers, including reverse canonical bidirectional edges', () => {
  for (const expanded of [new Set<string>(), new Set(['MH']), new Set(groupIds)]) {
    const view = buildCanvas(architecture, expanded)
    const nodes = new Map(view.nodes.map(node => [node.id, node]))
    const origin = (node: CanvasNode): Position => {
      const parent = node.parentId ? origin(nodes.get(node.parentId)!) : { x: 0, y: 0 }
      return { x: node.position.x + parent.x, y: node.position.y + parent.y }
    }
    for (const edge of view.edges) {
      const source = nodes.get(edge.source)!, target = nodes.get(edge.target)!
      const a = origin(source), b = origin(target)
      const dx = b.x + target.width / 2 - a.x - source.width / 2
      const dy = b.y + target.height / 2 - a.y - source.height / 2
      if (Math.abs(dx) >= Math.abs(dy)) {
        assert.equal(edge.sourceHandle, dx >= 0 ? 'out-right' : 'out-left')
        assert.equal(edge.targetHandle, dx >= 0 ? 'in-left' : 'in-right')
      } else {
        assert.equal(edge.sourceHandle, dy >= 0 ? 'out-bottom' : 'out-top')
        assert.equal(edge.targetHandle, dy >= 0 ? 'in-top' : 'in-bottom')
      }
    }
  }
  const root = buildCanvas(architecture, new Set())
  const reverseEdge = root.edges.find(edge => edge.source === 'BC' && edge.target === 'MH' && edge.markerStart)
  assert(reverseEdge, 'the original MH/BC bidirectional connection is canonically ordered in reverse physical direction')
  assert.equal(reverseEdge.sourceHandle, 'out-left')
  assert.equal(reverseEdge.targetHandle, 'in-right')
})


test('person circles sit outside the software boundary while shaped cards reserve room for inset text', () => {
  const initial = buildCanvas(architecture)
  const human = initial.nodes.find(node => node.id === 'HUMAN')!
  const mh = initial.nodes.find(node => node.id === 'MH')!
  assert.equal(human.width, 160)
  assert.equal(human.height, 160)
  assert.equal(human.parentId, undefined)
  assert(human.position.x + human.width < mh.position.x)
  const full = buildCanvas(architecture, new Set(groupIds))
  for (const source of architecture.nodes) {
    const node = full.nodes.find(node => node.id === source.id)!
    if (source.shape === '((' || source.group === 'AGENTS') continue
    assert.equal(node.width, 260, `${source.id} retains the shared component width`)
    if (['{{', '[/', '>'].includes(source.shape ?? '')) {
      const textHeight = 74 + Math.max(1, Math.ceil(source.title.length / 25)) * 21 + Math.ceil(source.description.length / 32) * 18
      assert(node.height >= textHeight + 30, `${source.id} leaves space for the shape's inset edges`)
      assert(node.height >= 178)
    }
    if (source.shape === '([') {
      const textHeight = 74 + Math.max(1, Math.ceil(source.title.length / 25)) * 21 + Math.ceil(source.description.length / 28) * 18
      assert(node.height >= textHeight + 20, `${source.id} leaves space for capsule corners`)
    }
  }
  const saved = buildCanvas(architecture, new Set(), { HUMAN: { x: 410, y: 19 } })
  assert.deepEqual(saved.nodes.find(node => node.id === 'HUMAN')!.position, { x: 410, y: 19 }, 'manual positioning overrides the default person position')
})

test('saved coordinates from smaller or reparented groups cannot overlap visible siblings after expansion', () => {
  const saved: Record<string, Position> = {
    MH: { x: 216, y: 216 }, BC: { x: 1200, y: 216 }, BODY: { x: 1800, y: 216 },
    INFERENCE: { x: 216, y: 1200 }, INPUTS: { x: 0, y: 216 },
    WEB: { x: 520, y: 94 }, ENGINE: { x: 32, y: 420 }, AGENTS: { x: 32, y: 900 },
  }
  for (const expanded of [new Set<string>(), new Set(['MH']), new Set(['MH', 'INPUTS', 'ENGINE']), new Set(groupIds)]) {
    const view = buildCanvas(architecture, expanded, saved)
    for (const [index, node] of view.nodes.entries()) {
      if (node.parentId) {
        assert(node.position.x >= 32 && node.position.y >= 94, `${node.id} clears its parent header`)
      }
      for (const other of view.nodes.slice(index + 1)) {
        if (node.parentId === other.parentId) assert(!overlaps(node, other), `${node.id} overlaps ${other.id} with saved coordinates`)
      }
    }
  }
})
