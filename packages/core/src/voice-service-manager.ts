import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { systemPaths } from './path-builder.js'

export type VoiceServiceId = 'kokoro' | 'whisper'

export interface VoiceServiceStatus {
  id: VoiceServiceId
  installed: boolean
  running: boolean
  healthy: boolean
  readiness: 'stopped' | 'loading' | 'ready' | 'error'
  target?: 'local' | 'remote'
  remoteUrl?: string
  pid?: number
  url: string
  health?: Record<string, unknown>
  error?: string
}

export interface VoiceServiceConfig {
  enabled: boolean
  startOnSystemBoot: boolean
  port: number
  device: 'cpu' | 'cuda' | 'auto'
  target?: 'local' | 'remote'
  remoteUrl?: string
  model?: string
  computeType?: 'int8' | 'float16' | 'float32'
  langCode?: string
}

export interface VoiceServiceDeviceUpdate {
  changed: boolean
  restarted: boolean
  config: VoiceServiceConfig
  status: VoiceServiceStatus
}

interface VoiceServiceSpec {
  cwd: string
  command: string
  args: string[]
  pidFile: string
  logFile: string
  requiredFiles: string[]
  config: VoiceServiceConfig
}

interface HealthResult {
  responding: boolean
  healthy: boolean
  health?: Record<string, unknown>
}

const CONFIG_FILE = 'voice-servers.json'
const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250

const serviceMutationTails: Record<VoiceServiceId, Promise<void>> = {
  kokoro: Promise.resolve(),
  whisper: Promise.resolve(),
}

const DEFAULTS: Record<VoiceServiceId, VoiceServiceConfig> = {
  kokoro: {
    enabled: true,
    startOnSystemBoot: true,
    port: 9882,
    device: 'cpu',
    langCode: 'a',
  },
  whisper: {
    enabled: true,
    startOnSystemBoot: true,
    port: 9883,
    device: 'cpu',
    model: 'base.en',
    computeType: 'int8',
  },
}

function readServiceEntry(id: VoiceServiceId): Record<string, unknown> {
  try {
    const configPath = path.join(systemPaths.etc, CONFIG_FILE)
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>
    }
    return parsed.servers?.[id] ?? {}
  } catch {
    return {}
  }
}

function environmentDeviceSetting(id: VoiceServiceId): { variable: string; value: string } | undefined {
  const variable = `MH_${id.toUpperCase()}_DEVICE`
  const value = process.env[variable]
  return value === undefined ? undefined : { variable, value }
}

export function isVoiceServiceDeviceEnvironmentControlled(id: VoiceServiceId): boolean {
  return environmentDeviceSetting(id) !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function withVoiceServiceDevice(
  document: unknown,
  id: VoiceServiceId,
  device: 'cpu' | 'cuda' | 'auto',
): Record<string, unknown> {
  if (id === 'whisper' && device === 'auto') throw new Error('Whisper does not support automatic device selection')
  if (!isRecord(document) || !isRecord(document.servers)) {
    throw new Error(`etc/${CONFIG_FILE} must contain a servers object`)
  }

  const entry = document.servers[id]
  if (!isRecord(entry)) {
    throw new Error(`etc/${CONFIG_FILE} must contain a ${id} server entry`)
  }

  return {
    ...document,
    servers: {
      ...document.servers,
      [id]: {
        ...entry,
        device,
      },
    },
  }
}

export function withVoiceServiceTarget(
  document: unknown,
  id: VoiceServiceId,
  target: 'local' | 'remote',
  remoteUrl?: string,
): Record<string, unknown> {
  if (target !== 'local' && target !== 'remote') {
    throw new Error('Voice service target must be local or remote')
  }
  if (!isRecord(document) || !isRecord(document.servers)) {
    throw new Error(`etc/${CONFIG_FILE} must contain a servers object`)
  }

  const entry = document.servers[id]
  if (!isRecord(entry)) {
    throw new Error(`etc/${CONFIG_FILE} must contain a ${id} server entry`)
  }

  const nextEntry: Record<string, unknown> = {
    ...entry,
    target,
  }
  if (remoteUrl !== undefined) {
    const trimmed = remoteUrl.trim().replace(/\/$/, '')
    if (trimmed) {
      nextEntry.remoteUrl = trimmed
    } else {
      delete nextEntry.remoteUrl
    }
  }

  return {
    ...document,
    servers: {
      ...document.servers,
      [id]: nextEntry,
    },
  }
}

function writeVoiceServerConfig(document: Record<string, unknown>): void {
  const configPath = path.join(systemPaths.etc, CONFIG_FILE)
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    fs.renameSync(tempPath, configPath)
  } finally {
    fs.rmSync(tempPath, { force: true })
  }
}

function readVoiceServerConfigForUpdate(): Record<string, unknown> {
  const configPath = path.join(systemPaths.etc, CONFIG_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot update etc/${CONFIG_FILE}: ${(error as Error).message}`)
  }
  if (!isRecord(parsed)) throw new Error(`etc/${CONFIG_FILE} must contain a JSON object`)
  return parsed
}

async function withServiceMutation<T>(id: VoiceServiceId, task: () => Promise<T>): Promise<T> {
  const previous = serviceMutationTails[id]
  let release!: () => void
  serviceMutationTails[id] = new Promise<void>(resolve => {
    release = resolve
  })

  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

function positivePort(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false
    }
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH' || code === 'ENOENT') return false
    throw error
  }
}

export function normalizeVoiceServiceConfig(
  id: VoiceServiceId,
  entry: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): VoiceServiceConfig {
  const defaults = DEFAULTS[id]
  const envPrefix = `MH_${id.toUpperCase()}`
  const requestedDevice = environment[`${envPrefix}_DEVICE`] ?? entry.device
  const device = requestedDevice === 'cuda' ? 'cuda' : id === 'kokoro' && requestedDevice === 'auto' ? 'auto' : 'cpu'
  const port = positivePort(environment[`${envPrefix}_PORT`] ?? entry.port, defaults.port)
  const requestedTarget = environment[`${envPrefix}_TARGET`] ?? entry.target
  const target: 'local' | 'remote' | undefined =
    requestedTarget === 'remote' ? 'remote' : requestedTarget === 'local' ? 'local' : undefined
  const requestedRemoteUrl = environment[`${envPrefix}_REMOTE_URL`] ?? entry.remoteUrl
  const remoteUrl = typeof requestedRemoteUrl === 'string' && requestedRemoteUrl.trim()
    ? requestedRemoteUrl.trim().replace(/\/$/, '')
    : undefined
  const shared: Pick<VoiceServiceConfig, 'enabled' | 'startOnSystemBoot' | 'port' | 'device' | 'target' | 'remoteUrl'> = {
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : defaults.enabled,
    startOnSystemBoot: typeof entry.startOnSystemBoot === 'boolean'
      ? entry.startOnSystemBoot
      : defaults.startOnSystemBoot,
    port,
    device,
    ...(target ? { target } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
  }

  if (id === 'whisper') {
    const requestedCompute = environment.MH_WHISPER_COMPUTE_TYPE ?? entry.computeType
    const computeType = requestedCompute === 'float16' || requestedCompute === 'float32'
      ? requestedCompute
      : 'int8'
    return {
      ...shared,
      model: String(environment.MH_WHISPER_MODEL ?? entry.model ?? defaults.model),
      computeType: device === 'cuda' && computeType === 'int8' ? 'float16' : computeType,
    }
  }

  return {
    ...shared,
    langCode: String(environment.MH_KOKORO_LANG ?? entry.langCode ?? defaults.langCode),
  }
}

export function getVoiceServiceConfig(id: VoiceServiceId): VoiceServiceConfig {
  return normalizeVoiceServiceConfig(id, readServiceEntry(id))
}

function resolveDefaultRemoteHost(): string | undefined {
  if (process.env.MH_REMOTE_VOICE_HOST?.trim()) {
    return process.env.MH_REMOTE_VOICE_HOST.trim()
  }
  try {
    const backendPath = path.join(systemPaths.etc, 'llm-backend.json')
    if (fs.existsSync(backendPath)) {
      const parsed = JSON.parse(fs.readFileSync(backendPath, 'utf8')) as {
        remote?: { serverUrl?: string }
      }
      if (parsed.remote?.serverUrl?.trim()) {
        return parsed.remote.serverUrl.trim()
      }
    }
  } catch {}
  return undefined
}

export function resolveRemoteVoiceServiceUrl(
  id: VoiceServiceId,
  config: VoiceServiceConfig = getVoiceServiceConfig(id),
): string {
  if (config.remoteUrl) return config.remoteUrl.replace(/\/$/, '')
  const remoteHost = resolveDefaultRemoteHost()
  if (remoteHost) {
    try {
      const parsed = new URL(remoteHost.includes('://') ? remoteHost : `http://${remoteHost}`)
      return `${parsed.protocol}//${parsed.hostname}:${config.port}`
    } catch {}
  }
  return `http://127.0.0.1:${config.port}`
}

export function getVoiceServiceUrl(id: VoiceServiceId): string {
  const config = getVoiceServiceConfig(id)
  if (config.target === 'remote') {
    return resolveRemoteVoiceServiceUrl(id, config)
  }
  return `http://127.0.0.1:${config.port}`
}

function getVoiceServiceSpec(id: VoiceServiceId): VoiceServiceSpec {
  const config = getVoiceServiceConfig(id)
  const runDir = path.join(systemPaths.logs, 'run')

  if (id === 'whisper') {
    const command = path.join(systemPaths.root, 'venv', 'bin', 'python3')
    const script = path.join(systemPaths.root, 'external', 'whisper', 'whisper_server.py')
    return {
      cwd: systemPaths.root,
      command,
      args: [
        script,
        '--model', config.model!,
        '--device', config.device,
        '--compute-type', config.computeType!,
        '--port', String(config.port),
      ],
      pidFile: path.join(runDir, 'whisper-server.pid'),
      logFile: path.join(runDir, 'whisper-server.log'),
      requiredFiles: [command, script],
      config,
    }
  }

  const cwd = path.join(systemPaths.root, 'external', 'kokoro')
  const command = path.join(cwd, 'venv', 'bin', 'python3')
  const script = path.join(cwd, 'kokoro_server.py')
  return {
    cwd,
    command,
    args: [script, '--port', String(config.port), '--lang', config.langCode!, '--device', config.device],
    pidFile: path.join(runDir, 'kokoro-server.pid'),
    logFile: path.join(runDir, 'kokoro-server.log'),
    requiredFiles: [command, script],
    config,
  }
}

function readManagedPid(pidFile: string): number | undefined {
  let pid: number
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (isProcessRunning(pid)) return pid
  fs.rmSync(pidFile, { force: true })
  return undefined
}

async function readHealth(id: VoiceServiceId): Promise<HealthResult> {
  try {
    const response = await fetch(`${getVoiceServiceUrl(id)}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    let health: Record<string, unknown> | undefined
    try {
      health = await response.json() as Record<string, unknown>
    } catch {}
    const state = String(health?.status ?? '').toLowerCase()
    return {
      responding: true,
      health,
      healthy: response.ok && (
        state === 'ready'
        || state === 'ok'
        || state === 'healthy'
        || (id === 'kokoro' && state === '')
      ),
    }
  } catch {
    return { responding: false, healthy: false }
  }
}

export async function getVoiceServiceStatus(id: VoiceServiceId): Promise<VoiceServiceStatus> {
  const spec = getVoiceServiceSpec(id)
  if (spec.config.target === 'remote') {
    const url = getVoiceServiceUrl(id)
    const { responding, healthy, health } = await readHealth(id)
    const state = String(health?.status ?? '').toLowerCase()
    const readiness = healthy
      ? 'ready'
      : responding && state === 'loading'
        ? 'loading'
        : responding
          ? 'error'
          : 'stopped'
    return {
      id,
      installed: true,
      running: responding,
      healthy,
      readiness,
      target: 'remote',
      ...(spec.config.remoteUrl ? { remoteUrl: spec.config.remoteUrl } : {}),
      url,
      health,
      error: responding ? undefined : `Remote ${id} server at ${url} is unreachable`,
    }
  }

  const installed = spec.requiredFiles.every(file => fs.existsSync(file))
  const pid = readManagedPid(spec.pidFile)
  const { responding, healthy, health } = await readHealth(id)
  const running = Boolean(pid || responding)
  const state = String(health?.status ?? '').toLowerCase()
  const readiness = healthy
    ? 'ready'
    : running && (!responding || state === 'loading')
      ? 'loading'
      : running
        ? 'error'
        : 'stopped'

  return {
    id,
    installed,
    running,
    healthy,
    readiness,
    ...(spec.config.target ? { target: spec.config.target } : {}),
    ...(spec.config.remoteUrl ? { remoteUrl: spec.config.remoteUrl } : {}),
    pid,
    url: getVoiceServiceUrl(id),
    health,
    error: installed ? undefined : `Required ${id} server files are not installed`,
  }
}

export async function ensureVoiceServiceRunning(id: VoiceServiceId): Promise<VoiceServiceStatus> {
  return withServiceMutation(id, () => ensureVoiceServiceRunningUnlocked(id))
}

async function ensureVoiceServiceRunningUnlocked(id: VoiceServiceId): Promise<VoiceServiceStatus> {
  const current = await getVoiceServiceStatus(id)
  if (current.target === 'remote') {
    if (current.healthy) return current
    if (current.running) return waitForVoiceServiceReady(id)
    throw new Error(current.error || `Remote ${id} server at ${current.url} is not reachable`)
  }
  if (current.running) return !current.healthy ? waitForVoiceServiceReady(id) : current

  const spec = getVoiceServiceSpec(id)
  if (!spec.config.enabled) throw new Error(`${id} service is disabled in etc/${CONFIG_FILE}`)
  if (!current.installed) throw new Error(current.error)

  fs.mkdirSync(path.dirname(spec.pidFile), { recursive: true })
  const logFd = fs.openSync(spec.logFile, 'a')
  let child
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd, logFd],
    })
  } finally {
    fs.closeSync(logFd)
  }

  if (!child.pid) throw new Error(`Failed to start ${id} server`)
  fs.writeFileSync(spec.pidFile, `${child.pid}\n`)
  child.unref()

  await new Promise(resolve => setTimeout(resolve, 300))
  const status = await getVoiceServiceStatus(id)
  if (!status.running) {
    fs.rmSync(spec.pidFile, { force: true })
    throw new Error(`${id} server exited during startup; check ${spec.logFile}`)
  }
  return !status.healthy ? waitForVoiceServiceReady(id) : status
}

function signalManagedProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  try { process.kill(pid, signal) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

export async function stopVoiceService(id: VoiceServiceId): Promise<{ success: boolean; message: string }> {
  const spec = getVoiceServiceSpec(id)
  const pid = readManagedPid(spec.pidFile)
  if (!pid) {
    const status = await getVoiceServiceStatus(id)
    if (status.running) {
      return { success: false, message: `${id} is running outside the voice server manager` }
    }
    return { success: true, message: `${id} is not running` }
  }

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!isProcessRunning(pid)) break
    signalManagedProcess(pid, signal)
    const deadline = Date.now() + 5000
    while (isProcessRunning(pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (isProcessRunning(pid)) return { success: false, message: `${id} process ${pid} did not stop` }
  try {
    if (Number(fs.readFileSync(spec.pidFile, 'utf8').trim()) === pid) fs.rmSync(spec.pidFile)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return { success: true, message: `Stopped ${id} server` }
}

async function waitForVoiceServiceReady(id: VoiceServiceId): Promise<VoiceServiceStatus> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let status = await getVoiceServiceStatus(id)
  while (!status.healthy && Date.now() < deadline) {
    if (!status.running || status.readiness === 'error') {
      throw new Error(`${id} server failed while waiting for readiness`)
    }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
    status = await getVoiceServiceStatus(id)
  }
  if (!status.healthy) {
    throw new Error(`${id} server did not become ready within ${READY_TIMEOUT_MS / 1000} seconds`)
  }
  return status
}

export async function updateVoiceServiceDevice(
  id: VoiceServiceId,
  device: 'cpu' | 'cuda' | 'auto',
): Promise<VoiceServiceDeviceUpdate> {
  if (id === 'whisper' && device === 'auto') throw new Error('Whisper does not support automatic device selection')
  return withServiceMutation(id, async () => {
    const override = environmentDeviceSetting(id)
    if (override && override.value !== device) {
      throw new Error(`${id} device is locked to ${override.value} by ${override.variable}`)
    }

    const document = readVoiceServerConfigForUpdate()
    if (!isRecord(document.servers) || !isRecord(document.servers[id])) {
      throw new Error(`etc/${CONFIG_FILE} must contain a ${id} server entry`)
    }

    const currentEntry = document.servers[id]
    const statusBefore = await getVoiceServiceStatus(id)
    const reportedDevice = statusBefore.health?.device
    const runtimeMatches = !statusBefore.running || (device === 'auto'
      ? statusBefore.health?.requested_device === 'auto'
      : reportedDevice === device)
    if (currentEntry.device === device && runtimeMatches) {
      return {
        changed: false,
        restarted: false,
        config: getVoiceServiceConfig(id),
        status: statusBefore,
      }
    }
    if (statusBefore.running && !statusBefore.pid) {
      throw new Error(`${id} is running outside the voice server manager and cannot be safely restarted`)
    }

    const changed = currentEntry.device !== device
    if (changed) writeVoiceServerConfig(withVoiceServiceDevice(document, id, device))

    if (!statusBefore.running) {
      return {
        changed,
        restarted: false,
        config: getVoiceServiceConfig(id),
        status: await getVoiceServiceStatus(id),
      }
    }

    const stopped = await stopVoiceService(id)
    if (!stopped.success) throw new Error(stopped.message)
    await ensureVoiceServiceRunningUnlocked(id)
    const status = await waitForVoiceServiceReady(id)
    return {
      changed,
      restarted: true,
      config: getVoiceServiceConfig(id),
      status,
    }
  })
}

export async function updateVoiceServiceTarget(
  id: VoiceServiceId,
  target: 'local' | 'remote',
  remoteUrl?: string,
): Promise<VoiceServiceDeviceUpdate> {
  if (target !== 'local' && target !== 'remote') {
    throw new Error('Voice service target must be local or remote')
  }
  return withServiceMutation(id, async () => {
    const document = readVoiceServerConfigForUpdate()
    if (!isRecord(document.servers) || !isRecord(document.servers[id])) {
      throw new Error(`etc/${CONFIG_FILE} must contain a ${id} server entry`)
    }

    const currentEntry = document.servers[id]
    const currentTarget = currentEntry.target === 'remote' ? 'remote' : 'local'
    const normalizedRemoteUrl = remoteUrl !== undefined ? remoteUrl.trim().replace(/\/$/, '') : undefined

    if (target === 'remote') {
      const spec = getVoiceServiceSpec(id)
      const pid = readManagedPid(spec.pidFile)
      if (pid) {
        await stopVoiceService(id)
      }
    }

    const updatedDocument = withVoiceServiceTarget(document, id, target, normalizedRemoteUrl)
    const changed = currentTarget !== target
      || (normalizedRemoteUrl !== undefined && (currentEntry.remoteUrl ?? '') !== normalizedRemoteUrl)
    if (changed) {
      writeVoiceServerConfig(updatedDocument)
    }

    return {
      changed,
      restarted: false,
      config: getVoiceServiceConfig(id),
      status: await getVoiceServiceStatus(id),
    }
  })
}
