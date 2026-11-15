import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { loadFreshOperatorConfig } from '../../config.js'
import type { EscalationOptions } from '../../escalation-backend.js'
import {
  DEFAULT_PROVIDER_IMAGE_POLICY,
  parseProviderImageDataUrl,
  type ProviderMessage,
} from '../../providers/types.js'
import { loadToolExecutorConfig, type CLIBackendConfig } from '../../tool-executor-config.js'
import { terminalJobs } from '../paths.js'
import { formatProviderDisplay, terminalHeading } from '../presentation.js'
import { TerminalProcess } from '../process.js'
import {
  providerLabel,
  type BigBrotherSessionResult,
  type ParsedBigBrotherEvent,
} from './cli.js'

const MAX_RESULT = 4 * 1024 * 1024
const WARM_SESSION_POOL_SIZE = 2
const ACP_INITIALIZE_TIMEOUT_MS = 30_000
const ACP_SESSION_CLOSE_TIMEOUT_MS = 3_000
const RM_RETRY_OPTIONS = { maxRetries: 5, retryDelay: 50 } as const

interface AcpRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, any>
  result?: Record<string, any>
  error?: { code: number; message: string; data?: unknown }
}

interface WarmAcpSession {
  modelId: string
  promise: Promise<{ sessionId: string; modelId: string }>
}

interface ActiveAcpDaemon {
  command: string
  child: ChildProcessWithoutNullStreams
  owned: TerminalProcess
  tempRoot: string
  isolatedAgyDir: string
  ready: Promise<void>
  closed: boolean
  sequence: number
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>
  sessionListeners: Map<string, (update: Record<string, any>) => Promise<void> | void>
  warmSessions: WarmAcpSession[]
  lastModelId: string
  teardown?: Promise<void>
}

function messageParts(message: ProviderMessage) {
  return typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content
}

function firstTopLevelJsonEnd(text: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  let started = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      started = true
      continue
    }
    if (ch === '{' || ch === '[') {
      depth += 1
      started = true
    } else if (ch === '}' || ch === ']') {
      depth -= 1
      if (started && depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

function parseValidJson(text: string): { text: string; canonical: string } | null {
  try {
    const parsed = JSON.parse(text)
    return { text, canonical: JSON.stringify(parsed) }
  } catch {
    return null
  }
}

function containsJsonStart(text: string): boolean {
  return text.includes('{') || text.includes('[')
}

export function extractSingleJsonText(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (parseValidJson(trimmed)) return trimmed

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  const fencedJson: Array<{ text: string; canonical: string }> = []
  let outsideFences = ''
  let cursor = 0
  for (const match of trimmed.matchAll(fencePattern)) {
    const index = match.index ?? 0
    outsideFences += trimmed.slice(cursor, index)
    cursor = index + match[0].length
    const inner = match[1].trim()
    const parsed = parseValidJson(inner)
    if (parsed) {
      fencedJson.push(parsed)
    } else if (containsJsonStart(inner)) {
      return null
    }
  }
  outsideFences += trimmed.slice(cursor)
  if (fencedJson.length > 0) {
    const canonical = fencedJson[0].canonical
    if (
      fencedJson.every(item => item.canonical === canonical)
      && !containsJsonStart(outsideFences)
    ) {
      return fencedJson[0].text
    }
    return null
  }

  const start = trimmed.search(/[{[]/)
  if (start < 0) return null
  const slice = trimmed.slice(start)
  const firstEnd = firstTopLevelJsonEnd(slice)
  if (firstEnd <= 0) return null
  const first = slice.slice(0, firstEnd).trim()
  const parsedFirst = parseValidJson(first)
  if (!parsedFirst) return null

  let rest = slice.slice(firstEnd).trim()
  while (rest.startsWith(first)) {
    rest = rest.slice(first.length).trim()
  }
  if (!containsJsonStart(rest)) {
    return first
  }

  return null
}

export function normalizeAcpTurnOutput(raw: string, responseInstructions?: string): string {
  const trimmed = raw.trim()
  if (!trimmed || !responseInstructions || !/\bjson\b/i.test(responseInstructions)) {
    return trimmed
  }
  return extractSingleJsonText(trimmed) ?? trimmed
}

function removePathBestEffort(targetPath: string, recursive = false): void {
  try {
    fs.rmSync(targetPath, {
      force: true,
      ...RM_RETRY_OPTIONS,
      ...(recursive ? { recursive: true } : {}),
    })
  } catch {
    // Best-effort cleanup; daemon teardown removes the isolated tempRoot after stopping processes.
  }
}

/** Delete closed per-turn ACP history artifacts so a warm daemon never bloats disk or SQLite. */
export function purgeClosedSessionArtifacts(isolatedAgyDir: string, sessionId: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    removePathBestEffort(path.join(isolatedAgyDir, 'conversations', `${sessionId}.db${suffix}`))
  }
  removePathBestEffort(path.join(isolatedAgyDir, 'brain', sessionId), true)
  removePathBestEffort(path.join(isolatedAgyDir, 'annotations', `${sessionId}.pbtxt`))
}

function resolveGeminiAcpModelId(
  configuredModel: string | undefined,
  options: EscalationOptions,
  fallbackEffort: string | undefined,
): string {
  const base = (configuredModel || 'gemini-4-hydrogen-low').trim()
  const effort = options.enableThinking === true
    ? 'high'
    : options.enableThinking === false
      ? 'low'
      : (options.reasoningEffort && options.reasoningEffort !== 'none'
          ? options.reasoningEffort
          : fallbackEffort && fallbackEffort !== 'none'
            ? fallbackEffort
            : 'low')

  if (
    base.startsWith('gemini-4-hydrogen') ||
    base.startsWith('gemini-4-carbon') ||
    base.startsWith('gemini-3.8-flash') ||
    base.startsWith('gemini-4-argon')
  ) {
    const stem = base.replace(/-(low|medium|high|xhigh|max)$/, '')
    const supportsXhigh = base.startsWith('gemini-4-hydrogen') || base.startsWith('gemini-4-carbon')
    const normalizedEffort = effort === 'xhigh' && supportsXhigh
      ? 'xhigh'
      : effort === 'medium' || effort === 'high'
        ? effort
        : 'low'
    return `${stem}-${normalizedEffort}`
  }
  return base
}

/**
 * Persistent warm `agy acp` stdio server owned by TerminalRuntime.
 *
 * Construction starts nothing. The first non-diagnostic `gemini` model turn boots
 * one isolated `agy acp` process (using the operator's Google subscription login
 * without user MCP servers or historical SQLite reconciliation) and multiplexes
 * isolated `session/new` -> `session/prompt` -> `session/close` turns over JSON-RPC.
 */
export class GeminiAcpServer {
  private daemon?: ActiveAcpDaemon
  private starting?: Promise<ActiveAcpDaemon>
  private teardowns = new Set<Promise<void>>()

  constructor(private readonly receipts: string) {}

  private isDaemonUsable(daemon: ActiveAcpDaemon | undefined): boolean {
    return Boolean(
      daemon
      && !daemon.closed
      && daemon.child.exitCode === null
      && !daemon.child.killed
      && !daemon.child.stdin.destroyed
      && !daemon.child.stdin.writableEnded
      && daemon.child.stdin.writable,
    )
  }

  private failDaemon(daemon: ActiveAcpDaemon, error: Error): void {
    if (daemon.closed) return
    daemon.closed = true
    if (this.daemon === daemon) this.daemon = undefined
    for (const waiter of daemon.pending.values()) waiter.reject(error)
    daemon.pending.clear()
    daemon.sessionListeners.clear()
    daemon.warmSessions.length = 0
    void this.teardownDaemon(daemon).catch(() => {})
  }

  private writeDaemonStdin(daemon: ActiveAcpDaemon, payload: string): boolean {
    if (!this.isDaemonUsable(daemon)) {
      this.failDaemon(daemon, new Error('Gemini ACP server stdin is closed'))
      return false
    }
    try {
      daemon.child.stdin.write(`${payload}\n`, err => {
        if (err) {
          this.failDaemon(daemon, err instanceof Error ? err : new Error(String(err)))
        }
      })
      return true
    } catch (err) {
      this.failDaemon(daemon, err instanceof Error ? err : new Error(String(err)))
      return false
    }
  }

  private async ensureDaemon(command: string, initialModelId: string): Promise<ActiveAcpDaemon> {
    if (this.daemon && this.isDaemonUsable(this.daemon) && this.daemon.command === command) {
      const existing = this.daemon
      await existing.ready
      if (this.daemon === existing && this.isDaemonUsable(existing) && existing.command === command) {
        return existing
      }
    }
    if (this.starting) return this.starting

    this.starting = (async () => {
      if (this.daemon) await this.teardownDaemon(this.daemon)
      fs.mkdirSync(terminalJobs, { recursive: true, mode: 0o700 })
      const tempRoot = fs.mkdtempSync(path.join(terminalJobs, 'metahuman-gemini-acp-'))
      const isolatedHome = path.join(tempRoot, 'home')
      const isolatedAgyDir = path.join(isolatedHome, '.gemini', 'antigravity-cli')
      const isolatedProjectsDir = path.join(isolatedHome, '.gemini', 'config', 'projects')
      fs.mkdirSync(isolatedAgyDir, { recursive: true, mode: 0o700 })
      fs.mkdirSync(isolatedProjectsDir, { recursive: true, mode: 0o700 })

      const realHome = process.env.HOME || os.homedir()
      const realAgyDir = path.join(realHome, '.gemini', 'antigravity-cli')
      for (const file of ['antigravity-oauth-token', 'installation_id', 'jetski_state.pbtxt']) {
        const src = path.join(realAgyDir, file)
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(isolatedAgyDir, file))
      }
      fs.writeFileSync(
        path.join(isolatedAgyDir, 'settings.json'),
        JSON.stringify({ allowNonWorkspaceAccess: true }),
        { mode: 0o600 },
      )
      fs.writeFileSync(path.join(isolatedProjectsDir, 'default-cli-project.json'), '{}', { mode: 0o600 })

      const child = spawn(
        command,
        ['acp', '--dangerously-skip-permissions', '--include-default-customizations=false'],
        {
          cwd: tempRoot,
          detached: true,
          env: {
            ...process.env,
            HOME: isolatedHome,
            TERM: 'xterm-256color',
            NO_COLOR: '1',
            IS_SANDBOX: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
      } catch (error) {
        removePathBestEffort(tempRoot, true)
        throw error
      }

      const owned = TerminalProcess.record(child.pid!, this.receipts)
      let stderrTail = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + String(chunk)).slice(-4096)
      })

      const daemon: ActiveAcpDaemon = {
        command,
        child,
        owned,
        tempRoot,
        isolatedAgyDir,
        ready: Promise.resolve(),
        closed: false,
        sequence: 0,
        pending: new Map(),
        sessionListeners: new Map(),
        warmSessions: [],
        lastModelId: initialModelId,
      }

      child.stdin.on('error', error => this.failDaemon(daemon, error))
      child.stdin.once('close', () => this.failDaemon(daemon, new Error('Gemini ACP server stdin closed')))
      child.once('error', error => this.failDaemon(daemon, error))
      child.once('close', code => {
        const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
        this.failDaemon(daemon, new Error(`Gemini ACP server exited (code ${code ?? 'null'})${detail}`))
      })

      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      void (async () => {
        try {
          for await (const line of reader) {
            if (!line.trim()) continue
            const msg = JSON.parse(line) as AcpRpcMessage
            if (msg.id !== undefined && !msg.method) {
              const waiter = typeof msg.id === 'number' ? daemon.pending.get(msg.id) : undefined
              if (!waiter) continue
              daemon.pending.delete(msg.id as number)
              if (msg.error) {
                waiter.reject(new Error(`Gemini ACP ${msg.error.code}: ${msg.error.message}`))
              } else {
                waiter.resolve(msg.result)
              }
              continue
            }
            if (msg.method === 'session/update' && msg.params?.sessionId && msg.params?.update) {
              const listener = daemon.sessionListeners.get(String(msg.params.sessionId))
              if (listener) await listener(msg.params.update)
            }
          }
          this.failDaemon(daemon, new Error('Gemini ACP stdout closed unexpectedly'))
        } catch (error) {
          this.failDaemon(daemon, error instanceof Error ? error : new Error(String(error)))
        }
      })()

      daemon.ready = this.rpcWithTimeout(
        daemon,
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
        },
        ACP_INITIALIZE_TIMEOUT_MS,
        `Gemini ACP initialize timed out after ${ACP_INITIALIZE_TIMEOUT_MS}ms`,
      ).then(() => {})

      try {
        await daemon.ready
      } catch (error) {
        await this.teardownDaemon(daemon)
        throw error
      }
      if (!this.isDaemonUsable(daemon)) {
        await this.teardownDaemon(daemon)
        throw new Error('Gemini ACP server closed during initialization')
      }

      this.daemon = daemon
      this.replenishWarmSessions(daemon, initialModelId)
      return daemon
    })().finally(() => {
      this.starting = undefined
    })

    return this.starting
  }

  private async createPureSession(
    daemon: ActiveAcpDaemon,
    modelId: string,
    systemPromptAppend?: string,
  ): Promise<{ sessionId: string; modelId: string }> {
    const created = await this.rpc<{ sessionId: string }>(daemon, 'session/new', {
      cwd: daemon.tempRoot,
      mcpServers: [],
      _meta: {
        antigravity: {
          disableBuiltInTools: true,
          ...(systemPromptAppend ? { systemPrompt: { append: systemPromptAppend } } : {}),
        },
      },
    })
    if (!created.sessionId) {
      throw new Error('Gemini ACP did not return a sessionId')
    }
    try {
      await this.rpc(daemon, 'session/set_model', {
        sessionId: created.sessionId,
        modelId,
      })
    } catch (error) {
      if (!daemon.closed) {
        await this.rpc(daemon, 'session/close', { sessionId: created.sessionId }).catch(() => {})
      }
      throw error
    }
    if (daemon.closed) {
      throw new Error('Gemini ACP server is closed')
    }
    return { sessionId: created.sessionId, modelId }
  }

  private replenishWarmSessions(daemon: ActiveAcpDaemon, modelId = daemon.lastModelId): void {
    if (daemon.closed) return
    daemon.lastModelId = modelId
    while (daemon.warmSessions.length < WARM_SESSION_POOL_SIZE) {
      const entry: WarmAcpSession = {
        modelId,
        promise: this.createPureSession(daemon, modelId),
      }
      entry.promise.catch(() => {
        const idx = daemon.warmSessions.indexOf(entry)
        if (idx !== -1) daemon.warmSessions.splice(idx, 1)
      })
      daemon.warmSessions.push(entry)
    }
  }

  private async claimPureSession(daemon: ActiveAcpDaemon, modelId: string): Promise<string> {
    daemon.lastModelId = modelId
    let idx = daemon.warmSessions.findIndex(entry => entry.modelId === modelId)
    if (idx === -1 && daemon.warmSessions.length > 0) idx = 0

    if (idx !== -1) {
      const [entry] = daemon.warmSessions.splice(idx, 1)
      try {
        const warm = await entry.promise
        if (warm.modelId !== modelId) {
          await this.rpc(daemon, 'session/set_model', { sessionId: warm.sessionId, modelId })
        }
        return warm.sessionId
      } catch (error) {
        if (daemon.closed) throw error
      }
    }

    const fresh = await this.createPureSession(daemon, modelId)
    return fresh.sessionId
  }

  private rpc<T = Record<string, any>>(
    daemon: ActiveAcpDaemon,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isDaemonUsable(daemon)) {
      if (!daemon.closed) {
        this.failDaemon(daemon, new Error('Gemini ACP server stdin is closed'))
      }
      return Promise.reject(new Error('Gemini ACP server is closed'))
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++daemon.sequence
      daemon.pending.set(id, { resolve, reject })
      this.writeDaemonStdin(daemon, JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private rpcWithTimeout<T = Record<string, any>>(
    daemon: ActiveAcpDaemon,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (!this.isDaemonUsable(daemon)) {
      if (!daemon.closed) {
        this.failDaemon(daemon, new Error('Gemini ACP server stdin is closed'))
      }
      return Promise.reject(new Error('Gemini ACP server is closed'))
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++daemon.sequence
      const timer = setTimeout(() => {
        if (daemon.pending.delete(id)) {
          reject(new Error(timeoutMessage))
        }
      }, timeoutMs)
      daemon.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.writeDaemonStdin(daemon, JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private notify(daemon: ActiveAcpDaemon, method: string, params: Record<string, unknown>): void {
    if (!this.isDaemonUsable(daemon)) {
      if (!daemon.closed) {
        this.failDaemon(daemon, new Error('Gemini ACP server stdin is closed'))
      }
      return
    }
    this.writeDaemonStdin(daemon, JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  private async teardownDaemon(daemon: ActiveAcpDaemon): Promise<void> {
    daemon.closed = true
    if (this.daemon === daemon) this.daemon = undefined
    const closedError = new Error('Gemini ACP server is closed')
    for (const waiter of daemon.pending.values()) waiter.reject(closedError)
    daemon.pending.clear()
    daemon.sessionListeners.clear()
    if (!daemon.teardown) {
      const warmPromises = daemon.warmSessions.splice(0).map(entry => entry.promise)
      const task = (async () => {
        await Promise.allSettled(warmPromises)
        await daemon.owned.stop()
        removePathBestEffort(daemon.tempRoot, true)
      })()
      daemon.teardown = task
      this.teardowns.add(task)
      void task.finally(() => {
        this.teardowns.delete(task)
      })
    }
    await daemon.teardown
  }

  async stop(): Promise<void> {
    if (this.starting) {
      await Promise.allSettled([this.starting])
    }
    if (this.daemon) {
      await this.teardownDaemon(this.daemon)
    }
    if (this.teardowns.size > 0) {
      await Promise.allSettled([...this.teardowns])
    }
  }

  private resolveTargetConfig(options: EscalationOptions = {}): { command: string; modelId: string } {
    const config = loadToolExecutorConfig(options.username)
    const backend = config.backends.gemini as CLIBackendConfig
    if (!backend?.enabled) {
      throw new Error(`${providerLabel('gemini')} is disabled in tool-executor configuration`)
    }
    const command = backend.command || 'agy'
    const bigBrother = options.username
      ? loadFreshOperatorConfig(options.username).bigBrotherMode
      : undefined
    const configuredModel = options.model || (bigBrother?.provider === 'gemini' ? bigBrother.model : undefined)
    const fallbackEffort = bigBrother?.provider === 'gemini' ? bigBrother.reasoningEffort : backend.reasoningEffort
    const modelId = resolveGeminiAcpModelId(configuredModel, options, fallbackEffort)
    return { command, modelId }
  }

  async warmup(options: EscalationOptions = {}): Promise<{ modelId: string }> {
    options.signal?.throwIfAborted()
    const { command, modelId } = this.resolveTargetConfig(options)
    const daemon = await this.ensureDaemon(command, modelId)
    options.signal?.throwIfAborted()
    daemon.lastModelId = modelId
    for (const entry of daemon.warmSessions) {
      if (entry.modelId !== modelId) {
        entry.modelId = modelId
        entry.promise = entry.promise.then(async warm => {
          if (warm.modelId !== modelId && !daemon.closed) {
            await this.rpc(daemon, 'session/set_model', { sessionId: warm.sessionId, modelId })
          }
          return { sessionId: warm.sessionId, modelId }
        })
        entry.promise.catch(() => {
          const idx = daemon.warmSessions.indexOf(entry)
          if (idx !== -1) daemon.warmSessions.splice(idx, 1)
        })
      }
    }
    this.replenishWarmSessions(daemon, modelId)
    await Promise.all(daemon.warmSessions.map(entry => entry.promise))
    return { modelId }
  }

  async executeTurn(
    options: EscalationOptions,
    signal: AbortSignal,
    display: (data: string) => Promise<void>,
    observe: (event: ParsedBigBrotherEvent) => void,
  ): Promise<BigBrotherSessionResult> {
    const started = Date.now()
    const request = options.modelRequest
    if (!request) throw new Error('Gemini ACP requires modelRequest messages')

    const { command, modelId } = this.resolveTargetConfig(options)

    signal.throwIfAborted()
    await display(terminalHeading(`MetaHuman Big Brother — ${providerLabel('gemini')} (ACP warm)`))
    const daemon = await this.ensureDaemon(command, modelId)
    signal.throwIfAborted()

    const history = [...request.messages]
    const systemBlocks: string[] = []
    while (history[0]?.role === 'system' && messageParts(history[0]).every(p => p.type === 'text')) {
      const text = messageParts(history.shift()!).map(p => (p.type === 'text' ? p.text : '')).join('\n').trim()
      if (text) systemBlocks.push(text)
    }
    if (request.responseInstructions) systemBlocks.push(request.responseInstructions)

    const isPureSession = !options.toolAccess && !options.workingDirectory
    const usePureWarmSession = isPureSession && systemBlocks.length === 0
    let turnDir: string | undefined
    if (!isPureSession && !options.workingDirectory) {
      fs.mkdirSync(terminalJobs, { recursive: true, mode: 0o700 })
      turnDir = fs.mkdtempSync(path.join(terminalJobs, 'metahuman-gemini-turn-'))
    }

    const promptBlocks: Array<Record<string, unknown>> = []
    let imageCount = 0
    const singleUserTurn = history.length === 1 && history[0]?.role === 'user'

    for (const message of history) {
      const rolePrefix = singleUserTurn
        ? ''
        : `[${message.role === 'system' ? 'System' : message.role === 'assistant' ? 'Assistant' : 'User'}]: `
      let prefixApplied = false
      for (const part of messageParts(message)) {
        if (part.type === 'text') {
          const text = prefixApplied ? part.text : `${rolePrefix}${part.text}`
          prefixApplied = true
          if (text) promptBlocks.push({ type: 'text', text })
        } else if (part.type === 'image_url') {
          imageCount += 1
          if (imageCount > DEFAULT_PROVIDER_IMAGE_POLICY.maxImages) {
            if (turnDir) removePathBestEffort(turnDir, true)
            throw new Error(`Gemini ACP accepts at most ${DEFAULT_PROVIDER_IMAGE_POLICY.maxImages} images per request`)
          }
          const parsed = parseProviderImageDataUrl(part.image_url.url, DEFAULT_PROVIDER_IMAGE_POLICY)
          if (!prefixApplied && rolePrefix) {
            promptBlocks.push({ type: 'text', text: rolePrefix.trim() })
            prefixApplied = true
          }
          promptBlocks.push({
            type: 'image',
            mimeType: parsed.mimeType,
            data: parsed.base64,
          })
        }
      }
    }
    if (promptBlocks.length === 0) {
      promptBlocks.push({ type: 'text', text: '' })
    }

    let sessionId: string | undefined
    let finalText = ''
    let timeoutHandle: NodeJS.Timeout | undefined
    const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 0
    let timedOut = false
    let turnCompleted = false
    let abortReject: (() => void) | undefined

    const abortTurn = () => {
      if (sessionId) {
        this.notify(daemon, 'session/cancel', { sessionId })
      }
      abortReject?.()
    }
    signal.addEventListener('abort', abortTurn, { once: true })

    try {
      const abortPromise = new Promise<never>((_, reject) => {
        const rejectAborted = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error('Big Brother cancelled'))
        if (signal.aborted) {
          rejectAborted()
          return
        }
        abortReject = rejectAborted
      })
      abortPromise.catch(() => {})

      if (usePureWarmSession) {
        const claimPromise = this.claimPureSession(daemon, modelId)
        claimPromise.catch(() => {})
        sessionId = await Promise.race([claimPromise, abortPromise])
      } else if (isPureSession) {
        const createPromise = this.createPureSession(daemon, modelId, systemBlocks.join('\n\n'))
        createPromise.catch(() => {})
        const created = await Promise.race([createPromise, abortPromise])
        sessionId = created.sessionId
      } else {
        const createPromise = this.rpc<{ sessionId: string }>(daemon, 'session/new', {
          cwd: options.workingDirectory || turnDir!,
          mcpServers: [],
          ...(systemBlocks.length > 0
            ? { _meta: { antigravity: { systemPrompt: { append: systemBlocks.join('\n\n') } } } }
            : {}),
        })
        createPromise.catch(() => {})
        const created = await Promise.race([createPromise, abortPromise])
        sessionId = created.sessionId
        if (!sessionId) throw new Error('Gemini ACP did not return a sessionId')
      }

      const initEvent: ParsedBigBrotherEvent = {
        threadId: sessionId,
        displayLines: [`[Gemini ACP] Session ${sessionId} (${modelId})`],
        reasoningSteps: [],
      }
      await display(formatProviderDisplay(providerLabel('gemini'), initEvent.displayLines))
      observe(initEvent)

      daemon.sessionListeners.set(sessionId, async update => {
        const kind = update.sessionUpdate
        if (kind === 'user_message_chunk' && finalText.length > 0) {
          // An internal ACP stream retry replays the prompt before re-streaming the assistant reply.
          finalText = ''
          return
        }
        if (kind === 'agent_message_chunk' && typeof update.content?.text === 'string' && update.content.text) {
          const delta = String(update.content.text)
          finalText += delta
          if (finalText.length > MAX_RESULT) {
            throw new Error('Big Brother response exceeds 4 MiB')
          }
          const ev: ParsedBigBrotherEvent = { displayLines: [delta], reasoningSteps: [] }
          await display(formatProviderDisplay(providerLabel('gemini'), ev.displayLines))
          observe(ev)
        } else if (kind === 'agent_thought_chunk' && typeof update.content?.text === 'string' && update.content.text) {
          const thought = String(update.content.text)
          const ev: ParsedBigBrotherEvent = {
            displayLines: [thought],
            reasoningSteps: [{ type: 'thought', content: thought, timestamp: new Date().toISOString() }],
          }
          await display(formatProviderDisplay(providerLabel('gemini'), ev.displayLines))
          observe(ev)
        } else if (kind === 'tool_call' && typeof update.title === 'string') {
          const ev: ParsedBigBrotherEvent = {
            displayLines: [`[Tool] ${update.title}`],
            reasoningSteps: [{
              type: 'tool_use',
              toolName: String(update.toolCallId || update.title),
              content: String(update.title),
              timestamp: new Date().toISOString(),
            }],
          }
          await display(formatProviderDisplay(providerLabel('gemini'), ev.displayLines))
          observe(ev)
        }
      })

      if (!isPureSession) {
        await this.rpc(daemon, 'session/set_model', { sessionId, modelId })
        if (options.toolAccess === 'read-only') {
          await this.rpc(daemon, 'session/set_mode', { sessionId, modeId: 'plan' })
        }
      }

      if (signal.aborted) abortTurn()
      signal.throwIfAborted()

      const promptPromise = this.rpc<{ stopReason?: string }>(daemon, 'session/prompt', {
        sessionId,
        prompt: promptBlocks,
      })
      promptPromise.catch(() => {})
      if (usePureWarmSession) {
        this.replenishWarmSessions(daemon, modelId)
      }

      const timeoutPromise = timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true
              abortTurn()
              reject(new Error(`Timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          })
        : undefined

      await Promise.race([
        promptPromise,
        abortPromise,
        ...(timeoutPromise ? [timeoutPromise] : []),
      ])
      turnCompleted = true

      const trimmed = normalizeAcpTurnOutput(finalText, request.responseInstructions)
      if (!trimmed) {
        return {
          success: false,
          output: '',
          error: 'Gemini ACP completed without a final message',
          executionTime: Date.now() - started,
          metadata: { threadId: sessionId, model: modelId },
        }
      }

      return {
        success: true,
        output: trimmed,
        executionTime: Date.now() - started,
        metadata: { threadId: sessionId, model: modelId },
      }
    } catch (error) {
      const message = timedOut
        ? `Timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
      return {
        success: false,
        output: finalText.trim(),
        error: message,
        executionTime: Date.now() - started,
        metadata: { ...(sessionId ? { threadId: sessionId } : {}), model: modelId },
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', abortTurn)
      if (sessionId) {
        daemon.sessionListeners.delete(sessionId)
        if (!daemon.closed) {
          let closedCleanly = false
          try {
            await this.rpcWithTimeout(
              daemon,
              'session/close',
              { sessionId },
              ACP_SESSION_CLOSE_TIMEOUT_MS,
              `Gemini ACP session/close timed out after ${ACP_SESSION_CLOSE_TIMEOUT_MS}ms`,
            )
            closedCleanly = true
          } catch {
            closedCleanly = false
          }
          if (!closedCleanly) {
            await this.teardownDaemon(daemon)
          } else {
            purgeClosedSessionArtifacts(daemon.isolatedAgyDir, sessionId)
            if (usePureWarmSession && !daemon.closed) {
              this.replenishWarmSessions(daemon, modelId)
            }
          }
        }
      } else if (!turnCompleted && !daemon.closed) {
        await this.teardownDaemon(daemon)
      }
      if (turnDir) removePathBestEffort(turnDir, true)
    }
  }
}
