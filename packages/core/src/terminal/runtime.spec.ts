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
const { TerminalProcess } = await import('./process.js')
const { TerminalScreen } = await import('./screen.js')
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
