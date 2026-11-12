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
  ready: Promise<void>
  closed: boolean
  sequence: number
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>
  sessionListeners: Map<string, (update: Record<string, any>) => Promise<void> | void>
  warmSessions: WarmAcpSession[]
  lastModelId: string
}

function messageParts(message: ProviderMessage) {
  return typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content
}

function resolveGeminiAcpModelId(
  configuredModel: string | undefined,
  options: EscalationOptions,
  fallbackEffort: string | undefined,
): string {
  const base = (configuredModel || 'gemini-3.8-flash-low').trim()
  const effort = options.enableThinking === true
    ? 'high'
    : options.enableThinking === false
      ? 'low'
      : (options.reasoningEffort && options.reasoningEffort !== 'none'
          ? options.reasoningEffort
          : fallbackEffort && fallbackEffort !== 'none'
            ? fallbackEffort
            : 'low')

  if (base.startsWith('gemini-3.8-flash') || base.startsWith('gemini-4-argon')) {
    const stem = base.replace(/-(low|medium|high|xhigh|max)$/, '')
    const normalizedEffort = effort === 'medium' || effort === 'high' ? effort : 'low'
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

  constructor(private readonly receipts: string) {}

  private async ensureDaemon(command: string, initialModelId: string): Promise<ActiveAcpDaemon> {
    if (this.daemon && !this.daemon.closed && this.daemon.command === command) {
      await this.daemon.ready
      return this.daemon
    }
    if (this.starting) return this.starting

    this.starting = (async () => {
      if (this.daemon) await this.teardownDaemon(this.daemon)
      fs.mkdirSync(terminalJobs, { recursive: true, mode: 0o700 })
      const tempRoot = fs.mkdtempSync(path.join(terminalJobs, 'metahuman-gemini-acp-'))
      const isolatedHome = path.join(tempRoot, 'home')
      const isolatedAgyDir = path.join(isolatedHome, '.gemini', 'antigravity-cli')
      fs.mkdirSync(isolatedAgyDir, { recursive: true, mode: 0o700 })

      const realHome = process.env.HOME || os.homedir()
      const realAgyDir = path.join(realHome, '.gemini', 'antigravity-cli')
      const hasIsolatedAuth = fs.existsSync(path.join(realAgyDir, 'antigravity-oauth-token'))
      if (hasIsolatedAuth) {
        for (const file of ['antigravity-oauth-token', 'installation_id', 'jetski_state.pbtxt']) {
          const src = path.join(realAgyDir, file)
          if (fs.existsSync(src)) fs.symlinkSync(src, path.join(isolatedAgyDir, file))
        }
        fs.writeFileSync(
          path.join(isolatedAgyDir, 'settings.json'),
          JSON.stringify({ allowNonWorkspaceAccess: true }),
          { mode: 0o600 },
        )
      }

      const child = spawn(
        command,
        ['acp', '--dangerously-skip-permissions', '--include-default-customizations=false'],
        {
          cwd: tempRoot,
          detached: true,
          env: {
            ...process.env,
            ...(hasIsolatedAuth ? { HOME: isolatedHome } : {}),
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
        fs.rmSync(tempRoot, { recursive: true, force: true })
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
        ready: Promise.resolve(),
        closed: false,
        sequence: 0,
        pending: new Map(),
        sessionListeners: new Map(),
        warmSessions: [],
        lastModelId: initialModelId,
      }

      const failDaemon = (error: Error) => {
        if (daemon.closed) return
        daemon.closed = true
        if (this.daemon === daemon) this.daemon = undefined
        for (const waiter of daemon.pending.values()) waiter.reject(error)
        daemon.pending.clear()
        daemon.sessionListeners.clear()
        daemon.warmSessions.length = 0
        void this.teardownDaemon(daemon).catch(() => {})
      }

      child.stdin.on('error', error => failDaemon(error))
      child.once('error', error => failDaemon(error))
      child.once('close', code => {
        const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
        failDaemon(new Error(`Gemini ACP server exited (code ${code ?? 'null'})${detail}`))
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
          failDaemon(new Error('Gemini ACP stdout closed unexpectedly'))
        } catch (error) {
          failDaemon(error instanceof Error ? error : new Error(String(error)))
        }
      })()

      daemon.ready = this.rpc(daemon, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      }).then(() => {})

      try {
        await daemon.ready
      } catch (error) {
        await this.teardownDaemon(daemon)
        throw error
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
  ): Promise<{ sessionId: string; modelId: string }> {
    const created = await this.rpc<{ sessionId: string }>(daemon, 'session/new', {
      cwd: daemon.tempRoot,
      mcpServers: [],
      _meta: { antigravity: { disableBuiltInTools: true } },
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
    if (daemon.closed) {
      return Promise.reject(new Error('Gemini ACP server is closed'))
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++daemon.sequence
      daemon.pending.set(id, { resolve, reject })
      daemon.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(daemon: ActiveAcpDaemon, method: string, params: Record<string, unknown>): void {
    if (daemon.closed) return
    daemon.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private async teardownDaemon(daemon: ActiveAcpDaemon): Promise<void> {
    daemon.closed = true
    if (this.daemon === daemon) this.daemon = undefined
    const closedError = new Error('Gemini ACP server is closed')
    for (const waiter of daemon.pending.values()) waiter.reject(closedError)
    daemon.pending.clear()
    daemon.sessionListeners.clear()
    const warmPromises = daemon.warmSessions.splice(0).map(entry => entry.promise)
    await Promise.allSettled(warmPromises)
    await daemon.owned.stop()
    fs.rmSync(daemon.tempRoot, { recursive: true, force: true })
  }

  async stop(): Promise<void> {
    if (this.starting) {
      await Promise.allSettled([this.starting])
    }
    if (this.daemon) {
      await this.teardownDaemon(this.daemon)
    }
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

    signal.throwIfAborted()
    await display(terminalHeading(`MetaHuman Big Brother — ${providerLabel('gemini')} (ACP warm)`))
    const daemon = await this.ensureDaemon(command, modelId)
    signal.throwIfAborted()

    const usePureWarmSession = !options.toolAccess && !options.workingDirectory
    let turnDir: string | undefined
    if (!usePureWarmSession && !options.workingDirectory) {
      fs.mkdirSync(terminalJobs, { recursive: true, mode: 0o700 })
      turnDir = fs.mkdtempSync(path.join(terminalJobs, 'metahuman-gemini-turn-'))
    }

    const history = [...request.messages]
    const systemBlocks: string[] = []
    if (usePureWarmSession) {
      if (request.responseInstructions) {
        history.push({ role: 'system', content: request.responseInstructions })
      }
    } else {
      while (history[0]?.role === 'system' && messageParts(history[0]).every(p => p.type === 'text')) {
        const text = messageParts(history.shift()!).map(p => (p.type === 'text' ? p.text : '')).join('\n').trim()
        if (text) systemBlocks.push(text)
      }
      if (request.responseInstructions) systemBlocks.push(request.responseInstructions)
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
            if (turnDir) fs.rmSync(turnDir, { recursive: true, force: true })
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
    const timeoutMs = options.timeout || backend.timeout || 120000
    let timedOut = false

    const abortTurn = () => {
      if (sessionId) {
        this.notify(daemon, 'session/cancel', { sessionId })
      }
    }
    signal.addEventListener('abort', abortTurn, { once: true })

    try {
      if (usePureWarmSession) {
        sessionId = await this.claimPureSession(daemon, modelId)
      } else {
        const created = await this.rpc<{ sessionId: string }>(daemon, 'session/new', {
          cwd: options.workingDirectory || turnDir!,
          mcpServers: [],
          ...(systemBlocks.length > 0
            ? { _meta: { antigravity: { systemPrompt: { append: systemBlocks.join('\n\n') } } } }
            : {}),
        })
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

      if (!usePureWarmSession) {
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
      if (usePureWarmSession) {
        this.replenishWarmSessions(daemon, modelId)
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Big Brother cancelled'))
          return
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason instanceof Error ? signal.reason : new Error('Big Brother cancelled')),
          { once: true },
        )
      })

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

      const trimmed = finalText.trim()
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
          await this.rpc(daemon, 'session/close', { sessionId }).catch(() => {})
          if (usePureWarmSession) {
            this.replenishWarmSessions(daemon, modelId)
          }
        }
      }
      if (turnDir) fs.rmSync(turnDir, { recursive: true, force: true })
    }
  }
}
