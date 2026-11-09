import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { DEFAULT_AUTOMATIC_TRAINING_CONFIG } from '../../../../packages/core/src/training-automation.js'
import { parseTrainingDataSettings } from '../../../../packages/core/src/training-schema.js'
import { registerProfileStorageConfigGetter } from '../../../../packages/core/src/path-builder.js'
import { handleGetTrainingData, handleUpdateTrainingData } from '../../../../packages/core/src/api/handlers/training.js'
import type { UnifiedRequest } from '../../../../packages/core/src/api/types.js'

// Use the existing component-suite approach: execute its actual script, with
// HTTP and Svelte's mount boundary supplied by the fixture. Browser checks
// separately exercise compiled bindings and conditional rendering.
const component = fs.readFileSync(new URL('./AutomaticTraining.svelte', import.meta.url), 'utf8')
const source = ts.createSourceFile('AutomaticTraining.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true)
const code = ts.transpileModule(source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isLabeledStatement(node))
  .map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const status = () => ({ config: { ...DEFAULT_AUTOMATIC_TRAINING_CONFIG }, readiness: {}, dataset: {}, integration: { triggerInstalled: true, message: 'Sleep training stage is installed.' } })
const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code })

function screen(fetch: (url: string, options?: RequestInit) => Promise<Response>) {
  let mount!: () => (() => void)
  const context = vm.createContext({ apiFetch: fetch, parseTrainingDataSettings, AbortController,
    DEFAULT_TRAINING_MODEL: 'fixture-lora', DEFAULT_FULL_TRAINING_MODEL: 'fixture-full',
    onMount: (callback: typeof mount) => { mount = callback } })
  vm.runInContext(code, context)
  return { run: (expression: string) => vm.runInContext(expression, context), mount: () => mount() }
}

test('failed reads expose errors without offering fabricated settings for saving', async () => {
  const ui = screen(async () => response({ error: 'Configuration unavailable' }, 500))
  await ui.run('loadStatus()')
  await ui.run('loadTrainingDataConfig()')
  assert.equal(ui.run('config'), null)
  assert.equal(ui.run('dataSettings'), null)
  assert.equal(ui.run('error'), 'Configuration unavailable')
  assert.equal(ui.run('dataError'), 'Configuration unavailable')
})

test('readiness refresh and policy save preserve edits made while requests are pending', async () => {
  let reply!: (response: Response) => void
  const ui = screen(async () => new Promise(resolve => { reply = resolve }))
  const first = ui.run('loadStatus()'); reply(response(status())); await first
  ui.run('config.epochs = 7')
  const refresh = ui.run('loadStatus()'); reply(response(status())); await refresh
  assert.equal(ui.run('config.epochs'), 7)
  const saving = ui.run('saveSettings()')
  ui.run('config.epochs = 8')
  reply(response({ ...status(), config: { ...status().config, epochs: 7 } })); await saving
  assert.equal(ui.run('config.epochs'), 8)
})

test('composition save preserves a newer draft and keeps failed saves visible', async () => {
  let reply!: (response: Response) => void
  const ui = screen(async () => new Promise(resolve => { reply = resolve }))
  const first = ui.run('loadTrainingDataConfig()'); reply(response({ config: parseTrainingDataSettings() })); await first
  const saving = ui.run('saveTrainingDataConfig()')
  ui.run("dataSettings = { ...dataSettings, seed: 'new-draft' }")
  reply(response({ config: parseTrainingDataSettings() })); await saving
  assert.equal(ui.run('dataSettings.seed'), 'new-draft')
  const failed = ui.run('saveTrainingDataConfig()'); reply(response({ error: 'Write failed' }, 500)); await failed
  assert.equal(ui.run('dataSettings.seed'), 'new-draft')
  assert.equal(ui.run('dataError'), 'Write failed')
  assert.equal(ui.run('dataSaving'), false)
})

test('navigation cancels observation and prevents late replies from changing the discarded screen', async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    const requests: { options?: RequestInit; resolve: (value: Response) => void; url: string }[] = []
    const ui = screen((url, options) => new Promise(resolve => requests.push({ url, options, resolve })))
    const unmount = ui.mount()
    assert.equal(requests.length, 3)
    assert.equal(typeof unmount, 'function')
    unmount()
    assert.ok(requests.every(read => read.options?.signal?.aborted))
    for (const read of requests) read.resolve(response(read.url.endsWith('/automatic') ? status() : { config: parseTrainingDataSettings() }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ui.run('config'), null)
    assert.equal(ui.run('dataSettings'), null)
  }
})

test('the composition API persists the controls full payload and retains sibling profile configuration', async t => {
  const username = `automatic-ui-${process.pid}`
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-ui-api-'))
  registerProfileStorageConfigGetter(candidate => candidate === username ? { path: root, type: 'internal' } : undefined)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  const file = path.join(root, 'etc/training.json')
  fs.writeFileSync(file, JSON.stringify({ base_model: 'retained-model', automatic: { enabled: false } }))
  const settings = parseTrainingDataSettings({ objectivesByMode: { dual: 'assistant-continuation', environment: 'human-continuation' } })
  const req = { user: { isAuthenticated: true, role: 'owner', username }, body: settings } as UnifiedRequest
  const saved = await handleUpdateTrainingData(req)
  assert.equal(saved.status, 200, JSON.stringify(saved))
  assert.deepEqual((await handleGetTrainingData(req)).data?.config, settings)
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(persisted.base_model, 'retained-model')
  assert.deepEqual(persisted.automatic, { enabled: false })
  assert.deepEqual(persisted.data, settings)
  for (const body of [{ ...settings, unknownOption: true }, { ...settings, objectivesByMode: { dual: 'invalid' } }]) {
    assert.equal((await handleUpdateTrainingData({ ...req, body })).status, 400)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).data, settings)
  }
})
