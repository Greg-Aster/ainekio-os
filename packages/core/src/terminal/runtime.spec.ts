import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-terminal-test-'))
process.env.METAHUMAN_ROOT = root
process.env.SHELL = '/bin/bash'
const { setAuditEnabled } = await import('../audit.js')
setAuditEnabled(false)
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { TerminalProcess } = await import('./process.js')
const { TerminalScreen } = await import('./screen.js')
const { TerminalRuntime } = await import('./runtime.js')
const receipts = path.join(root, 'receipts')
await TerminalProcess.recover(receipts)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await check()) return; await delay(25) }
  assert.fail('Timed out waiting for terminal evidence')
}
test('screen snapshots retain alternate screen and bound scrollback', async () => {
  const screen = new TerminalScreen(80, 24)
  const restored = new TerminalScreen(80, 24)
  try {
    await screen.write('base\r\n\x1b[?1049h\x1b[2J\x1b[Hinteractive screen')
    const snapshot = await screen.snapshot()
    await restored.write(snapshot)
    assert.equal(await restored.snapshot(), snapshot)
    assert.match(snapshot, /interactive screen/)
    await screen.write('\x1b[?1049l' + Array.from({ length: 5000 }, (_, i) => `line-${i}\r\n`).join(''))
    const bounded = await screen.snapshot()
    assert.ok(bounded.length < 40000)
    assert.doesNotMatch(bounded, /line-0\r/)
    assert.match(bounded, /line-4999/)
  } finally { screen.dispose(); restored.dispose() }
})

test('failed process termination retains receipts for retry, including job-control children', async () => {
  const childFile = path.join(root, 'background.pid')
  const child = spawn(process.execPath, ['-e', `const fs=require('fs'); const child=require('child_process').spawn('sleep',['120'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid)); setInterval(()=>{},1000)`], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const owner = TerminalProcess.record(child.pid!, receipts)
  await eventually(() => fs.existsSync(childFile))
  const pid = Number(fs.readFileSync(childFile, 'utf8'))
  const kill = process.kill
  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      return kill(pid, signal)
    }) as typeof process.kill
    await assert.rejects(owner.stop(), /permission denied/)
    assert.equal(fs.readdirSync(receipts).length, 1)
  } finally { process.kill = kill; await owner.stop() }
  const live = fs.existsSync(`/proc/${pid}/stat`) && !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
  assert.equal(live, false)
  assert.deepEqual(fs.readdirSync(receipts), [])
})

test('recovery never signals a PID saved by a previous operating-system boot', async () => {
  fs.writeFileSync(path.join(receipts, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, session: process.pid, started: '1', state: 'S', boot: 'previous-boot',
  }))
  const kill = process.kill
  try {
    process.kill = (() => { assert.fail('a receipt from another boot must never signal a process') }) as typeof process.kill
    await TerminalProcess.recover(receipts)
  } finally { process.kill = kill }
  assert.deepEqual(fs.readdirSync(receipts), [])
})

test('a child still in its parent session can be stopped without signaling its sibling or parent', async () => {
  const launch = async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    return { child, owner: TerminalProcess.record(child.pid!, receipts) }
  }
  const first = await launch()
  const sibling = await launch()
  try {
    await first.owner.stop()
    assert.equal(process.kill(sibling.child.pid!, 0), true)
    assert.equal(process.kill(process.pid, 0), true)
  } finally { await first.owner.stop(); await sibling.owner.stop() }
  assert.deepEqual(fs.readdirSync(receipts), [])
})

test('TerminalRuntime.execute reaps failed provider turns without cleanup instead of permanently poisoning later turns, while retaining failed process cleanups', async () => {
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  const agyMock = path.join(root, 'agy-mock.cjs')
  fs.writeFileSync(agyMock, `#!/usr/bin/env node
const readline = require('readline');
let n = 0;
const send = msg => console.log(JSON.stringify(msg));
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-' + (++n) } });
  } else if (msg.method === 'session/set_model' || msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const text = (msg.params.prompt || []).map(p => p.text || '').join(' ');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP ok: ' + text } },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, { mode: 0o700 })

  const claudeMock = path.join(root, 'claude-mock.cjs')
  const spawnBgFlag = path.join(root, 'claude-spawn-bg.flag')
  const bgPidFile = path.join(root, 'claude-bg.pids')
  fs.writeFileSync(claudeMock, `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
if (fs.existsSync(${JSON.stringify(spawnBgFlag)})) {
  const bg = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.appendFileSync(${JSON.stringify(bgPidFile)}, String(bg.pid) + '\\n');
  bg.unref();
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Claude ok' }) + '\\n', () => {
  process.exit(0);
});
`, { mode: 0o700 })

  const toolConfigPath = path.join(root, 'etc', 'tool-executor.json')
  fs.writeFileSync(toolConfigPath, JSON.stringify({
    backends: {
      gemini: { enabled: false, command: agyMock, args: [], dangerouslySkipPermissions: true },
      'claude-code': { enabled: true, command: claudeMock, args: [], dangerouslySkipPermissions: true },
    },
  }))

  const runtime = new TerminalRuntime(receipts)
  try {
    // 1. Rejecting Gemini ACP turn (cleanup === undefined) marks session 'failed'
    await assert.rejects(
      runtime.execute(
        'gemini',
        '',
        {
          model: 'gemini-4-hydrogen-low',
          modelRequest: { messages: [{ role: 'user', content: 'first attempt' }] },
        },
        new AbortController().signal,
        () => {},
      ),
      /disabled in tool-executor configuration/,
    )
    assert.equal(runtime.state().sessions.length, 1)
    assert.equal(runtime.state().sessions[0].phase, 'failed')
    const failedGeminiId = runtime.state().sessions[0].id

    // Enable Gemini ACP and verify next execute() reaps the failed session instead of re-throwing its error
    fs.writeFileSync(toolConfigPath, JSON.stringify({
      backends: {
        gemini: { enabled: true, command: agyMock, args: [], dangerouslySkipPermissions: true },
        'claude-code': { enabled: true, command: claudeMock, args: [], dangerouslySkipPermissions: true },
      },
    }))

    // Also verify pre-aborted Gemini ACP rejection does not poison subsequent turns
    const preAborted = new AbortController()
    preAborted.abort(new Error('Caller aborted before turn'))
    await assert.rejects(
      runtime.execute(
        'gemini',
        '',
        {
          model: 'gemini-4-hydrogen-low',
          modelRequest: { messages: [{ role: 'user', content: 'aborted attempt' }] },
        },
        preAborted.signal,
        () => {},
      ),
      /Caller aborted before turn/,
    )

    const recovered = await runtime.execute(
      'gemini',
      '',
      {
        model: 'gemini-4-hydrogen-low',
        modelRequest: { messages: [{ role: 'user', content: 'healthy turn' }] },
      },
      new AbortController().signal,
      () => {},
    )
    assert.equal(recovered.success, true)
    assert.equal(recovered.output, 'ACP ok: healthy turn')
    assert.equal(runtime.state().sessions.length, 1, 'Prior failed sessions without cleanup must be reaped')
    assert.notEqual(runtime.state().sessions[0].id, failedGeminiId)
    assert.equal(runtime.state().sessions[0].phase, 'completed')

    // 2. Preserve existing contract: when a spawned provider process's cleanup() fails, retain session + receipt for retry
    fs.writeFileSync(spawnBgFlag, '1')

    const realKill = process.kill
    try {
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        }
        return realKill(pid, signal)
      }) as typeof process.kill

      await assert.rejects(
        runtime.execute('claude-code', 'hello', {}, new AbortController().signal, () => {}),
        /permission denied/,
      )
      assert.equal(runtime.state().sessions.length, 1)
      assert.equal(runtime.state().sessions[0].phase, 'failed')

      // Next execute() must still fail while cleanup cannot terminate the live child process
      await assert.rejects(
        runtime.execute('claude-code', 'retry while blocked', {}, new AbortController().signal, () => {}),
        /permission denied/,
      )
      assert.equal(runtime.state().sessions.length, 1, 'Failed cleanup must retain session owner for retry')
    } finally {
      process.kill = realKill
      fs.rmSync(spawnBgFlag, { force: true })
    }

    const afterCleanupRestored = await runtime.execute(
      'claude-code',
      'retry after permission restored',
      {},
      new AbortController().signal,
      () => {},
    )
    assert.equal(afterCleanupRestored.success, true)
    assert.equal(afterCleanupRestored.output, 'Claude ok')
    assert.equal(runtime.state().sessions.length, 1)
    assert.equal(runtime.state().sessions[0].phase, 'completed')
  } finally {
    await runtime.stop().catch(() => {})
    if (fs.existsSync(bgPidFile)) {
      for (const line of fs.readFileSync(bgPidFile, 'utf8').split(/\r?\n/)) {
        const pid = Number(line.trim())
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      }
    }
  }
  assert.deepEqual(fs.readdirSync(receipts), [])
})
