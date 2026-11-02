import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ProviderMessage } from '../../providers/types.js'
import type { EscalationOptions } from '../../escalation-backend.js'
import type { BigBrotherCLIInvocation, ParsedBigBrotherEvent } from './cli.js'

interface CodexItem {
  id: string
  type: string
  text?: string
  phase?: string | null
  summary?: string[]
  command?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
}
interface CodexNotification {
  threadId?: string
  turnId?: string
  delta?: string
  itemId?: string
  item?: CodexItem
  turn?: { id: string; status: string; error?: { message: string } | null; items?: CodexItem[] }
  error?: { message: string }
  willRetry?: boolean
}
interface RpcMessage {
  id?: number | string
  method?: string
  params?: CodexNotification
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function parts(message: ProviderMessage) {
  return typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
}

/** One native model turn inside the existing terminal process and cleanup owner. */
export async function runCodexModelTurn(
  child: ChildProcessWithoutNullStreams,
  request: NonNullable<EscalationOptions['modelRequest']>,
  settings: NonNullable<BigBrotherCLIInvocation['appServer']>,
  cwd: string,
  emit: (event: ParsedBigBrotherEvent) => Promise<void>,
): Promise<string> {
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let sequence = 0
  let threadId: string | undefined
  let turnId: string | undefined
  let turnRequested = false
  let finished = false
  let protocolError: Error | undefined
  const streamedItems = new Set<string>()
  const finalMessages = new Map<string, string>()
  let resolveTurn!: () => void
  let rejectTurn!: (error: Error) => void
  const completion = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
  // A protocol failure can arrive before the turn has been admitted.
  completion.catch(() => {})
  const fail = (error: Error) => {
    protocolError ||= error
    for (const wait of pending.values()) wait.reject(error)
    pending.clear()
    rejectTurn(error)
  }
  const onInputError = (error: Error) => fail(error)
  child.stdin.on('error', onInputError)
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`)
  const call = <T>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    if (protocolError) { reject(protocolError); return }
    const id = ++sequence
    pending.set(id, { resolve: value => resolve(value as T), reject })
    send({ id, method, params })
  })
  const collect = (item: CodexItem) => {
    if (item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') finalMessages.set(item.id, item.text)
  }
  const input = (async () => {
    try {
      for await (const line of reader) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as RpcMessage
        if (message.id !== undefined && !message.method) {
          const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined
          if (!waiting) continue
          pending.delete(message.id as number)
          if (message.error) waiting.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`))
          else waiting.resolve(message.result)
          continue
        }
        if (message.id !== undefined && message.method) {
          throw new Error(`Codex requested ${message.method}, which requires an interactive agent session`)
        }
        const event = message.params || {}
        if (threadId && event.threadId && event.threadId !== threadId) continue
        if (message.method === 'turn/started' && turnRequested && event.turn) { turnId = event.turn.id; continue }
        if (event.turnId && event.turnId !== turnId) continue
        if (message.method === 'item/agentMessage/delta' && typeof event.delta === 'string') {
          if (event.itemId) streamedItems.add(event.itemId)
          await emit({ displayLines: [event.delta], reasoningSteps: [] })
        } else if (message.method === 'item/completed' && event.item) {
          const item = event.item
          collect(item)
          if (item.type === 'agentMessage' && typeof item.text === 'string' && !streamedItems.has(item.id)) {
            await emit({ displayLines: [item.text], reasoningSteps: [] })
          } else if (item.type === 'reasoning') {
            await emit({ displayLines: item.summary || [], reasoningSteps: (item.summary || []).map(content =>
              ({ type: 'thought', content, timestamp: new Date().toISOString() })) })
          } else if (item.type === 'commandExecution') {
            await emit({ displayLines: [item.command, item.aggregatedOutput].filter((value): value is string => typeof value === 'string'),
              reasoningSteps: [{ type: 'tool_use', content: item.command || '', toolName: 'shell', timestamp: new Date().toISOString(),
                success: item.exitCode === 0 }] })
          }
        } else if (message.method === 'turn/completed' && event.turn) {
          if (event.turn.id !== turnId) continue
          if (event.turn.status !== 'completed') throw new Error(event.turn.error?.message || `Codex turn ${event.turn.status}`)
          for (const item of event.turn.items || []) collect(item)
          finished = true
          resolveTurn()
        } else if (message.method === 'error' && event.error && !event.willRetry) {
          throw new Error(event.error.message)
        }
      }
      if (!finished) fail(new Error('Codex app-server exited before completing the model turn'))
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })()
  try {
    await call('initialize', { clientInfo: { name: 'metahuman', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    send({ method: 'initialized', params: {} })
    const history = [...request.messages]
    const instructions: string[] = []
    // Only the leading textual system prefix becomes baseInstructions. Later
    // role-bearing messages and any image parts keep their exact history position.
    while (history[0]?.role === 'system' && parts(history[0]).every(part => part.type === 'text')) {
      instructions.push(parts(history.shift()!).map(part => part.type === 'text' ? part.text : '').join('\n'))
    }
    if (request.responseInstructions) instructions.push(request.responseInstructions)
    const started = await call<{ thread: { id: string } }>('thread/start', {
      model: settings.model, cwd: settings.cwd || cwd, ephemeral: settings.ephemeral,
      baseInstructions: instructions.join('\n\n'), developerInstructions: '',
    })
    threadId = started.thread.id
    await emit({ threadId, displayLines: [], reasoningSteps: [] })
    if (history.length) await call('thread/inject_items', { threadId, items: history.map(message => ({
      type: 'message', role: message.role,
      content: parts(message).map(part => part.type === 'text'
        ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail }),
    })) })
    turnRequested = true
    const turn = await call<{ turn: { id: string } }>('turn/start', { threadId, effort: settings.reasoning,
      input: [],
    })
    turnId = turn.turn.id
    await completion
    const finalText = [...finalMessages.values()].join('\n')
    await emit({ finalText, displayLines: [], reasoningSteps: [] })
    return finalText
  } finally {
    reader.close()
    child.stdin.off('error', onInputError)
    await input
  }
}
