import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  activateTunnelExposure,
  deactivateTunnelExposure,
} from './cloudflare-exposure.js'

const EXPOSURE_KEYS = [
  'HOST',
  'MH_EXPOSURE_MODE',
  'MH_EXPOSURE_SOURCE',
  'MH_ALLOWED_HOSTS',
  'MH_ALLOWED_ORIGINS',
] as const

const original = Object.fromEntries(EXPOSURE_KEYS.map(key => [key, process.env[key]]))

test('tunnel stop releases its owned process before removing its PID receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-tunnel-stop-'))
  process.env.METAHUMAN_ROOT = root
  const { stopTunnel, autoStartTunnel } = await import('./cloudflare-tunnel.js')
  fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true })
  const script = path.join(root, 'cloudflared')
  fs.writeFileSync(script, "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); console.log('ready'); setInterval(()=>{},1000)")
  const child = spawn(process.execPath, [script, 'tunnel', 'run', 'fixture'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(child, 'exit')
  await once(child.stdout!, 'data')
  const receipt = path.join(root, 'logs/run/cloudflare-tunnel.pid')
  fs.writeFileSync(receipt, `${child.pid}\n`)
  try {
    assert.equal(await stopTunnel(), true)
    fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
    const config = path.join(root, 'etc/cloudflare.json')
    fs.writeFileSync(config, JSON.stringify({ enabled: false, autoStart: true }))
    assert.equal(autoStartTunnel(), true, 'Disabled boot is a successful no-op')
    fs.writeFileSync(config, JSON.stringify({ enabled: true, autoStart: true, hostname: 'fixture.invalid' }))
    const exists = fs.existsSync
    try {
      fs.existsSync = file => String(file).endsWith('/cloudflared') ? false : exists(file)
      assert.equal(autoStartTunnel(), false, 'An unavailable enabled tunnel must report launch failure')
    } finally { fs.existsSync = exists }
    assert.equal(fs.existsSync(receipt), false)
    await exited
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' })
    assert.equal(await stopTunnel(), true)
  } finally { child.kill('SIGKILL'); await exited; fs.rmSync(root, { recursive: true, force: true }) }
})

function resetEnvironment(): void {
  for (const key of EXPOSURE_KEYS) delete process.env[key]
}

try {
  resetEnvironment()
  const activated = activateTunnelExposure('mh.example.com')
  assert.equal(activated.mode, 'shared')
  assert.equal(activated.source, 'cloudflare-tunnel')
  assert.equal(activated.hostname, 'mh.example.com')
  assert.equal(activated.origin, 'https://mh.example.com')
  assert.equal(process.env.HOST, '127.0.0.1')
  assert.equal(process.env.MH_ALLOWED_HOSTS, 'mh.example.com')
  assert.equal(process.env.MH_ALLOWED_ORIGINS, 'https://mh.example.com')

  activateTunnelExposure('https://mh.example.com')
  assert.equal(process.env.MH_ALLOWED_HOSTS, 'mh.example.com')
  assert.equal(process.env.MH_ALLOWED_ORIGINS, 'https://mh.example.com')

  const deactivated = deactivateTunnelExposure()
  assert.equal(deactivated.mode, 'local')
  assert.equal(deactivated.source, null)

  resetEnvironment()
  process.env.MH_EXPOSURE_MODE = 'shared'
  process.env.HOST = '0.0.0.0'
  activateTunnelExposure('mh.example.com')
  deactivateTunnelExposure()
  assert.equal(process.env.MH_EXPOSURE_MODE, 'shared')
  assert.equal(process.env.HOST, '0.0.0.0')

  assert.throws(
    () => activateTunnelExposure('https://mh.example.com/not-allowed'),
    /Invalid Cloudflare tunnel hostname/,
  )

  console.log('cloudflare exposure contract passed')
} finally {
  resetEnvironment()
  for (const key of EXPOSURE_KEYS) {
    const value = original[key]
    if (value !== undefined) process.env[key] = value
  }
}
