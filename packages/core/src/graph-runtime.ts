/**
 * Shared graph runtime helpers.
 *
 * This module keeps graph runners thin without changing graph execution
 * semantics. Missing executors remain report-only here; executeGraph still
 * owns runtime behavior.
 */

import path from 'node:path'
import type { ResponseEntryReference } from './cognitive-graph-contract.js'
import type { SvelteFlowGraph, SvelteFlowNode } from './cognitive-graph-schema.js'
import {
  executeGraph,
  getGraphOutput,
  type ExecutionEventHandler,
  type GraphExecutionState,
} from './graph-executor.js'
import { getNodeExecutor } from './nodes/index.js'
import { ROOT } from './path-builder.js'
import type { DurableGraphOptions } from './durable-execution/graph-contract.js'
import { runDurableGraph } from './durable-execution/runtime.js'

export interface GraphRunParams {
  graph: SvelteFlowGraph;
  context: Record<string, any>;
  eventHandler?: ExecutionEventHandler;
  signal?: AbortSignal;
  execution?: DurableGraphOptions;
  executionId?: string;
  resumeEventId?: string;
}

export { loadGraphFile, type CachedGraphEntry } from './graph-streaming.js'

export interface FailedGraphNode {
  nodeId: string;
  error: string;
}

export interface MissingExecutorInfo {
  nodeId: string;
  nodeType: string;
  label?: string;
}

export interface SkippedGraphNode {
  nodeId: string;
  reason: string;
}

export class AsyncEventQueue {
  private queue: string[] = []
  private resolvers: Array<(value: IteratorResult<string>) => void> = []
  private done = false

  push(event: string): void {
    if (this.done) return

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!
      resolver({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  finish(): void {
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!
      resolver({ value: undefined as any, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else if (this.done) {
        return
      } else {
        const event = await new Promise<IteratorResult<string>>(resolve => {
          this.resolvers.push(resolve)
        })
        if (event.done) return
        yield event.value
      }
    }
  }
}

export function sseData(type: string, data: any): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`
}

export function namedSse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function runGraph(params: GraphRunParams): Promise<GraphExecutionState> {
  return params.execution
    ? executeGraph(params.graph, params.context, params.eventHandler, params.signal, params.execution)
    : runDurableGraph(params)
}

export function extractGraphOutput(graphState: GraphExecutionState): Record<string, any> | null {
  return getGraphOutput(graphState)
}

/** Identify a saved response only when its actual output wiring proves the association. */
export function findResponseEntryReference(
  graph: SvelteFlowGraph,
  state: GraphExecutionState,
  output: Record<string, any> | null,
  outputPort: 'output' | 'response',
): ResponseEntryReference | undefined {
  const selected = [...state.nodes].filter(([, node]) => node.status === 'completed' && node.outputs === output)
  if (selected.length !== 1) return undefined
  const passthrough: Record<string, readonly string[]> = {
    stream_writer: ['output', 'response'],
    thinking_stripper: ['stripped', 'content', 'response'],
    response_action_router: ['response'],
    response_context_writer: ['response'],
    conversation_buffer: ['response'],
  }
  const origin = (nodeId: string, port: string): string | undefined => {
    const visited = new Set<string>()
    while (true) {
      const key = JSON.stringify([nodeId, port])
      const node = state.nodes.get(nodeId)
      if (visited.has(key) || node?.status !== 'completed' || node.outputs?.[port] == null) return undefined
      visited.add(key)
      const type = node.definition?.type || ''
      if (!passthrough[type]?.includes(port)) return key
      if (type === 'conversation_buffer' && node.inputs?.entry?.role === 'assistant') return key
      if (!node.inputs || !Object.hasOwn(node.inputs, 'response')) return undefined
      const incoming = graph.edges.filter(edge => edge.target === nodeId && edge.targetHandle === 'response')
      // A Buffer may receive an explicit typed entry instead of a response input.
      if (type === 'conversation_buffer' && incoming.length === 0) return key
      if (incoming.length !== 1 || !incoming[0].sourceHandle) return undefined
      nodeId = incoming[0].source
      port = incoming[0].sourceHandle
    }
  }
  const selectedOrigin = origin(selected[0][0], outputPort)
  if (!selectedOrigin) return undefined
  const candidates: string[] = []
  for (const [nodeId, node] of state.nodes) {
    if (node.definition?.type !== 'conversation_buffer' || node.status !== 'completed' || node.outputs?.persisted !== true) continue
    if (graph.nodes.find(entry => entry.id === nodeId)?.data?.properties?.mode === 'terminal') continue
    if (origin(nodeId, 'response') !== selectedOrigin) continue
    const entries = Array.isArray(node.outputs.entries)
      ? node.outputs.entries.filter((entry: { role?: string }) => entry.role === 'assistant') : []
    if (entries?.length !== 1 || typeof entries[0].meta?.idempotencyKey !== 'string' || !entries[0].meta.idempotencyKey) continue
    candidates.push(entries[0].meta.idempotencyKey)
  }
  return candidates.length === 1 ? { mode: 'conversation', id: candidates[0] } : undefined
}

export function collectNodeOutputs(graphState: GraphExecutionState): Record<string, any> {
  const nodeOutputs: Record<string, any> = {}
  graphState.nodes.forEach((nodeState, nodeId) => {
    if (nodeState.outputs) {
      nodeOutputs[nodeId] = nodeState.outputs
    }
  })
  return nodeOutputs
}

/**
 * Return the completed output for exactly one graph node type.
 *
 * Graph files are editable, so callers must not couple behavior to visual node
 * ids. The node type is the executable contract shared by the graph and its
 * owner. Ambiguous, missing, failed, or output-less matches are contract
 * failures rather than empty-output fallbacks.
 */
export function requireGraphNodeOutput(
  graphState: GraphExecutionState,
  nodeType: string,
): Record<string, any> {
  const matches = [...graphState.nodes.values()]
    .filter(node => node.definition?.type === nodeType)

  if (matches.length !== 1) {
    throw new Error(
      `Graph contract requires exactly one ${nodeType} node; found ${matches.length}`,
    )
  }

  const [match] = matches
  if (match.status !== 'completed') {
    throw new Error(`Graph node ${nodeType} ended with status ${match.status}`)
  }
  if (!match.outputs) {
    throw new Error(`Graph node ${nodeType} produced no outputs`)
  }

  return match.outputs
}

export function listExecutedNodes(graphState: GraphExecutionState): string[] {
  return [...graphState.nodes.entries()]
    .filter(([, nodeState]) => nodeState.status === 'completed' || nodeState.status === 'failed')
    .map(([nodeId]) => nodeId)
}

export function listSkippedNodes(graphState: GraphExecutionState): SkippedGraphNode[] {
  return [...graphState.nodes.entries()]
    .filter(([, nodeState]) => nodeState.status === 'skipped')
    .map(([nodeId, nodeState]) => ({
      nodeId,
      reason: nodeState.skipReason || 'Node was not activated',
    }))
}

export function listFailedNodes(graphState: GraphExecutionState): FailedGraphNode[] {
  const failedNodes: FailedGraphNode[] = []
  graphState.nodes.forEach((nodeState, nodeId) => {
    if (nodeState.status === 'failed') {
      failedNodes.push({
        nodeId,
        error: nodeState.error?.message || 'Unknown error',
      })
    }
  })
  return failedNodes
}

export function getFirstFailedNode(graphState: GraphExecutionState): FailedGraphNode | null {
  return listFailedNodes(graphState)[0] ?? null
}

export function extractQueuedTTSOutput(graphState: GraphExecutionState): {
  text: string;
  itemId?: string;
  mode?: 'conversation' | 'inner';
  source?: string;
} | null {
  let latest: { text: string; itemId?: string; mode?: 'conversation' | 'inner'; source?: string } | null = null

  for (const [, nodeState] of graphState.nodes) {
    if (nodeState.status !== 'completed' || !nodeState.outputs) continue

    const outputs = nodeState.outputs
    if (outputs.queued === true && typeof outputs.text === 'string' && outputs.text.trim()) {
      latest = {
        text: outputs.text.trim(),
        itemId: typeof outputs.itemId === 'string' ? outputs.itemId : undefined,
        mode: outputs.conversationQueued ? 'conversation' : outputs.innerQueued ? 'inner' : undefined,
        source: nodeState.definition?.type,
      }
    }
  }

  return latest
}

export function getGraphNodeType(node: SvelteFlowNode): string {
  return node.data?.nodeType || node.type || node.id
}

export function findMissingExecutors(graph: SvelteFlowGraph): MissingExecutorInfo[] {
  const missing: MissingExecutorInfo[] = []

  for (const node of graph.nodes) {
    const nodeType = getGraphNodeType(node)
    if (!getNodeExecutor(nodeType)) {
      missing.push({
        nodeId: node.id,
        nodeType,
        label: node.data?.label,
      })
    }
  }

  return missing
}

export function cognitiveGraphPath(fileName: string): string {
  return path.join(ROOT, 'etc', 'cognitive-graphs', fileName)
}
