import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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
    for (const name of ['start-event-bus', 'mh', 'pnpm', 'start-voice-server']) {
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
    for (const name of ['event-bus', 'agents', 'cloudflare', 'voice-server']) {
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
    for (const name of ['mh', 'llama-cpp-services', 'stop-event-bus', 'node']) {
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
    assert.doesNotMatch(calls, /llama-cpp-services|vllm|sovits|kitten/i)
    assert.doesNotMatch(result.stdout, /vllm|sovits|kitten/i)
    for (const command of ['terminal stop', 'agent stop --all', 'voice-server stop --all', 'stop-event-bus']) assert.ok(calls.includes(command), command)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('full shutdown stops the launcher without dispatching service shutdown twice', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-full-stop-'))
  fs.mkdirSync(path.join(fixture, 'bin'))
  fs.mkdirSync(path.join(fixture, 'logs/run'), { recursive: true })
  fs.copyFileSync(new URL('../stop.sh', import.meta.url), path.join(fixture, 'stop.sh'))
  for (const name of ['mh', 'llama-cpp-services', 'stop-voice-server', 'stop-event-bus', 'node']) {
    fs.writeFileSync(path.join(fixture, 'bin', name), `#!/bin/sh\necho '${name}' "$@" >> "$FIXTURE_ROOT/calls"\n`, { mode: 0o755 })
  }
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
  for (const name of ['start-event-bus', 'mh', 'pnpm', 'start-voice-server']) {
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
    while (fs.readdirSync(fixture).filter(file => file.endsWith('.pid')).length < 4) {
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


test('llama.cpp clients start only the shared host; old per-model serve and stop paths are removed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-llama-lifecycle-'))
  const script = new URL('../bin/llama-cpp-services', import.meta.url).pathname
  const log = path.join(directory, 'calls')
  fs.writeFileSync(path.join(directory, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
if [ "$TEST_ERROR" = "$2" ]; then echo 'systemd failure' >&2; exit 23; fi
case "$2" in
  show) printf '%s\\n' 'ExecStart={ path=/binary/llama-server ; argv[]=/binary/llama-server --models-preset /host/models.ini --host 127.0.0.1 --port 8080 --models-max 0 ; }';;
esac
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_CALLS: log }
  try {
    for (const models of [[], [{ endpoint: 'http://localhost:8080', model: 'brain' }],
      [{ endpoint: 'http://127.0.0.1:8080', model: 'motion' }],
      [{ endpoint: 'http://127.0.0.1:8081', model: 'obsolete' }],
      [{ endpoint: 'http://q6a.example:8080', model: 'motion' }]]) {
      fs.writeFileSync(log, '')
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(script, ['start', JSON.stringify(models)], { encoding: 'utf8', env })
        assert.equal(result.status, 0, result.stderr)
      }
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      const local = models.some(model => /(?:localhost|127.0.0.1):8080/.test(model.endpoint))
      assert.deepEqual(calls.filter(call => /^--user start /.test(call)),
        local ? ['--user start llama-cpp.service', '--user start llama-cpp.service'] : [])
      assert.ok(calls.every(call => /^--user (show llama-cpp.service|start llama-cpp.service)/.test(call)))
      if (models.some(model => model.endpoint.includes('q6a'))) assert.deepEqual(calls, [])
    }
    for (const operation of ['show', 'start']) {
      const result = spawnSync(script, ['start', JSON.stringify([{ endpoint: 'http://localhost:8080', model: 'brain' }])], {
        encoding: 'utf8', env: { ...env, TEST_ERROR: operation },
      })
      assert.equal(result.status, 23)
      assert.match(result.stderr, /systemd failure/)
    }
    for (const args of [['serve', '/binary/llama-server', '--model', '/old.gguf'], ['stop']]) {
      assert.equal(spawnSync(script, args, { encoding: 'utf8', env }).status, 2)
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('host installation runs native router directly and preserves its preset independently of either app', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-llama-install-'))
  const script = new URL('../bin/llama-cpp-services', import.meta.url).pathname
  const preset = path.join(directory, 'models.ini')
  const contents = 'version = 1\n\n[brain]\nmodel = /brain.gguf\nmmproj = /vision.gguf\nlora-scaled = /brain-adapter.gguf:0\nctx-size = 0\nload-on-startup = false\n\n[motion]\nmodel = /motion.gguf\nparallel = 2\nload-on-startup = false\n'
  fs.writeFileSync(preset, contents)
  fs.writeFileSync(path.join(directory, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\n', { mode: 0o755 })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(script, ['install', '/native/llama-server', '--models-preset', preset,
        '--host', '127.0.0.1', '--port', '8080', '--models-max', '0'], {
        encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: directory,
          PATH: `${directory}:${process.env.PATH}`, TEST_CALLS: path.join(directory, 'calls') },
      })
      assert.equal(result.status, 0, result.stderr)
    }
    const unit = fs.readFileSync(path.join(directory, 'systemd/user/llama-cpp.service'), 'utf8')
    assert.match(unit, /ExecStart="\/native\/llama-server" "--models-preset"/)
    assert.doesNotMatch(unit, /WorkingDirectory|metahuman|Ainekio|PartOf|BindsTo|llama-cpp-services/)
    assert.equal(fs.readFileSync(preset, 'utf8'), contents)
    assert.deepEqual(fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n'),
      ['--user daemon-reload', '--user enable llama-cpp.service', '--user daemon-reload', '--user enable llama-cpp.service'])
    assert.deepEqual(fs.readdirSync(path.join(directory, 'systemd/user')), ['llama-cpp.service'])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
