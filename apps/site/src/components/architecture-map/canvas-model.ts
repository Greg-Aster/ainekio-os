export type Position = { x: number; y: number }
export type Architecture = {
  sourceDocument: string
  groups: Array<{ id: string; title: string; description: string; parent: string | null; boundary?: string }>
  nodes: Array<{ id: string; title: string; description: string; details: string[] | string; sourcePaths: string[]; class: string; group: string | null; endpoints?: string[]; shape?: string; runtime?: string; typeLabel?: string }>
  edges: Array<{ id: string; source: string; target: string; label: string; bidirectional: boolean; kind: string }>
}
export type CanvasNode = {
  id: string
  type: 'groupCard' | 'groupFrame' | 'mapNode'
  position: Position
  parentId?: string
  extent?: 'parent'
  width: number
  height: number
  style: string
  draggable?: boolean
  data: Record<string, unknown> & {
    title: string
    description: string
    kind: string
    isGroup: boolean
    expanded: boolean
    width: number
    height: number
    groupId?: string
    count?: number
  }
}
export type CanvasEdge = {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  type: string
  label: string
  markerEnd: { type: string; color: string }
  markerStart?: { type: string; color: string }
  style: string
  labelStyle: string
  labelBgStyle: string
  data: { connections: Architecture['edges'] }
}

type Size = { width: number; height: number }
type Placed = Size & { id: string; position: Position; children: Placed[] }
const PADDING = 32
const HEADER = 94
const GAP = 56
const GROUP_WIDTH = 300
const GROUP_HEIGHT = 180
const NODE_WIDTH = 260
const agentSections = [
  { id: 'infrastructure', title: 'System infrastructure', nodes: ['AGENTCONTROL', 'TRIGGERS', 'AGENTSERVICE', 'AGENTMONITOR', 'BRAIN'] },
  { id: 'agents', title: 'Finite agents', nodes: ['MEMAGENTS', 'TRAINAGENTS', 'THOUGHTAGENTS', 'CURIOSITYAGENTS', 'PERSONAAGENTS', 'DESIREAGENT', 'UTILITYAGENTS'] },
  { id: 'workflows', title: 'Workflows', nodes: ['SLEEPAGENT', 'ROBOTWORKFLOWS'] },
  { id: 'services', title: 'Persistent services', nodes: ['OPERATORAGENT', 'BRIDGE', 'TERMINALAGENT', 'MAINTAGENT'] },
]
const agentEntryTypes: Record<string, string> = {
  AGENTCONTROL: 'Registry', TRIGGERS: 'Scheduler', AGENTSERVICE: 'Process manager',
  AGENTMONITOR: 'Monitor', BRAIN: 'Execution adapters', DESIREAGENT: 'Worker process',
}
const boundaryLabels: Record<string, string> = {
  system: 'Software system', library: 'Shared library', area: 'Functional area',
  data: 'Stored data', external: 'External system', hardware: 'Hardware',
}
const groupKinds: Record<string, string> = {
  MH: 'brain', ENGINE: 'engine', AGENTS: 'brain', BC: 'control', BODY: 'body',
  INFERENCE: 'provider', INPUTS: 'ui', LLAMA: 'provider', OTHER: 'provider', SPEECH: 'speech',
  STATE: 'support', TRAINING: 'execution',
}

export function defaultExpandedGroups(architecture: Architecture): Set<string> {
  return new Set(architecture.groups.map(group => group.id))
}

export function buildCanvas(
  architecture: Architecture,
  expanded: ReadonlySet<string> = defaultExpandedGroups(architecture),
  positions: Record<string, Position> = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const groups = new Map(architecture.groups.map(group => [group.id, group]))
  const components = new Map(architecture.nodes.map(node => [node.id, node]))
  const children = (parent: string | null): string[] => [
    ...architecture.nodes.filter(node => node.group === parent).map(node => node.id),
    ...architecture.groups.filter(group => group.parent === parent).map(group => group.id),
  ]
  const descendantCount = (groupId: string): number => architecture.nodes.filter(node => {
    let parent = node.group
    while (parent) { if (parent === groupId) return true; parent = groups.get(parent)!.parent }
    return false
  }).length

  function place(item: Placed, preferred: Position, siblings: Placed[], direction: 'x' | 'y'): void {
    item.position = { ...preferred }
    for (;;) {
      const collisions = siblings.filter(other =>
        item.position.x < other.position.x + other.width && other.position.x < item.position.x + item.width
        && item.position.y < other.position.y + other.height && other.position.y < item.position.y + item.height)
      if (!collisions.length) break
      item.position[direction] = Math.max(...collisions.map(other => other.position[direction] + (direction === 'x' ? other.width : other.height))) + GAP
    }
    siblings.push(item)
  }

  // Rows follow the information path, rather than source declaration order.
  // Empty cells align side branches with the controller they connect to.
  const rowPlans: Record<string, Array<Array<string | null>>> = {
    INPUTS: [['UI', 'WEB', 'CLI'], ['CHAT', 'GRAPHEDITOR', 'ARCHMAP'], ['MOBILE', 'MOBILEBACKEND', null]],
    MH: [['INPUTS'], ['ENGINE'], ['AGENTS', 'STATE'], ['TRAINING']],
    STATE: [['PROFILEDATA', 'WORKSTATE'], ['CONFIG', 'TRAINARTIFACTS']],
    TRAINING: [['PERSONALTRAIN', 'ACTIONTRAIN']],
    ENGINE: [
      ['CORE', 'TASKS', 'WORKFLOWS', 'ROUTER'],
      ['CONTEXT', 'TOOLS', 'VOICE', 'ROBOTENGINE'],
      ['PROFILES', 'MEMORY', 'AGENCY', 'LEARNING'],
    ],
    AGENTS: agentSections.flatMap(section => section.nodes.map(id => [id])),
    BC: [[null, 'DASH', null, null], ['ADAPTER', 'GW', 'MOTION', 'GEN'], [null, 'HOSTAUDIO', null, null]],
    BODY: [['MIC', 'P4', 'BODYOUT'], ['SENSORS', null, null]],
    INFERENCE: [['LLAMA'], ['OTHER', 'SPEECH']],
    LLAMA: [[null, 'API', null], ['QWEN9', 'ENV08', 'ENV2'], ['FMODEL', 'EMBED', 'NOMIC']],
    OTHER: [['CODEX', 'OLLAMA', 'RUNPOD']],
    SPEECH: [['WHISPER', 'KOKORO']],
  }

  function packRows(parent: string, items: Placed[]): void {
    const byId = new Map(items.map(item => [item.id, item]))
    const planned = new Set((rowPlans[parent] ?? []).flat().filter((id): id is string => id !== null))
    const rows = (rowPlans[parent] ?? []).map(row => row.map(id => id ? byId.get(id) ?? null : null))
    const remaining = items.filter(item => !planned.has(item.id))
    const columns = parent === 'AGENTS' ? 1 : 2
    for (let index = 0; index < remaining.length; index += columns) rows.push(remaining.slice(index, index + columns))
    const occupiedRows = rows.filter(row => row.some(item => item !== null))
    const widths = occupiedRows.map(row => row.reduce((width, item) => width + (item?.width ?? NODE_WIDTH), 0) + Math.max(0, row.length - 1) * GAP)
    const widest = Math.max(0, ...widths)
    const placed: Placed[] = []
    let y = HEADER
    for (let rowIndex = 0; rowIndex < occupiedRows.length; rowIndex++) {
      const row = occupiedRows[rowIndex]
      if (parent === 'AGENTS' && agentSections.some(section => section.nodes[0] === row[0]?.id)) y += 36
      let x = PADDING + (widest - widths[rowIndex]) / 2
      for (const item of row) {
        if (item) {
          const preferred = parent !== 'AGENTS' && positions[item.id] ? positions[item.id] : { x, y }
          place(item, { x: Math.max(PADDING, preferred.x), y: Math.max(HEADER, preferred.y) }, placed, 'y')
          x += item.width + GAP
        } else x += NODE_WIDTH + GAP
      }
      y = Math.max(...row.map(item => item ? item.position.y + item.height : y)) + (parent === 'AGENTS' ? 8 : GAP)
    }
  }

  function packRoots(items: Placed[]): void {
    const byId = new Map(items.map(item => [item.id, item]))
    const human = byId.get('HUMAN')
    const leftWidth = human?.width ?? 0
    const mainY = 0
    const defaults: Record<string, Position> = { HUMAN: { x: 0, y: HEADER } }
    let x = leftWidth + GAP
    for (const id of ['MH', 'BC', 'BODY']) {
      const item = byId.get(id)
      if (!item) continue
      defaults[id] = { x, y: mainY }
      x += item.width + GAP
    }
    defaults.INFERENCE = {
      x: leftWidth + GAP,
      y: mainY + Math.max(...['MH', 'BC', 'BODY'].map(id => byId.get(id)?.height ?? 0)) + GAP,
    }
    let extraY = Math.max(...items.filter(item => defaults[item.id]).map(item => defaults[item.id].y + item.height)) + GAP
    const placed: Placed[] = []
    for (const item of items) {
      const defaultPosition = defaults[item.id] ?? { x: 0, y: extraY }
      place(item, positions[item.id] ?? defaultPosition, placed, ['MH', 'BC', 'BODY'].includes(item.id) ? 'x' : 'y')
      if (!defaults[item.id]) extraY += item.height + GAP
    }
  }

  function measure(id: string): Placed {
    const group = groups.get(id)
    if (!group) {
      const node = components.get(id)!
      if (node.group === 'AGENTS') return { id, width: 480, height: 76, position: { x: 0, y: 0 }, children: [] }
      if (node.class === 'human' || node.shape === '((') return { id, width: 160, height: 160, position: { x: 0, y: 0 }, children: [] }
      const insetShape = ['{{', '[/', '>'].includes(node.shape ?? '')
      const capsule = node.shape === '(['
      const extraHeight = insetShape ? 30 : capsule ? 20 : 0
      const titleLines = Math.max(1, Math.ceil(node.title.length / 25))
      const descriptionLines = Math.ceil(node.description.length / (capsule ? 28 : 32))
      return { id, width: NODE_WIDTH, height: Math.max(148 + extraHeight, 74 + titleLines * 21 + descriptionLines * 18 + extraHeight), position: { x: 0, y: 0 }, children: [] }
    }
    if (!expanded.has(id)) return { id, width: GROUP_WIDTH, height: GROUP_HEIGHT, position: { x: 0, y: 0 }, children: [] }
    const nested = children(id).map(measure)
    packRows(id, nested)
    return {
      id, children: nested, position: { x: 0, y: 0 },
      width: Math.max(GROUP_WIDTH, ...nested.map(item => item.position.x + item.width + PADDING)),
      height: Math.max(HEADER + PADDING, ...nested.map(item => item.position.y + item.height + PADDING)),
    }
  }

  const roots = children(null).map(measure)
  packRoots(roots)
  const nodes: CanvasNode[] = []
  function append(item: Placed, parentId?: string): void {
    const group = groups.get(item.id)
    const component = components.get(item.id)
    const agentSection = component?.group === 'AGENTS' ? agentSections.find(section => section.nodes.includes(item.id)) : undefined
    const isExpanded = Boolean(group && expanded.has(item.id))
    nodes.push({
      id: item.id, type: group ? isExpanded ? 'groupFrame' : 'groupCard' : 'mapNode',
      position: { ...item.position }, ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      width: item.width, height: item.height, style: `width:${item.width}px;height:${item.height}px`,
      ...(component?.group === 'AGENTS' ? { draggable: false } : {}),
      data: {
        ...(component ?? group), title: (component ?? group)!.title, description: (component ?? group)!.description,
        kind: component?.class ?? groupKinds[item.id] ?? 'support',
        isGroup: Boolean(group), expanded: isExpanded, width: item.width, height: item.height,
        ...(group ? { groupId: group.id, count: descendantCount(group.id) } : {}),
        groupLabel: group ? boundaryLabels[group.boundary ?? 'area'] : component?.class,
        ...(agentSection ? {
          presentation: 'list', entryCategory: agentSection.id,
          entryType: agentEntryTypes[item.id] ?? (agentSection.id === 'agents' ? 'Worker processes' : agentSection.id === 'workflows' ? 'Workflow' : 'Service process'),
          runtime: ['agents', 'services'].includes(agentSection.id) ? 'process' : 'library',
          sectionTitle: agentSection.nodes[0] === item.id ? agentSection.title : undefined,
        } : {}),
      },
    })
    for (const child of item.children) append(child, item.id)
  }
  for (const root of roots) append(root)

  function representative(nodeId: string): string {
    let result = nodeId
    let parent = components.get(nodeId)!.group
    while (parent) {
      if (!expanded.has(parent)) result = parent
      parent = groups.get(parent)!.parent
    }
    return result
  }
  type Aggregate = { source: string; target: string; bidirectional: boolean; primary: boolean; conditional: boolean; connections: Architecture['edges'] }
  const aggregate = new Map<string, Aggregate>()
  for (const connection of architecture.edges) {
    let source = representative(connection.source), target = representative(connection.target)
    if (source === target) continue
    if (connection.bidirectional && source > target) [source, target] = [target, source]
    const id = `${source}:${target}:${connection.bidirectional ? 'both' : 'one'}`
    const entry = aggregate.get(id) ?? { source, target, bidirectional: connection.bidirectional, primary: false, conditional: true, connections: [] }
    entry.connections.push({ ...connection })
    entry.primary ||= connection.kind === 'primary'
    entry.conditional &&= connection.kind === 'conditional'
    aggregate.set(id, entry)
  }
  const visible = new Map(nodes.map(node => [node.id, node]))
  const centers = new Map<string, Position>()
  function center(id: string): Position {
    const cached = centers.get(id)
    if (cached) return cached
    const node = visible.get(id)!
    const parent = node.parentId ? visible.get(node.parentId)! : undefined
    const parentCenter = parent ? center(parent.id) : { x: 0, y: 0 }
    const result = {
      x: node.position.x + node.width / 2 + (parent ? parentCenter.x - parent.width / 2 : 0),
      y: node.position.y + node.height / 2 + (parent ? parentCenter.y - parent.height / 2 : 0),
    }
    centers.set(id, result)
    return result
  }
  const edges: CanvasEdge[] = [...aggregate.entries()].map(([id, edge]) => {
    const source = center(edge.source), target = center(edge.target)
    const dx = target.x - source.x, dy = target.y - source.y
    const horizontal = Math.abs(dx) >= Math.abs(dy)
    const sourceSide = horizontal ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top'
    const targetSide = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[sourceSide]
    return {
      id, source: edge.source, target: edge.target, sourceHandle: `out-${sourceSide}`, targetHandle: `in-${targetSide}`, type: 'smoothstep',
      label: edge.connections.length === 1 ? edge.connections[0].label : `${edge.connections.length} connections`,
      markerEnd: { type: 'arrowclosed', color: edge.primary ? '#a6b5c9' : '#59687e' },
      ...(edge.bidirectional ? { markerStart: { type: 'arrowclosed', color: '#59687e' } } : {}),
      style: `stroke:${edge.primary ? '#a6b5c9' : '#59687e'};stroke-width:${edge.primary ? 2 : 1.3};${edge.conditional ? 'stroke-dasharray:5 5;' : ''}`,
      labelStyle: 'fill:#aab8ce;font-size:11px', labelBgStyle: 'fill:#101724;fill-opacity:0.95',
      data: { connections: edge.connections },
    }
  })

  return { nodes, edges }
}
