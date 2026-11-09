import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compile, parse } from 'svelte/compiler'
import { parseTrainingDataSettings } from '../../../../packages/core/src/training-schema.js'
import { DEFAULT_TRAINING_MODEL, DEFAULT_FULL_TRAINING_MODEL } from '../lib/client/model-defaults.js'

const component = readFileSync(new URL('./TrainingWizard.svelte', import.meta.url), 'utf8')
const scriptText = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]
const script = ts.createSourceFile('TrainingWizard.ts', scriptText, ts.ScriptTarget.Latest, true)
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const componentRequire = createRequire(import.meta.url)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const stats = { totalMemories: 10, selection: { trainingSamples: 4, evaluationSamples: 1 } }
type Call = { url: string; options?: RequestInit }

function fixture(respond: (call: Call) => Response | Promise<Response> = call => {
  if (call.url.startsWith('/api/training/dataset-stats')) return json(stats)
  return json({ success: true, config: parseTrainingDataSettings() })
}) {
  const calls: Call[] = []
  const timers = new Map<number, () => void>()
  let mount!: () => () => void
  let timerId = 0
  const context = vm.createContext({ parseTrainingDataSettings, DEFAULT_TRAINING_MODEL, DEFAULT_FULL_TRAINING_MODEL,
    AbortController, AbortSignal, URLSearchParams, onMount: (callback: typeof mount) => { mount = callback },
    createEventDispatcher: () => () => {}, console: { error() {}, warn() {} },
    apiFetch: async (url: string, options?: RequestInit) => { const call = { url, options }; calls.push(call); return respond(call) },
    window: { setInterval: (callback: () => void) => { timers.set(++timerId, callback); return timerId } },
    clearInterval: (id: number) => timers.delete(id), requestAnimationFrame: (callback: () => void) => callback(),
    confirm: () => false, alert() {},
  })
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isLabeledStatement(node))
    .map(node => node.getText(script)).join('\n')), context)
  return { calls, context, timers, mount: () => mount(), run: (expression: string) => vm.runInContext(expression, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) }
}

function renderWizard(values: Record<string, unknown> = { currentStep: 2, selectedMethod: 'remote-lora' },
  respond: () => Response = () => { assert.fail('rendering must not request training services') }): string {
  let source = component
  const offset = component.indexOf(scriptText)
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  for (const node of declarations.reverse()) {
    if (node.initializer && Object.hasOwn(values, node.name.getText(script))) {
      source = source.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[node.name.getText(script)]) + source.slice(offset + node.initializer.end)
    }
  }
  const code = ts.transpileModule(compile(source, { filename: 'TrainingWizard.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const context = vm.createContext({ exports: {}, AbortController, AbortSignal, URLSearchParams, require: (id: string) => id === 'svelte' ? { onMount() {}, createEventDispatcher: () => () => {} }
    : id === '../lib/client/api-config' ? { apiFetch: respond }
    : id === '@metahuman/core/training-schema' ? { parseTrainingDataSettings }
    : id === '../lib/client/model-defaults' ? { DEFAULT_TRAINING_MODEL, DEFAULT_FULL_TRAINING_MODEL }
    : id === './TrainingDataControls.svelte' ? { default() { assert.fail('the data-controls child is not mounted at the RunPod step') } }
    : componentRequire(id) })
  vm.runInContext(code, context)
  return componentRequire('svelte/server').render(context.exports.default).body
}

function inputHandler(id: string, event = 'input'): string {
  let handler = ''
  function visit(node: any) {
    if (!node || typeof node !== 'object') return
    if (node.attributes?.some((attribute: any) => attribute.name === 'id' && attribute.value?.[0]?.data === id)
      || (event === 'click' && node.name === 'button' && component.slice(node.start, node.end).includes(id))) {
      const directive = node.attributes.find((attribute: any) => attribute.type === 'OnDirective' && attribute.name === event)
      if (directive) handler = component.slice(directive.expression.start, directive.expression.end)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parse(component, { modern: true }))
  assert.ok(handler, `${id} must attribute the actual ${event} event`)
  return transpile(`(${handler})();`)
}

test('a composition save keeps edits made after submission instead of restoring its older response', async () => {
  let finish!: (response: Response) => void
  const f = fixture(call => call.options?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : json(stats))
  f.run("dataSettings = parseTrainingDataSettings({ seed: 'submitted' })")
  const saving = f.run('saveTrainingDataConfig()')
  f.run("dataSettings = { ...dataSettings, seed: 'newer-draft' }")
  finish(json({ success: true, config: parseTrainingDataSettings({ seed: 'submitted' }) }))
  await saving
  assert.equal(f.snapshot('dataSettings.seed'), 'newer-draft')
  assert.equal(JSON.parse(String(f.calls[0].options?.body)).seed, 'submitted')
  assert.equal(f.snapshot('Boolean(trainingDataSaving)'), false)
})

test('only the latest autosave owns readiness, errors and the busy state when replies arrive out of order', async () => {
  for (const olderFirst of [true, false]) {
    const replies: Array<(response: Response) => void> = []
    const f = fixture(call => call.options?.method === 'POST' ? new Promise(resolve => replies.push(resolve)) : json(stats))
    f.run("dataSettings = parseTrainingDataSettings({ seed: 'older' })")
    const first = f.run('saveTrainingDataConfig()')
    f.run("dataSettings = { ...dataSettings, seed: 'latest' }")
    const second = f.run('saveTrainingDataConfig()')
    const completeOlder = async () => { replies[0](json({ success: false, error: 'Old request failed' }, 500)); await first }
    if (olderFirst) {
      await completeOlder()
      assert.equal(f.snapshot('Boolean(trainingDataSaving)'), true)
      assert.equal(f.snapshot('trainingDataError'), '')
    }
    replies[1](json({ success: true, config: parseTrainingDataSettings({ seed: 'latest' }) }))
    await second
    if (!olderFirst) await completeOlder()
    assert.equal(f.snapshot('dataSettings.seed'), 'latest')
    assert.equal(f.snapshot('trainingDataConfigLoaded'), true)
    assert.equal(f.snapshot('trainingDataError'), '')
    assert.equal(f.snapshot('Boolean(trainingDataSaving)'), false)
    assert.equal(f.calls.filter(call => call.url.startsWith('/api/training/dataset-stats')).length, 1)
  }
})

test('a late initial composition read cannot overwrite an explicit settings-change event', async () => {
  let finishRead!: (response: Response) => void
  const f = fixture(call => call.options?.method === 'POST' ? json({ success: true, config: JSON.parse(String(call.options.body)) })
    : call.url === '/api/training-data' ? new Promise(resolve => { finishRead = resolve }) : json(stats))
  const read = f.run('loadTrainingDataConfig()')
  f.run("handleDataSettingsChange({ detail: parseTrainingDataSettings({ seed: 'user-choice' }) })")
  await new Promise(resolve => setImmediate(resolve))
  finishRead(json({ success: true, config: parseTrainingDataSettings({ seed: 'older-read' }) }))
  await read
  assert.equal(f.snapshot('dataSettings.seed'), 'user-choice')
  assert.equal(f.snapshot('trainingDataConfigLoaded'), true)
  assert.equal(f.calls[0].options?.signal?.aborted, true)
})

test('failed composition saves retain their draft and error; successful saves refresh the authoritative dataset preview', async () => {
  let fail = true
  const f = fixture(call => call.options?.method === 'POST' ? fail ? json({ error: 'Invalid composition' }, 400)
    : json({ success: true, config: JSON.parse(String(call.options.body)) }) : json(stats))
  f.run("dataSettings = parseTrainingDataSettings({ seed: 'retain-on-failure', includePersona: false })")
  await f.run('saveTrainingDataConfig()')
  assert.equal(f.snapshot('dataSettings.seed'), 'retain-on-failure')
  assert.equal(f.snapshot('trainingDataError'), 'Invalid composition')
  assert.equal(f.snapshot('trainingDataConfigLoaded'), false)
  assert.equal(f.snapshot('Boolean(trainingDataSaving)'), false)
  fail = false
  await f.run('saveTrainingDataConfig()')
  assert.equal(f.snapshot('trainingDataError'), '')
  assert.equal(f.snapshot('trainingDataConfigLoaded'), true)
  assert.deepEqual(f.snapshot('datasetStats'), stats)
  assert.match(f.calls.at(-1)!.url, /maxSamples=3000&recentDays=30&olderSamples=3000/)
})

test('all training methods retain their launch payloads and navigation semantics without starting a real job', async () => {
  for (const method of ['local-lora', 'remote-lora', 'fine-tune']) {
    const f = fixture(() => json({ success: true, pid: 4321, runLabel: 'fixture-run' }))
    f.run(`selectedMethod = '${method}'; trainingDataConfigLoaded = true; trainingTarget = 'ollama'; hasS3Configured = true;
      trainingConfig.base_model = 'retained-custom-model'; trainingConfig.num_train_epochs = 4;
      useCustomGpu = true; customGpuType = 'fixture-gpu'; startLogsPolling = () => {}`)
    await f.run('launchTraining()')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, '/api/training/launch')
    const body = JSON.parse(String(f.calls[0].options?.body))
    assert.equal(body.method, method)
    assert.equal(body.trainingTarget, 'ollama')
    assert.equal(body.trainingConfig.base_model, 'retained-custom-model')
    assert.equal(body.trainingConfig.num_train_epochs, 4)
    assert.equal(body.trainingConfig.skipGguf, false)
    assert.deepEqual(body.advancedSettings, { enableS3Upload: true, enablePreprocessing: true })
    assert.equal(body.runpodConfig?.gpuType, method === 'local-lora' ? undefined : 'fixture-gpu')
    assert.equal(f.snapshot('trainingRunLabel'), 'fixture-run')
    f.run("canProceed = true; currentStep = 1; nextStep()")
    assert.equal(f.snapshot('currentStep'), method === 'local-lora' ? 3 : 2)
    f.run('currentStep = 3; prevStep()')
    assert.equal(f.snapshot('currentStep'), method === 'local-lora' ? 1 : 2)
  }
})

test('monitoring uses the matching saved terminal receipt; a stopped PID alone is not successful training', async () => {
  for (const status of ['completed', 'failed', 'missing']) {
    const f = fixture(call => json(call.url.includes('/console-logs') ? { success: true, logs: ['fixture output'] }
      : call.url.includes('/running') ? { success: true, running: false }
      : call.url.includes('/history') ? { success: true, runs: status === 'missing' ? [] : [{ runLabel: 'fixture-run', status, error: 'Worker failed' }] }
      : { success: true, logs: [] }))
    f.run("trainingRunLabel = 'fixture-run'; trainingPid = 4321")
    await f.run('pollTrainingLogs()')
    assert.equal(f.snapshot('trainingComplete'), true)
    assert.equal(f.snapshot('trainingFailed'), status !== 'completed')
    assert.equal(f.snapshot('trainingPid'), null)
    if (status !== 'completed') assert.notEqual(f.snapshot('failureReason'), '')
  }
})

test('RunPod settings retain predefined and custom GPU identities without unsupported hourly prices', async () => {
  for (const gpuType of ['NVIDIA H100 PCIe', 'fixture custom GPU']) {
    const f = fixture(() => json({ apiKey: 'fixture-key', templateId: 'fixture-template', gpuType }))
    await f.run('loadRunpodConfig()')
    assert.equal(f.snapshot('runpodConfig.gpuType'), gpuType)
    assert.equal(f.snapshot('useCustomGpu'), gpuType === 'fixture custom GPU')
    assert.equal(f.snapshot('runpodConfigLoaded'), true)
  }
  const html = renderWizard()
  for (const gpu of ['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090', 'NVIDIA A100-PCIE-40GB', 'NVIDIA A100 80GB PCIe', 'NVIDIA H100 PCIe', 'NVIDIA H100 80GB HBM3']) assert.match(html, new RegExp(`value="${gpu}"`))
  assert.doesNotMatch(html, /\$[\d.]+\/hr/)
})

test('navigation releases initial observations and a late running-status response cannot restart monitoring', async () => {
  const replies: Array<(response: Response) => void> = []
  const f = fixture(() => new Promise(resolve => replies.push(resolve)))
  const cleanup = f.mount()
  assert.equal(f.calls.length, 6)
  cleanup()
  assert.ok(f.calls.every(call => call.options?.signal?.aborted))
  for (let index = 0; index < replies.length; index++) {
    const url = f.calls[index].url
    replies[index](json(url.endsWith('/training-data') ? { success: true, config: parseTrainingDataSettings() }
      : url.endsWith('/running') ? { success: true, running: true, pid: 4321, runLabel: 'fixture-run' }
      : url.endsWith('/auth/me') ? { success: true, user: { username: 'fixture-user' } }
      : url.endsWith('/training-config') ? f.snapshot('trainingConfig') : {}))
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 6)
  assert.equal(f.timers.size, 0)
})

test('newer dataset previews supersede earlier reads without replacing their result or loading state', async () => {
  const replies: Array<(response: Response) => void> = []
  const f = fixture(() => new Promise(resolve => replies.push(resolve)))
  const first = f.run('loadDatasetStats()')
  const second = f.run('loadDatasetStats()')
  replies[0](json({ ...stats, totalMemories: 1 }))
  await first
  assert.equal(f.snapshot('loading'), true)
  assert.equal(f.snapshot('datasetStats'), null)
  replies[1](json({ ...stats, totalMemories: 20 }))
  await second
  assert.equal(f.snapshot('datasetStats.totalMemories'), 20)
  assert.equal(f.snapshot('loading'), false)
  assert.equal(f.calls[0].options?.signal?.aborted, true)
})

test('navigation does not cancel or repeat submitted writes or launches, or start their follow-up observations', async () => {
  for (const operation of ['saveTrainingDataConfig()', 'launchTraining()']) {
    let finish!: (response: Response) => void
    const f = fixture(call => call.options?.method === 'POST' ? new Promise(resolve => { finish = resolve })
      : json({ success: true, config: parseTrainingDataSettings() }))
    const cleanup = f.mount()
    f.run("trainingDataConfigLoaded = true; selectedMethod = 'local-lora'")
    const pending = f.run(operation)
    const submitted = f.calls.at(-1)!
    const count = f.calls.length
    cleanup()
    finish(json({ success: true, config: parseTrainingDataSettings(), pid: 4321, runLabel: 'fixture-run' }))
    await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(submitted.options?.signal, undefined)
    assert.equal(f.calls.length, count)
    assert.equal(f.timers.size, 0)
  }
})

test('saved preferences and cancellation keep their existing request and confirmation contracts', async () => {
  const f = fixture(() => json({ success: true }))
  f.run("trainingTarget = 'llama-cpp'; trainingConfig.base_model = 'saved-custom-base'; trainingConfig.num_train_epochs = 3")
  await f.run('saveTrainingPreferences()')
  assert.equal(f.calls[0].url, '/api/training-config')
  assert.deepEqual(JSON.parse(String(f.calls[0].options?.body)), { ...f.snapshot('trainingConfig'), trainingTarget: 'llama-cpp' })
  assert.equal(f.snapshot('settingsMessage'), 'Training settings saved for the wizard and CLI.')
  await f.run('cancelTraining()')
  assert.equal(f.calls.length, 1, 'declining confirmation must not cancel training')
  f.context.confirm = () => true
  f.run('pollTrainingLogs = async () => {}')
  await f.run('cancelTraining()')
  assert.equal(f.calls[1].url, '/api/training/cancel')
  assert.equal(f.calls[1].options?.method, 'POST')
  assert.match(f.snapshot('settingsMessage'), /Cancellation requested/)
  assert.equal(f.snapshot('cancelling'), false)
})

test('loading and saving preferences retains the optional four-bit training choice', async () => {
  const f = fixture(call => call.url === '/api/training-models' ? json({ success: true, models: [] })
    : json({ base_model: 'retained-model', load_in_4bit: true, trainingTarget: 'llama-cpp' }))
  await f.run('loadTrainingPreferences()')
  assert.equal(f.snapshot('preferencesLoaded'), true)
  assert.equal(f.run('trainingConfig.load_in_4bit'), true)
  await f.run('saveTrainingPreferences()')
  assert.equal(JSON.parse(String(f.calls.at(-1)!.options?.body)).load_in_4bit, true)
})

test('failed capability discovery remains unknown, exposes the backend cause and can be retried', async () => {
  let fail = true
  const known = { hasLocalGPU: true, gpuModel: 'fixture-gpu', vramGB: 24, freeVramGB: 20,
    hasUnsloth: true, hasRunpodKey: false, hasS3Configured: true }
  const f = fixture(() => fail ? json({ error: 'GPU inspection unavailable' }, 503) : json(known))
  await f.run('detectCapabilities()')
  assert.equal(f.run('systemCapabilities'), null)
  assert.equal(f.run('capabilityError'), 'GPU inspection unavailable')
  assert.equal(f.run('loading'), false)
  const html = renderWizard({ currentStep: 1, systemCapabilities: null, capabilityError: 'GPU inspection unavailable' })
  assert.match(html, /GPU inspection unavailable/)
  assert.match(html, /Retry capability check/)
  assert.match(html, /Not checked/)
  assert.doesNotMatch(html, /No local GPU or RunPod key detected/)
  fail = false
  await f.run('detectCapabilities()')
  assert.equal(f.run('capabilityError'), '')
  assert.equal(f.run('systemCapabilities.gpuModel'), 'fixture-gpu')
  fail = true
  await f.run('detectCapabilities()')
  assert.equal(f.run('systemCapabilities.hasLocalGPU'), true, 'failed refresh must not invent missing hardware')
})

test('RunPod configuration read failures are visible, retain manual inputs and support retry', async () => {
  let fail = true
  const f = fixture(() => fail ? json({ error: 'RunPod saved configuration unavailable' }, 503)
    : json({ apiKey: 'saved-fixture-key', templateId: 'saved-fixture-template', gpuType: 'NVIDIA H100 PCIe' }))
  f.run("runpodConfig.apiKey = 'manual-fixture-key'; runpodConfig.templateId = 'manual-fixture-template'")
  await f.run('loadRunpodConfig()')
  assert.equal(f.run('runpodConfig.apiKey'), 'manual-fixture-key')
  assert.equal(f.run('runpodConfigLoaded'), false)
  const html = renderWizard({ currentStep: 2, runpodConfigError: 'RunPod saved configuration unavailable' })
  assert.match(html, /RunPod saved configuration unavailable/)
  assert.match(html, /Retry saved RunPod configuration/)
  assert.equal(f.run('runpodConfigError'), 'RunPod saved configuration unavailable')
  fail = false
  await f.run('loadRunpodConfig()')
  assert.equal(f.run('runpodConfigError'), '')
  assert.equal(f.run('runpodConfigLoaded'), true)
  assert.equal(f.run('runpodConfig.apiKey'), 'saved-fixture-key')
})

test('RunPod validation preserves the provider rejection reason and permits retry', async () => {
  let valid = false
  const f = fixture(() => json(valid ? { valid: true } : { valid: false, error: 'Provider rejected this fixture key' }))
  f.run("runpodConfig.apiKey = 'fixture-key'")
  await f.run('validateRunpod()')
  assert.equal(f.run('runpodValid'), false)
  assert.equal(f.run('error'), 'Provider rejected this fixture key')
  assert.equal(f.run('validatingRunpod'), false)
  valid = true
  await f.run('validateRunpod()')
  assert.equal(f.run('runpodValid'), true)
  assert.equal(f.run('error'), '')
})

test('a pending RunPod read preserves manual field edits while still loading untouched fields', async () => {
  for (const clearKey of [false, true]) {
    let finish!: (response: Response) => void
    const f = fixture(() => new Promise(resolve => { finish = resolve }))
    const read = f.run('loadRunpodConfig()')
    f.run("runpodConfig.apiKey = 'manual-key'")
    f.run(inputHandler('apiKey'))
    if (clearKey) {
      f.run("runpodConfig.apiKey = ''")
      f.run(inputHandler('apiKey'))
    }
    f.run("customGpuType = 'manual-gpu'; useCustomGpu = true")
    f.run(inputHandler('customGpuType'))
    finish(json({ apiKey: 'saved-key', templateId: 'saved-template', gpuType: 'NVIDIA H100 PCIe' }))
    await read
    assert.equal(f.run('runpodConfig.apiKey'), clearKey ? '' : 'manual-key')
    assert.equal(f.run('runpodConfig.templateId'), 'saved-template')
    assert.equal(f.run('runpodConfig.gpuType'), 'manual-gpu')
    assert.equal(f.run('useCustomGpu'), true)
  }
})

test('RunPod key edits invalidate earlier validation, including a late response for another key', async () => {
  let finish!: (response: Response) => void
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  f.run("runpodConfig.apiKey = 'old-key'; runpodValid = true")
  f.run("runpodConfig.apiKey = 'new-key'")
  f.run(inputHandler('apiKey'))
  assert.equal(f.run('runpodValid'), false)
  const validation = f.run('validateRunpod()')
  assert.equal(JSON.parse(String(f.calls[0].options?.body)).apiKey, 'new-key')
  f.run("runpodConfig.apiKey = 'latest-key'")
  f.run(inputHandler('apiKey'))
  finish(json({ valid: true }))
  await validation
  assert.equal(f.run('runpodValid'), false)
  assert.equal(f.run('error'), '')
})

test('retrying a saved predefined GPU clears the earlier custom-GPU selection', async () => {
  let gpuType = 'fixture custom GPU'
  const f = fixture(() => json({ apiKey: 'fixture-key', gpuType }))
  await f.run('loadRunpodConfig()')
  assert.equal(f.run('useCustomGpu'), true)
  gpuType = 'NVIDIA H100 PCIe'
  await f.run('loadRunpodConfig()')
  assert.equal(f.run('runpodConfig.gpuType'), gpuType)
  assert.equal(f.run('useCustomGpu'), false)
})

test('an initial dataset failure exposes retry and composition recovery before any statistics exist', async () => {
  let fail = true
  const f = fixture(() => fail ? json({ error: 'Dataset preview unavailable' }, 503) : json(stats))
  await f.run('loadDatasetStats()')
  assert.equal(f.run('loading'), false)
  assert.equal(f.run('datasetStats'), null)
  const html = renderWizard({ currentStep: 3, datasetStats: null, trainingDataLoadAttempted: true,
    trainingDataConfigLoaded: false, trainingDataError: 'Composition unavailable' }, () => { throw new Error('Dataset preview unavailable') })
  assert.match(html, /Dataset preview unavailable/)
  assert.match(html, /Retry dataset preview/)
  assert.match(html, /Composition unavailable/)
  assert.match(html, /Reload data settings/)
  fail = false
  await f.run(inputHandler('Retry dataset preview', 'click'))
  assert.deepEqual(f.snapshot('datasetStats'), stats)
  assert.equal(f.run('error'), '')
})

test('failed initial settings and catalog reads expose recovery without replacing a selected target or newer settings', async () => {
  for (const failedPath of ['/api/training-config', '/api/training-models']) {
    let fail = true
    let finish!: (response: Response) => void
    const f = fixture(call => fail && call.url === failedPath ? json({ error: 'Saved settings unavailable' }, 503)
      : call.url === '/api/training-config' ? new Promise(resolve => { finish = resolve })
      : json({ success: true, models: [{ id: 'saved-base', name: 'Saved base', description: '' }] }))
    // The catalog failure follows a successful settings read.
    if (failedPath === '/api/training-models') {
      const reading = f.run('loadTrainingPreferences()')
      finish(json({ base_model: 'saved-base', trainingTarget: 'llama-cpp' }))
      await reading
    } else await f.run('loadTrainingPreferences()')
    assert.equal(f.run('preferencesLoaded'), false)
    const html = renderWizard({ currentStep: 1, selectedMethod: 'local-lora', preferencesError: f.run('preferencesError') })
    assert.match(html, /Saved settings unavailable/)
    assert.match(html, /Retry settings and model catalog/)
    const continueButton = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes('Continue'))
    assert.ok(continueButton?.includes('disabled'), 'Continue remains disabled until initial preferences load')
    // Execute the target button's real handler before retrying.
    f.run(inputHandler('trainingTargetOllama', 'click'))
    fail = false
    const retry = f.run(inputHandler('Retry settings and model catalog', 'click'))
    f.run('trainingConfig.num_train_epochs = 7')
    finish(json({ base_model: 'saved-base', num_train_epochs: 2, trainingTarget: 'llama-cpp', load_in_4bit: false }))
    await retry
    assert.equal(f.run('preferencesLoaded'), true)
    assert.equal(f.run('preferencesError'), '')
    assert.equal(f.run('trainingTarget'), 'ollama')
    assert.equal(f.run('trainingConfig.num_train_epochs'), 7)
    assert.equal(f.run('trainingConfig.base_model'), 'saved-base')
    assert.equal(f.run('trainingConfig.load_in_4bit'), false)
    assert.equal(f.snapshot('baseModelOptions')[0].value, 'saved-base')
    const recovered = renderWizard({ currentStep: 1, selectedMethod: 'local-lora', preferencesLoaded: true })
    const recoveredButton = recovered.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button => button.includes('Continue'))
    assert.ok(recoveredButton && !recoveredButton.slice(0, recoveredButton.indexOf('>')).includes('disabled'))
  }
})

test('a terminal-history read failure remains an observation error until its saved result can be read', async () => {
  let fail = true
  const f = fixture(call => call.url.includes('/history') ? (fail ? json({ error: 'Terminal history unavailable' }, 503)
    : json({ success: true, runs: [{ runLabel: 'fixture-run', status: 'completed' }] }))
    : json(call.url.includes('/running') ? { success: true, running: false } : { success: true, logs: [] }))
  f.run("trainingRunLabel = 'fixture-run'; trainingPid = 4321")
  await f.run('pollTrainingLogs()')
  assert.equal(f.run('monitoringErrors.history'), 'Terminal history unavailable')
  assert.equal(f.run('trainingComplete || trainingFailed'), false)
  const html = renderWizard({ currentStep: 5, trainingRunLabel: 'fixture-run', monitoringErrors: { history: 'Terminal history unavailable' } })
  assert.match(html, /Terminal result not yet verified/)
  assert.doesNotMatch(html, /Ready to Start Training\?/)
  fail = false
  await f.run('pollTrainingLogs()')
  assert.equal(f.run('trainingComplete'), true)
  assert.equal(f.run('trainingFailed'), false)
  assert.deepEqual(f.snapshot('monitoringErrors'), {})
})

test('monitoring read failures stay scoped and do not prevent independent reads or claim worker failure', async () => {
  for (const [path, key] of [['/logs?', 'events'], ['/console-logs?', 'console'], ['/running', 'status']]) {
    for (const failure of ['http', 'network', 'application']) {
      let fail = true
      const f = fixture(call => {
        if (fail && call.url.includes(path)) {
          if (failure === 'network') throw new Error(`${key} read unavailable`)
          return json({ success: false, error: `${key} read unavailable` }, failure === 'http' ? 503 : 200)
        }
        return json(call.url.includes('/console-logs') ? { success: true, logs: ['Current console'] }
        : call.url.includes('/running') ? { success: true, running: true, pid: 4321 }
        : { success: true, logs: [{ event: 'training_started' }] })
      })
      f.run("trainingRunLabel = 'fixture-run'; trainingPid = 4321")
      await f.run('pollTrainingLogs()')
      const html = renderWizard({ currentStep: 5, trainingPid: 4321, monitoringErrors: { [key]: `${key} read unavailable` } })
      assert.match(html, new RegExp(`${key} read unavailable`))
      assert.match(html, /Retry monitoring reads/)
      assert.equal(f.run(`monitoringErrors.${key}`), `${key} read unavailable`)
      assert.equal(f.run('trainingComplete'), false)
      assert.equal(f.run('trainingFailed'), false)
      assert.equal(f.calls.length, 3, 'one read failure must not suppress the other monitoring reads')
      fail = false
      await f.run(inputHandler('Retry monitoring reads', 'click'))
      assert.deepEqual(f.snapshot('monitoringErrors'), {})
    }
  }
})

test('an initial running-status failure is visible without fabricating a running or completed job', async () => {
  let fail = true
  const f = fixture(call => call.url === '/api/training/running' ? (fail ? json({ error: 'Running status unavailable' }, 503) : json({ success: true, running: false, pid: null }))
    : call.url === '/api/training-models' ? json({ success: true, models: [] })
    : json({ success: true, config: parseTrainingDataSettings() }))
  const cleanup = f.mount()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.run('monitoringErrors.status'), 'Running status unavailable')
  assert.equal(f.run('trainingPid'), null)
  assert.equal(f.run('trainingComplete'), false)
  assert.equal(f.timers.size, 0)
  const html = renderWizard({ currentStep: 1, monitoringErrors: { status: 'Running status unavailable' } })
  assert.match(html, /Running status unavailable/)
  assert.match(html, /Retry monitoring reads/)
  fail = false
  await f.run(inputHandler('Retry monitoring reads', 'click'))
  assert.deepEqual(f.snapshot('monitoringErrors'), {})
  assert.equal(f.run('trainingComplete'), false)
  assert.equal(f.timers.size, 0)
  cleanup()
})

test('current worker progress lines remain visible in the console without synthesizing attempt percentages', () => {
  const logs = ['[ProgressTracker] 🚀 Stage started: training - Training and evaluating the serialized candidate',
    '[ProgressTracker] ✅ Stage completed: training', '[full-cycle] Candidate saved for review: fixture-candidate']
  const html = renderWizard({ currentStep: 5, trainingPid: 4321, consoleLogs: logs })
  for (const line of logs) assert.ok(html.includes(line))
  assert.match(html, /Training in Progress/)
  const f = fixture()
  assert.equal(f.run(`isProgressLine(${JSON.stringify(logs[0])})`), true)
  assert.equal(f.run(`isProgressLine(${JSON.stringify(logs[1])})`), true)
})

test('old running-status and terminal-history replies cannot finish a newly launched run', async () => {
  for (const delayedPath of ['/running', '/history']) {
    let finish!: (response: Response) => void
    const f = fixture(call => call.url.endsWith(delayedPath) ? new Promise(resolve => { finish = resolve })
      : json(call.url.endsWith('/running') ? { success: true, running: false, pid: null } : { success: true, logs: [] }))
    f.run("trainingRunLabel = 'old-run'; trainingPid = 4321")
    const reading = f.run('pollTrainingLogs()')
    await new Promise(resolve => setImmediate(resolve))
    f.run("trainingRunLabel = 'new-run'; trainingPid = 5678; trainingComplete = false; trainingFailed = false; logsInterval = 99")
    f.timers.set(99, () => {})
    finish(json(delayedPath === '/running' ? { success: true, running: false, pid: null }
      : { success: true, runs: [{ runLabel: 'old-run', status: 'completed' }] }))
    await reading
    assert.equal(f.run('trainingPid'), 5678)
    assert.equal(f.run('trainingComplete || trainingFailed'), false)
    assert.equal(f.timers.has(99), true, 'an old observation must not stop the new run monitoring timer')
    assert.deepEqual(f.snapshot('monitoringErrors'), {})
  }
})

test('starting another setup after a terminal run clears its result while retaining training settings', () => {
  for (const [button, failed] of [['New Training', false], ['Change Settings', true]] as const) {
    const f = fixture()
    f.run(`currentStep = 5; trainingComplete = true; trainingFailed = ${failed}; trainingRunLabel = 'finished-run';
      trainingConfig.num_train_epochs = 7; consoleLogs = ['Old output']; trainingLogs = [{ event: 'old_result' }];
      monitoringErrors = { events: 'Old observation failure' }`)
    f.run(inputHandler(button, 'click'))
    assert.equal(f.run('currentStep'), 1)
    assert.equal(f.run('trainingComplete || trainingFailed'), false)
    assert.equal(f.run('trainingRunLabel'), '')
    assert.equal(f.run('trainingConfig.num_train_epochs'), 7)
    assert.deepEqual(f.snapshot('consoleLogs'), [])
    assert.deepEqual(f.snapshot('monitoringErrors'), {})
    const html = renderWizard({ currentStep: 5, trainingComplete: f.run('trainingComplete'), trainingFailed: f.run('trainingFailed') })
    assert.match(html, /Ready to Start Training\?/)
    assert.match(html, /Start Training/)
  }
})
