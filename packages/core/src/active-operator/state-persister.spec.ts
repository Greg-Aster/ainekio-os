import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-semi-config-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => { throw new Error('Configuration tests prohibit network') }
const { ACTIVE_OPERATOR_CONFIG_FILE, loadConfig, saveConfig, updateConfig } = await import('./state-persister.js')
const { handleGetActiveOperatorConfig, handleUpdateActiveOperatorConfig } = await import('../api/handlers/active-operator.js')
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('five-minute default and interval edits persist without changing the selected mode', async () => {
  assert.deepEqual(loadConfig(), { autonomyMode: 'reactive', semiAssessmentMinutes: 5 })
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'semi' }))
  assert.deepEqual(loadConfig(), { autonomyMode: 'semi', semiAssessmentMinutes: 5 })
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'semi', semiInactivityMinutes: 1.5 }))
  assert.deepEqual(loadConfig(), { autonomyMode: 'semi', semiAssessmentMinutes: 1.5 })
  const request = (value: unknown) => ({ user: { isAuthenticated: true, role: 'owner', username: 'fixture' },
    body: { semiAssessmentMinutes: value } }) as any
  const result = await handleUpdateActiveOperatorConfig(request(2.5))
  assert.equal(result.status, 200)
  assert.deepEqual(loadConfig(), { autonomyMode: 'semi', semiAssessmentMinutes: 2.5 })
  assert.equal('semiInactivityMinutes' in JSON.parse(fs.readFileSync(path.join(root, 'etc/active-operator.json'), 'utf8')), false)
  const response = await handleGetActiveOperatorConfig()
  assert.equal((response.data as any).semiAssessmentMinutes, 2.5)
  for (const invalid of [0, -1, NaN, Infinity, '5']) {
    assert.equal((await handleUpdateActiveOperatorConfig(request(invalid))).status, 400)
    assert.equal(loadConfig().semiAssessmentMinutes, 2.5)
  }
  assert.deepEqual(updateConfig({ autonomyMode: 'full' }), { autonomyMode: 'full', semiAssessmentMinutes: 2.5 })
})

test('saveConfig atomically replaces active-operator.json via sibling rename and cleans up failed temp writes', async () => {
  const etcDir = path.dirname(ACTIVE_OPERATOR_CONFIG_FILE)
  fs.mkdirSync(etcDir, { recursive: true })
  saveConfig({ autonomyMode: 'semi', semiAssessmentMinutes: 5 })

  const observedDuringWatch: Array<{ autonomyMode: string; semiAssessmentMinutes: number }> = []
  let watchParseErrors = 0
  const watcher = fs.watch(etcDir, (_event, filename) => {
    if (filename?.toString() !== path.basename(ACTIVE_OPERATOR_CONFIG_FILE)) return
    try {
      observedDuringWatch.push(JSON.parse(fs.readFileSync(ACTIVE_OPERATOR_CONFIG_FILE, 'utf8')))
    } catch {
      watchParseErrors += 1
    }
  })

  try {
    for (let i = 0; i < 25; i += 1) {
      saveConfig({
        autonomyMode: i % 2 === 0 ? 'full' : 'semi',
        semiAssessmentMinutes: 2 + i,
      })
      assert.deepEqual(loadConfig(), {
        autonomyMode: i % 2 === 0 ? 'full' : 'semi',
        semiAssessmentMinutes: 2 + i,
      })
    }
    await new Promise(resolve => setTimeout(resolve, 30))
  } finally {
    watcher.close()
  }

  assert.equal(watchParseErrors, 0, 'fs.watch readers must never observe truncated or invalid JSON mid-write')
  assert.ok(observedDuringWatch.length > 0, 'fs.watch must observe atomic replacements of active-operator.json')
  assert.deepEqual(
    fs.readdirSync(etcDir).filter(entry => entry.endsWith('.tmp')),
    [],
    'No temporary files may remain after atomic saves',
  )

  const originalRenameSync = fs.renameSync
  fs.renameSync = (() => {
    throw new Error('simulated rename failure')
  }) as typeof fs.renameSync
  try {
    assert.throws(
      () => saveConfig({ autonomyMode: 'reactive', semiAssessmentMinutes: 9 }),
      /simulated rename failure/,
    )
  } finally {
    fs.renameSync = originalRenameSync
  }

  assert.deepEqual(
    loadConfig(),
    { autonomyMode: 'full', semiAssessmentMinutes: 26 },
    'Failed rename must leave existing active-operator.json intact',
  )
  assert.deepEqual(
    fs.readdirSync(etcDir).filter(entry => entry.endsWith('.tmp')),
    [],
    'Failed saveConfig must remove its temporary file',
  )
})
