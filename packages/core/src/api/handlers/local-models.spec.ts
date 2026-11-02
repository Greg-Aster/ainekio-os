import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { after, afterEach, test } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-local-model-status-'))
process.env.METAHUMAN_ROOT = root
const { setAuditEnabled } = await import('../../audit.js')
setAuditEnabled(false)
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
const { handleGetLocalModelsStatus, handleGetLocalModelsAvailable, handleStartLocalModels, handleStopLocalModels } = await import('./local-models.js')
const { startLocalModelService, stopLocalModelService } = await import('../../local-model-service-manager.js')
const { embedWithLocalService } = await import('../../providers/local-models.js')
const originalFetch = globalThis.fetch
eventBus.disconnect()
afterEach(() => { globalThis.fetch = originalFetch })
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

test('settings status retains the loadedModels envelope and service-owned inventory metadata', async () => {
  const loadedModels = { embedder: { model: 'synthetic-embedding', loaded: true, dimensions: 8 }, generator: { model: null, loaded: false } }
  const embeddings = [{ id: 'synthetic-embedding', config: { size: '1MB', dimensions: 8 }, downloaded: true }]
  globalThis.fetch = async url => {
    const route = new URL(String(url)).pathname
    if (route === '/health') return Response.json({ status: 'ok' })
    if (route === '/models/loaded') return Response.json(loadedModels)
    if (route === '/models') return Response.json({ embeddings, llm: [] })
    throw new Error(`Unexpected route: ${route}`)
  }
  const status = await handleGetLocalModelsStatus({} as any)
  assert.equal(status.status, 200)
  assert.deepEqual((status.data as any).loadedModels, loadedModels)
  const models = await handleGetLocalModelsAvailable({} as any)
  assert.deepEqual((models.data as any).embeddings, embeddings)
})

test('offline or unreadable inventory is an explicit error, never a fabricated model list', async () => {
  globalThis.fetch = async () => { throw new Error('Offline') }
  assert.equal((await handleGetLocalModelsAvailable({} as any)).status, 503)
  const status = await handleGetLocalModelsStatus({} as any)
  assert.equal((status.data as any).running, false)
  assert.equal((status.data as any).loadedModels, null)
  globalThis.fetch = async url => String(url).endsWith('/health')
    ? Response.json({ status: 'ok' }) : new Response('Unavailable', { status: 500 })
  assert.equal((await handleGetLocalModelsAvailable({} as any)).status, 502)
})

test('API stop terminates the service recorded by a different launcher process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  await once(child, 'spawn')
  const pidFile = path.join(root, 'logs/run/local-models.pid')
  fs.mkdirSync(path.dirname(pidFile), { recursive: true })
  fs.writeFileSync(pidFile, `${child.pid}\n`)
  try {
    const result = await handleStopLocalModels({} as any)
    assert.equal(result.status, 200)
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' },
      'A stopped receipt must mean the externally started service has exited')
    assert.equal(fs.existsSync(pidFile), false)
  } finally {
    child.kill('SIGKILL')
    await exited
  }
})

const repo = new URL('../../../../../', import.meta.url).pathname
const pidFile = path.join(root, 'logs/run/local-models.pid')
const serviceEntry = path.join(root, 'packages/local-model-service/dist/index.js')
const configFile = path.join(root, 'etc/llm-backend.json')
const execute = promisify(execFile)

async function serviceFixture() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as import('node:net').AddressInfo).port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const endpoint = `http://127.0.0.1:${port}`
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.mkdirSync(path.dirname(serviceEntry), { recursive: true })
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  }
  fs.writeFileSync(path.join(root, 'starts'), '')
  fs.writeFileSync(configFile, JSON.stringify({ localModels: { enabled: true, autoStart: true, endpoint } }))
  fs.writeFileSync(serviceEntry, `
const http = require('node:http'), fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(root, 'starts'))}, process.pid + '\\n');
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/embeddings' ? { embeddings: [[0.25, 0.75]] } :
    { status: 'ok', pid: process.pid, modelsDir: process.env.MODELS_DIR, configPath: process.env.CONFIG_PATH }));
}).listen(Number(process.env.PORT), process.env.HOST);
`)
  return endpoint
}

test('shell and API share one process across repeated starts, stops and caller restarts', async () => {
  const endpoint = await serviceFixture()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await execute(path.join(repo, 'bin/start-local-models'), [], { env: { ...process.env, METAHUMAN_ROOT: root } })
      const pid = fs.readFileSync(pidFile, 'utf8')
      assert.equal((await handleStartLocalModels({} as any)).status, 200)
      await execute(path.join(repo, 'bin/start-local-models'), [], { env: { ...process.env, METAHUMAN_ROOT: root } })
      assert.equal(fs.readFileSync(pidFile, 'utf8'), pid, 'Repeated entrypoints reuse the original service')
      const health = await (await fetch(`${endpoint}/health`)).json() as any
      assert.equal(health.pid, Number(pid), 'The recorded PID owns the service, not a package-manager wrapper')
      assert.equal(health.modelsDir, path.join(root, 'models'))
      assert.equal(health.configPath, configFile)
      assert.deepEqual(await embedWithLocalService('fixture', { endpoint }), [0.25, 0.75])
      if (attempt === 0) assert.equal((await handleStopLocalModels({} as any)).status, 200)
      else await execute(path.join(repo, 'bin/stop-local-models'), [], { env: { ...process.env, METAHUMAN_ROOT: root } })
      assert.equal(fs.existsSync(pidFile), false)
      await assert.rejects(fetch(`${endpoint}/health`))
      assert.equal((await handleStopLocalModels({} as any)).status, 200, 'Stop remains idempotent')
    }
    assert.equal(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim().split('\n').length, 2)
  } finally { await stopLocalModelService() }
})

test('boot selection reads the localModels object independently of JSON layout', async () => {
  const endpoint = await serviceFixture()
  try {
    for (const localModels of [
      { enabled: false, autoStart: true, endpoint },
      { enabled: true, autoStart: false, endpoint },
    ]) {
      fs.writeFileSync(configFile, JSON.stringify({ localModels, other: { enabled: true, autoStart: true } }))
      await execute(path.join(repo, 'bin/start-local-models'), [], { env: { ...process.env, METAHUMAN_ROOT: root } })
      assert.equal(fs.existsSync(pidFile), false)
    }
    const unrelated = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, index]))
    fs.writeFileSync(configFile, JSON.stringify({ localModels: { ...unrelated, enabled: true, autoStart: true, endpoint } }, null, 2))
    await execute(path.join(repo, 'bin/start-local-models'), [], { env: { ...process.env, METAHUMAN_ROOT: root } })
    assert.equal((await fetch(`${endpoint}/health`)).ok, true)
  } finally { await stopLocalModelService() }
})

test('failed and cancelled starts release their process without stopping a replacement', async () => {
  await serviceFixture()
  try {
    fs.writeFileSync(serviceEntry, 'process.exit(23)')
    assert.equal(await startLocalModelService(), false)
    assert.equal(fs.existsSync(pidFile), false)
    fs.writeFileSync(serviceEntry, 'setInterval(() => {}, 1000)')
    const starting = startLocalModelService()
    while (!fs.existsSync(pidFile)) await delay(10)
    await stopLocalModelService()
    const endpoint = await serviceFixture()
    const results = await Promise.all([starting, startLocalModelService(), startLocalModelService()])
    assert.deepEqual(results, [false, true, true])
    assert.equal((await fetch(`${endpoint}/health`)).ok, true)
  } finally { await stopLocalModelService() }
})

test('API stop reports missing ownership instead of falsely claiming a responding service stopped', async () => {
  globalThis.fetch = async () => Response.json({ status: 'ok' })
  const result = await handleStopLocalModels({} as any)
  assert.equal(result.status, 500)
  assert.match(result.error!, /no managed PID/)
})

test('stop cancels a start still checking health before process creation', async () => {
  await serviceFixture()
  let finishHealth!: (response: Response) => void
  let first = true
  globalThis.fetch = async () => {
    if (first) {
      first = false
      return new Promise<Response>(resolve => { finishHealth = resolve })
    }
    return new Response('', { status: 503 })
  }
  const starting = startLocalModelService()
  await stopLocalModelService()
  finishHealth(new Response('', { status: 503 }))
  assert.equal(await starting, false)
  assert.equal(fs.existsSync(pidFile), false)
})

test('a service ignoring graceful stop is terminated before the stop receipt', async () => {
  await serviceFixture()
  fs.appendFileSync(serviceEntry, "\nprocess.on('SIGTERM', () => {});\n")
  try {
    assert.equal(await startLocalModelService(), true)
    assert.equal((await handleStopLocalModels({} as any)).status, 200)
    assert.equal(fs.existsSync(pidFile), false)
    const endpoint = await serviceFixture()
    assert.equal(await startLocalModelService(), true)
    assert.equal((await fetch(`${endpoint}/health`)).ok, true)
  } finally { await stopLocalModelService() }
})

test('an unbuilt service uses the installed TypeScript loader and records the actual service process', async () => {
  const endpoint = await serviceFixture()
  const sourceEntry = path.join(root, 'packages/local-model-service/src/index.ts')
  fs.mkdirSync(path.dirname(sourceEntry), { recursive: true })
  fs.writeFileSync(sourceEntry, `${fs.readFileSync(serviceEntry, 'utf8')}\nconst typed: number = 1;\n`)
  fs.unlinkSync(serviceEntry)
  try {
    assert.equal(await startLocalModelService(), true)
    const health = await (await fetch(`${endpoint}/health`)).json() as any
    assert.equal(health.pid, Number(fs.readFileSync(pidFile, 'utf8')))
    assert.equal((await handleStopLocalModels({} as any)).status, 200)
    await assert.rejects(fetch(`${endpoint}/health`))
  } finally { await stopLocalModelService() }
})

test('full shutdown stops local models even without a normal startup launcher', async () => {
  const endpoint = await serviceFixture()
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.symlinkSync(path.join(repo, 'packages/core'), path.join(root, 'packages/core'), 'dir')
  fs.copyFileSync(path.join(repo, 'stop.sh'), path.join(root, 'stop.sh'))
  fs.copyFileSync(path.join(repo, 'bin/stop-local-models'), path.join(root, 'bin/stop-local-models'))
  // Other services are outside this fixture. Exercise the real shell-to-Core
  // handoff without allowing unrelated process lookup or service control.
  for (const command of ['pgrep', 'lsof', 'pm2', 'mh', 'llama-cpp-services', 'stop-event-bus', 'stop-voice-server']) {
    fs.writeFileSync(path.join(root, 'bin', command), `#!/bin/sh\nexit ${['pgrep', 'lsof', 'pm2'].includes(command) ? 1 : 0}\n`, { mode: 0o755 })
  }
  try {
    assert.equal(await startLocalModelService(), true)
    await execute('bash', [path.join(root, 'stop.sh')], {
      env: { ...process.env, METAHUMAN_ROOT: root, PATH: `${root}/bin:${process.env.PATH}` },
    })
    assert.equal(fs.existsSync(pidFile), false)
    await assert.rejects(fetch(`${endpoint}/health`))
  } finally { await stopLocalModelService() }
})
