import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveModelsDirectory } from '../packages/local-model-service/src/config.js'

test('standalone local models share repository storage from every startup directory', () => {
  const originalCwd = process.cwd()
  const repo = fileURLToPath(new URL('../', import.meta.url))
  try {
    for (const cwd of [repo, path.join(repo, 'apps/site'), path.join(repo, 'packages/local-model-service')]) {
      process.chdir(cwd)
      assert.equal(resolveModelsDirectory({}), path.join(repo, 'models'))
      assert.equal(resolveModelsDirectory({ METAHUMAN_ROOT: '/installation' }), '/installation/models')
      assert.equal(resolveModelsDirectory({ METAHUMAN_ROOT: '/installation', MODELS_DIR: 'shared-models' }), '/installation/shared-models')
      assert.equal(resolveModelsDirectory({ MODELS_DIR: '/custom/models' }), '/custom/models')
    }
  } finally { process.chdir(originalCwd) }
})

test('local model inventory reads the same directory selected for model loading', async () => {
  const { startLocalModelService, stopLocalModelService } = await import('../packages/local-model-service/src/index.js')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-model-inventory-'))
  const modelsDir = path.join(fixture, 'models')
  const configPath = path.join(fixture, 'config.json')
  fs.mkdirSync(modelsDir)
  fs.writeFileSync(configPath, JSON.stringify({ modelsDir: path.join(fixture, 'obsolete-models') }))
  const model = path.join(modelsDir, 'Qwen3-Embedding-0.6B-q4_k_m.gguf')
  fs.writeFileSync(model, 'inventory fixture; never loaded')
  try {
    const server = await startLocalModelService({ port: 0, modelsDir, configPath })
    const inventory = async () => {
      const response = await server.inject({ method: 'GET', url: '/models' })
      assert.equal(response.statusCode, 200)
      return response.json().embeddings.find((entry: { id: string }) => entry.id === 'qwen3-embedding-0.6b')
    }
    assert.equal((await inventory()).downloaded, true)
    fs.unlinkSync(model)
    assert.equal((await inventory()).downloaded, false)
    fs.writeFileSync(model, 'replacement fixture; never loaded')
    assert.equal((await inventory()).downloaded, true)
  } finally {
    await stopLocalModelService()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

const source = fs.readFileSync(new URL('../start.sh', import.meta.url), 'utf8')

function definition(name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `Missing launcher function: ${name}`)
  return match[0]
}

function runShell(names: string[], mocks: string, body: string) {
  return spawnSync('bash', ['--noprofile', '--norc'], {
    input: `set -euo pipefail\nREPO_ROOT=/fixture/metahuman\n${names.map(definition).join('\n')}\n${mocks}\n${body}`,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 5_000,
  })
}

test('launcher verifies the compiled runtime before starting any services', () => {
  assert.ok(source.indexOf('\nverify_site_runtime\n') < source.indexOf('"Starting background services"'))
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-launch-check-'))
  try {
    const entry = path.join(fixture, 'entry.mjs')
    const checker = path.join(fixture, 'check-runtime.mjs')
    fs.writeFileSync(entry, '')
    const mocks = `
SERVER_ENTRY=${JSON.stringify(entry)}
RUNTIME_CHECK=${JSON.stringify(checker)}
print_error() { printf '%s\\n' "$*" >&2; }
`
    const missing = runShell(['verify_site_runtime'], mocks, 'verify_site_runtime\necho services-started')
    assert.equal(missing.status, 1)
    assert.doesNotMatch(missing.stdout, /services-started/)
    for (const status of [1, 0]) {
      fs.writeFileSync(checker, `if (process.argv[2] !== '/fixture/metahuman') process.exit(99); process.exit(${status})`)
      const checked = runShell(['verify_site_runtime'], mocks, 'verify_site_runtime\necho services-started')
      assert.equal(checked.status, status)
      assert.equal(checked.stdout.includes('services-started'), status === 0)
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('web startup stays concurrent while its dispatcher reports branch failures', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-service-dispatch-'))
  try {
    fs.mkdirSync(path.join(fixture, 'bin'))
    fs.copyFileSync(new URL('../bin/start-services', import.meta.url), path.join(fixture, 'bin/start-services'))
    for (const name of ['start-event-bus', 'mh', 'pnpm', 'start-voice-server', 'start-local-models']) {
      fs.writeFileSync(path.join(fixture, 'bin', name), `#!/bin/bash
while [ ! -f "$FIXTURE_ROOT/dispatched" ]; do sleep 0.01; done
exit 23
`, { mode: 0o755 })
    }
    const result = spawnSync('bash', ['-c', `${definition('start_background_services')}\nstart_background_services\ntouch "$FIXTURE_ROOT/dispatched"\nwait "$SERVICES_PID"`], {
      env: { ...process.env, FIXTURE_ROOT: fixture, REPO_ROOT: fixture, PATH: `${fixture}/bin:${process.env.PATH}` },
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /dispatched/)
    for (const name of ['event-bus', 'agents', 'cloudflare', 'voice-server', 'local-models']) {
      assert.match(result.stderr, new RegExp(`${name} startup failed \\(exit 23\\)`))
      assert.match(fs.readFileSync(path.join(fixture, 'logs/run', `${name}.launcher.log`), 'utf8'), /exited with code 23/)
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('the agent startup CLI returns failure when a selected boot service cannot start', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-boot-agent-failure-'))
  fs.mkdirSync(path.join(fixture, 'etc'))
  fs.writeFileSync(path.join(fixture, 'etc/agents.json'), JSON.stringify({ agents: {} }))
  fs.writeFileSync(path.join(fixture, 'etc/services.json'), JSON.stringify({ services: {
    'environment-bridge': { id: 'environment-bridge', enabled: true, type: 'manual', startOnSystemBoot: true, agentPath: 'environment-bridge/index.ts' },
  } }))
  const entry = new URL('../packages/cli/src/main.ts', import.meta.url).href
  const audit = new URL('../packages/core/src/audit.ts', import.meta.url).href
  const bus = new URL('../packages/core/src/infrastructure/event-bus/client.ts', import.meta.url).href
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
const { setAuditEnabled } = await import(${JSON.stringify(audit)});
const { eventBus } = await import(${JSON.stringify(bus)});
setAuditEnabled(false); eventBus.disconnect();
process.argv = [process.execPath, 'mh', 'start', '--no-restart'];
await import(${JSON.stringify(entry)});
`], { cwd: new URL('..', import.meta.url), env: { ...process.env, METAHUMAN_ROOT: fixture }, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /environment-bridge.*(?:not found|no executable|missing)/i)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

// Exercise the actual signal/trap handoff; stop.sh owns all service effects.
for (const [trigger, status, failure] of [
  ['exit 0', 0, false], ['kill -s INT "$$"', 130, false],
  ['kill -s TERM "$$"', 143, false], ['kill -s HUP "$$"', 143, false],
  ['cleanup; cleanup', 0, false], ['exit 23', 23, true],
] as const) {
  test(`launcher delegates shutdown once through ${trigger}`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-shutdown-'))
    try {
      fs.writeFileSync(path.join(fixture, 'stop.sh'), `#!/bin/sh\necho "service-stop $*"\nexit ${failure ? 23 : 0}\n`, { mode: 0o755 })
      const traps = source.split('\n').filter(line => line.startsWith('trap ')).join('\n')
      const result = runShell(['cleanup'], `
STARTED=true
CLEANING_UP=false
REPO_ROOT=${JSON.stringify(fixture)}
RUN_LOG_DIR=${JSON.stringify(fixture)}
print_warning() { printf '%s\\n' "$1"; }
print_status() { printf '%s\\n' "$1"; }
release_start_lock() { :; }
`, `${traps}\n${trigger}`)
      assert.equal(result.error, undefined)
      assert.equal(result.status, status, result.stderr)
      const log = fs.readFileSync(path.join(fixture, 'startup-shutdown.log'), 'utf8')
      assert.equal(log, 'service-stop --services-only\n')
      if (failure) {
        assert.match(result.stdout, /Some MetaHuman services failed to stop/)
        assert.doesNotMatch(result.stdout, /MetaHuman services stopped/)
      } else assert.match(result.stdout, /MetaHuman services stopped/)
    } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
  })
}

test('application restart replaces the web child repeatedly without service lifecycle calls', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-app-restart-'))
  try {
    const entry = path.join(fixture, 'server.cjs')
    const count = path.join(fixture, 'starts')
    fs.writeFileSync(entry, `const fs=require('node:fs'); const file=${JSON.stringify(count)};
const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(n));
if(n<3){process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.kill(process.ppid,'SIGUSR1'),30);setInterval(()=>{},1000)}else process.exit(42);`)
    const result = runShell(['run_web_server', 'request_app_restart'], `
APP_RESTART=false
WEB_PID=''
SERVER_ENTRY=${JSON.stringify(entry)}
SERVER_LOG=${JSON.stringify(path.join(fixture, 'server.log'))}
verify_site_runtime() { printf 'verified\\n'; }
print_status() { printf '%s\\n' "$*"; }
trap request_app_restart USR1
`, 'run_web_server')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 42, result.stderr)
    assert.equal(fs.readFileSync(count, 'utf8'), '3')
    assert.equal(result.stdout.match(/verified/g)?.length, 2)
    assert.equal(result.stdout.match(/Restarting application/g)?.length, 2)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('application-only shutdown does not stop background services', () => {
  const result = runShell(['cleanup'], `
STARTED=true
CLEANING_UP=false
APP_ONLY=true
WEB_PID=''
print_status() { printf '%s\\n' "$*"; }
release_start_lock() { printf 'lock released\\n'; }
`, 'cleanup')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /background services unchanged/)
  assert.match(result.stdout, /lock released/)
})

test('shutdown continues after owner failure and reports incomplete cleanup', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-stop-owners-'))
  try {
    fs.mkdirSync(path.join(fixture, 'bin'))
    fs.copyFileSync(new URL('../stop.sh', import.meta.url), path.join(fixture, 'stop.sh'))
    for (const name of ['mh', 'llama-cpp-services', 'stop-local-models', 'stop-event-bus', 'node']) {
      fs.writeFileSync(path.join(fixture, 'bin', name), `#!/bin/sh
echo '${name}' "$@" >> "$FIXTURE_ROOT/calls"
case "$*" in 'agent stop --all') exit 23;; esac
`, { mode: 0o755 })
    }
    fs.copyFileSync(new URL('../bin/stop-voice-server', import.meta.url), path.join(fixture, 'bin/stop-voice-server'))
    const result = spawnSync('bash', [path.join(fixture, 'stop.sh'), '--services-only'], {
      env: { ...process.env, FIXTURE_ROOT: fixture, PATH: `${fixture}/bin:${process.env.PATH}` }, encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Agents failed to stop/)
    assert.match(result.stderr, /shutdown incomplete/)
    const calls = fs.readFileSync(path.join(fixture, 'calls'), 'utf8')
    assert.doesNotMatch(calls, /vllm|sovits|kitten/i)
    assert.doesNotMatch(result.stdout, /vllm|sovits|kitten/i)
    for (const command of ['terminal stop', 'agent stop --all', 'llama-cpp-services stop', 'stop-local-models', 'voice-server stop --all', 'stop-event-bus']) assert.ok(calls.includes(command), command)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('full shutdown stops the launcher without dispatching service shutdown twice', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-full-stop-'))
  fs.mkdirSync(path.join(fixture, 'bin'))
  fs.mkdirSync(path.join(fixture, 'logs/run'), { recursive: true })
  fs.copyFileSync(new URL('../stop.sh', import.meta.url), path.join(fixture, 'stop.sh'))
  for (const name of ['mh', 'llama-cpp-services', 'stop-local-models', 'stop-voice-server', 'stop-event-bus', 'node']) {
    fs.writeFileSync(path.join(fixture, 'bin', name), `#!/bin/sh\necho '${name}' "$@" >> "$FIXTURE_ROOT/calls"\n`, { mode: 0o755 })
  }
  fs.writeFileSync(path.join(fixture, 'bin/pm2'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const traps = source.split('\n').filter(line => /^trap .* (EXIT|INT|TERM HUP|USR2)$/.test(line)).join('\n')
  fs.writeFileSync(path.join(fixture, 'start.sh'), `#!/bin/bash
set -eu
REPO_ROOT="$FIXTURE_ROOT"
RUN_LOG_DIR="$REPO_ROOT/logs/run"
LAUNCHER_PID_FILE="$RUN_LOG_DIR/web-launcher.pid"
STARTED=true
CLEANING_UP=false
APP_ONLY=false
print_status() { :; }
print_warning() { :; }
release_start_lock() { :; }
${definition('cleanup')}
${traps}
sleep 60 &
WEB_PID=$!
echo $$ > "$LAUNCHER_PID_FILE"
echo ready
wait "$WEB_PID"
`)
  const env = { ...process.env, FIXTURE_ROOT: fixture, PATH: `${fixture}/bin:${process.env.PATH}` }
  const launcher = spawn('bash', [path.join(fixture, 'start.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(launcher, 'exit')
  try {
    await once(launcher.stdout!, 'data')
    const result = spawnSync('bash', [path.join(fixture, 'stop.sh')], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    await exited
    const calls = fs.readFileSync(path.join(fixture, 'calls'), 'utf8')
    assert.equal(calls.match(/^mh terminal stop$/gm)?.length, 1, calls)
    assert.equal(calls.match(/^mh agent stop --all$/gm)?.length, 1, calls)
    assert.equal(calls.match(/^stop-event-bus$/gm)?.length, 1, calls)
    assert.equal(fs.existsSync(path.join(fixture, 'logs/run/web-launcher.pid')), false)
  } finally {
    launcher.kill('SIGKILL')
    await exited
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('cancelling startup terminates its unfinished launch commands before service shutdown', { timeout: 10000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-cancel-start-'))
  fs.mkdirSync(path.join(fixture, 'bin'))
  fs.copyFileSync(new URL('../bin/start-services', import.meta.url), path.join(fixture, 'bin/start-services'))
  for (const name of ['start-event-bus', 'mh', 'pnpm', 'start-voice-server', 'start-local-models']) {
    fs.writeFileSync(path.join(fixture, 'bin', name), `#!/bin/bash
echo $$ > "$FIXTURE_ROOT/${name}.pid"
sleep 60
`, { mode: 0o755 })
  }
  const child = spawn('bash', [path.join(fixture, 'bin/start-services'), '--background'], {
    env: { ...process.env, FIXTURE_ROOT: fixture, PATH: `${fixture}/bin:${process.env.PATH}` }, stdio: 'ignore',
  })
  const exited = once(child, 'exit')
  try {
    const deadline = Date.now() + 5000
    while (fs.readdirSync(fixture).filter(file => file.endsWith('.pid')).length < 5) {
      assert.ok(Date.now() < deadline, 'All independent launcher commands should start')
      await delay(10)
    }
    child.kill('SIGTERM')
    await exited
    for (const file of fs.readdirSync(fixture).filter(file => file.endsWith('.pid'))) {
      const pid = Number(fs.readFileSync(path.join(fixture, file), 'utf8'))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }
  } finally {
    child.kill('SIGTERM')
    await exited
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('a failed runtime verification leaves the existing application running', () => {
  const result = runShell(['request_app_restart'], `
APP_RESTART=false
WEB_PID=41001
verify_site_runtime() { printf 'runtime mismatch\\n' >&2; return 1; }
kill() { echo unexpected-signal; exit 99; }
`, 'request_app_restart\nprintf "%s\\n" "$APP_RESTART"')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'false\n')
  assert.match(result.stderr, /runtime mismatch/)
})


test('llama.cpp startup selects assigned endpoints and models; stop retains installation ownership', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-llama-lifecycle-'))
  const script = new URL('../bin/llama-cpp-services', import.meta.url).pathname
  const root = path.dirname(path.dirname(script))
  const log = path.join(directory, 'calls')
  fs.writeFileSync(path.join(directory, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
if [ "$TEST_ERROR" = "$2" ]; then echo 'systemd failure' >&2; exit 23; fi
case "$2" in
  list-unit-files) printf '%s\\n' 'selected.service static -' 'obsolete.service disabled -' 'unrelated.service enabled -' 'worker@.service static -';;
  show) case "$*" in *worker@.service*) exit 92;; esac
cat <<'UNITS'
Id=selected.service
WorkingDirectory=${root}
ExecStart={ path=${script} ; argv[]=${script} serve /binary/llama-server --model /configured.gguf --alias selected --host 127.0.0.1 --port 8081 ; }

Id=obsolete.service
WorkingDirectory=${root}
ExecStart={ path=${script} ; argv[]=${script} serve /binary/llama-server --model /obsolete.gguf --alias obsolete --host 127.0.0.1 --port 8083 ; }

Id=unrelated.service
WorkingDirectory=/other/application
ExecStart={ path=/binary/llama-server ; argv[]=/binary/llama-server --model /other.gguf ; }
UNITS
;;
esac
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_CALLS: log }
  const selection = JSON.stringify([{ endpoint: 'http://localhost:8081', model: 'selected' }])
  try {
    for (const [args, expected] of [
      [['start', '[]'], undefined],
      [['start', selection], '--user start selected.service'],
      [['start', JSON.stringify([{ endpoint: 'http://127.0.0.1:8081', model: 'other' }])], undefined],
      [['start', JSON.stringify([{ endpoint: 'https://remote.example:8081', model: 'selected' }])], undefined],
      [['stop'], '--user stop selected.service obsolete.service'],
    ] as const) {
      fs.writeFileSync(log, '')
      const result = spawnSync(script, [...args], { encoding: 'utf8', env })
      assert.equal(result.status, 0, result.stderr)
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      assert.deepEqual(calls.filter(call => /^--user (start|stop) /.test(call)), expected ? [expected] : [])
    }
    assert.notEqual(spawnSync(script, ['start'], { encoding: 'utf8', env }).status, 0,
      'Starting every installed model is no longer an implicit operation')
    for (const operation of ['list-unit-files', 'show', 'start', 'stop']) {
      const result = spawnSync(script, operation === 'stop' ? ['stop'] : ['start', selection], {
        encoding: 'utf8', env: { ...env, TEST_ERROR: operation },
      })
      assert.equal(result.status, 23)
      assert.match(result.stderr, /systemd failure/)
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('native router starts without weights and retains GPU, adapter and inference options', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-llama-preset-'))
  const script = new URL('../bin/llama-cpp-services', import.meta.url).pathname
  const binary = path.join(directory, 'llama-server')
  fs.writeFileSync(binary, `#!/usr/bin/env python3
import sys, json
from pathlib import Path
args = sys.argv[1:]
print(json.dumps({'args': args, 'preset': Path(args[args.index('--models-preset')+1]).read_text()}))
`, { mode: 0o755 })
  try {
    const retained = ['--port', '12345', '--gpu-layers', 'all', '--lora-scaled', '/adapter.gguf:0',
      '--ctx-size', '0', '--mmproj-on-demand', '--temp', '0.3']
    const result = spawnSync(script, ['serve', binary, '--model', '/model with spaces.gguf',
      '--alias', 'custom-model', '--mmproj', '/vision.gguf', ...retained], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: directory } })
    assert.equal(result.status, 0, result.stderr)
    const { args, preset } = JSON.parse(result.stdout)
    assert.deepEqual(args.slice(0, retained.length), retained)
    assert.deepEqual(args.slice(retained.length, -2), ['--sleep-idle-seconds', '300'])
    assert.equal(args.includes('--model'), false)
    assert.equal(args.includes('--alias'), false)
    assert.equal(preset, 'version = 1\n\n[custom-model]\nalias = custom-model\nmodel = /model with spaces.gguf\nmmproj = /vision.gguf\nload-on-startup = false\n')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('local model service starts and restarts unloaded despite obsolete preload settings', async t => {
  const { startLocalModelService, stopLocalModelService } = await import('../packages/local-model-service/src/index.js')
  const { ModelManager } = await import('../packages/local-model-service/src/model-manager.js')
  const embeddingLoads = t.mock.method(ModelManager.prototype, 'loadEmbedder')
  const languageLoads = t.mock.method(ModelManager.prototype, 'loadGenerator')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-local-startup-'))
  const configPath = path.join(fixture, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ embeddings: { model: 'unassigned-embedding', preloadAtStartup: true },
    llm: { model: 'unassigned-text', preloadAtStartup: true } }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = await startLocalModelService({ port: 0, modelsDir: fixture, configPath })
      const result = await server.inject({ method: 'GET', url: '/health' })
      assert.deepEqual(result.json(), { status: 'ok', embedder: { loaded: false, model: null }, generator: { loaded: false, model: null } })
      assert.equal(embeddingLoads.mock.callCount(), 0, 'startup must not attempt to load a model')
      assert.equal(languageLoads.mock.callCount(), 0, 'startup must not attempt to load a model')
      await stopLocalModelService()
    }
  } finally {
    await stopLocalModelService()
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
