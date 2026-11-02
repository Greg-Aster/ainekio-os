import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import childProcess, { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { once, EventEmitter } from 'node:events'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-agent-stop-'))
process.env.METAHUMAN_ROOT = root
const { agentFailureMessage, collectAgentOutput, startAgentProcess } = await import('./agent-process-runner.js')
const { systemPaths } = await import('./path-builder.js')
const { registerAgent, readRegistry, stopAgent } = await import('./agent-monitor-registry.js')
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

test('agent failure summaries prefer the final explicit terminal failure', () => {
  const verboseOutput = [
    '[GraphExecutor] Node generate FAILED: Error: invalid model output',
    '    at executeNode (/workspace/graph-executor.ts:1:1)',
    '[desire-agent] Failed: Desire candidate sourceId did not identify a supplied input',
  ].join('\n')

  assert.equal(
    agentFailureMessage('desire-agent', 1, verboseOutput),
    'Agent desire-agent exited with code 1: [desire-agent] Failed: Desire candidate sourceId did not identify a supplied input',
  )
})

test('agent failure summaries preserve the full diagnostic when there is no terminal summary', () => {
  const diagnostic = 'Root cause at the beginning.\n' + 'x'.repeat(3_000) + '\nLast diagnostic line.'
  assert.equal(agentFailureMessage('example-agent', 1, diagnostic),
    'Agent example-agent exited with code 1: ' + diagnostic)
})

test('collected agent output retains complete diagnostics across chunks', () => {
  const chunks = ['Root cause first.\n', 'x'.repeat(3_000), '\nLast diagnostic line.']
  assert.equal(collectAgentOutput(chunks), chunks.join(''))
})

test('detached log setup failure closes the file already opened without launching an agent', async () => {
  const agent = 'fixture-fd-cleanup'
  const directory = path.join(systemPaths.brain, 'agents', agent)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'cli.ts'), '// Never executed: log setup fails first.\n')
  const stdoutPath = path.join(systemPaths.logs, 'run', 'agents', `${agent}.log`)
  const stderrPath = path.join(systemPaths.logs, 'run', 'agents', `${agent}.error.log`)
  const open = fs.openSync
  let descriptor: number | undefined
  const mocked = mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (String(file) === stderrPath) throw new Error('Fixture stderr log open failed')
    const fd = open(file, flags, mode)
    if (String(file) === stdoutPath) descriptor = fd
    return fd
  })
  try {
    const result = await startAgentProcess(agent, { source: 'owner-fixture', detached: true, useBootstrap: false })
    assert.equal(result.started, false)
    assert.equal(result.pid, undefined)
    assert.equal(result.error, 'Fixture stderr log open failed')
    assert.equal(typeof descriptor, 'number')
    assert.throws(() => fs.fstatSync(descriptor!), { code: 'EBADF' })
  } finally {
    mocked.mock.restore()
    if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} }
  }
})

test('agent process output preserves UTF8 codepoints split across pipe chunks', async () => {
  const agent = 'fixture-pipe-decoding'
  const directory = path.join(systemPaths.brain, 'agents', agent)
  fs.mkdirSync(directory, { recursive: true })
  const executable = path.join(directory, 'cli.ts')
  fs.writeFileSync(executable, '// Never executed: the process boundary is simulated.\n')
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { pid: 1_073_741_824, stdout, stderr, unref() {} })
  const outputPrefix = 'Complete output prefix. ' + 'x'.repeat(3_000)
  const errorPrefix = 'Original error cause. ' + 'y'.repeat(3_000)
  const character = Buffer.from('🤖')
  const mocked = mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    assert.deepEqual(args[1], [executable])
    queueMicrotask(() => {
      stdout.write(Buffer.from(outputPrefix)); stderr.write(Buffer.from(errorPrefix))
      stdout.write(character.subarray(0, 2)); stderr.write(character.subarray(0, 1))
      stdout.write(character.subarray(2)); stderr.write(character.subarray(1))
      stdout.end(' stdout end.'); stderr.end(' stderr end.')
      child.emit('close', 1)
    })
    return child as unknown as ReturnType<typeof spawn>
  })
  syncBuiltinESMExports()
  try {
    const result = await startAgentProcess(agent, {
      source: 'owner-fixture', detached: false, useBootstrap: false, waitForMs: 1_000,
    })
    assert.equal(result.started, false)
    assert.equal(result.stdout, outputPrefix + '🤖 stdout end.')
    assert.equal(result.stderr, errorPrefix + '🤖 stderr end.')
    assert.equal(result.error, 'Agent ' + agent + ' exited with code 1: ' + result.stderr)
  } finally {
    mocked.mock.restore()
    syncBuiltinESMExports()
    stdout.destroy(); stderr.destroy()
  }
})

test('agent stop waits for process exit and cannot delete a replacement registration', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  const replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  const replacementExited = once(replacement, 'exit')
  await once(child.stdout!, 'data')
  registerAgent('fixture-service', child.pid!)
  try {
    const stopping = stopAgent('fixture-service')
    registerAgent('fixture-service', replacement.pid!)
    const result = await stopping
    assert.equal(result.success, true, result.message)
    // An exited child can remain a zombie until Node delivers its exit event.
    if (child.exitCode === null) assert.match(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'), /\) Z /)
    await exited
    assert.equal(readRegistry()['fixture-service'].pid, replacement.pid)
    const second = await stopAgent('fixture-service')
    assert.equal(second.success, true, second.message)
    assert.equal(readRegistry()['fixture-service'], undefined)
  } finally {
    child.kill('SIGKILL'); replacement.kill('SIGKILL')
    await Promise.all([exited, replacementExited])
  }
})

test('graceful agent stop retains a process that refuses to exit until force is requested', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(child, 'exit')
  try {
    await once(child.stdout!, 'data')
    registerAgent('fixture-service', child.pid!)
    const graceful = await stopAgent('fixture-service')
    assert.equal(graceful.success, false)
    assert.equal(readRegistry()['fixture-service'].pid, child.pid)
    assert.equal(child.signalCode, null)
    const forced = await stopAgent('fixture-service', true)
    assert.equal(forced.success, true, forced.message)
    await exited
    assert.equal(child.signalCode, 'SIGKILL')
    assert.equal(readRegistry()['fixture-service'], undefined)
  } finally { child.kill('SIGKILL'); await exited }
})
