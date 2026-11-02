import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-candidate-review-'))
process.env.METAHUMAN_ROOT = root
const adapters = await import('./adapters.js')
const { OllamaClient } = await import('./ollama.js')
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('./audit.js')
setAuditEnabled(false)
const { handleAssignModelRole } = await import('./api/handlers/model-registry.js')
const { withUserContext } = await import('./context.js')
const { getProfilePaths } = await import('./path-builder.js')
const { migrateModelRegistry } = await import('./model-resolver.js')
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(username: string, target = 'ollama', method = 'local-lora') {
  const runLabel = '2026-09-09T01-02-03-000Z'
  const directory = path.join(getProfilePaths(username).out, 'adapters', runLabel.slice(0, 10), runLabel)
  const artifact = path.join(directory, method === 'fine-tune' ? 'model' : 'adapter')
  fs.mkdirSync(artifact, { recursive: true })
  const config = JSON.stringify({ trainingTarget: target })
  const manifest = { version: 2, baseModel: 'fixture/base', systemPrompt: 'Fixture persona', evaluation: { sha256: hash('evaluation') } }
  const datasetId = hash(JSON.stringify(manifest))
  const inventory: Record<string, string> = {}
  for (const [file, data] of Object.entries({ 'adapter_model.safetensors': 'weights', 'tokenizer_config.json': '{}' })) {
    fs.writeFileSync(path.join(artifact, file), data)
    inventory[file] = hash(data)
  }
  const evaluation = JSON.stringify({ version: 1, loss: 1, count: 3, evaluationSha256: manifest.evaluation.sha256, artifacts: { ...inventory } })
  fs.writeFileSync(path.join(artifact, 'artifact-evaluation.json'), evaluation)
  inventory['artifact-evaluation.json'] = hash(evaluation)
  const ggufName = target === 'llama-cpp' && method !== 'fine-tune' ? 'adapter.gguf' : 'model.gguf'
  fs.writeFileSync(path.join(artifact, ggufName), 'GGUFfixture')
  inventory[ggufName] = hash('GGUFfixture')
  const result = { version: 1, status: 'candidate', datasetId, baseModel: manifest.baseModel, configSha256: hash(config),
    templateSha256: hash('fixture template'), trainingMode: method === 'fine-tune' ? 'full_finetune' : 'lora',
    trainingSamples: 30, evaluationSamples: 3, supervisedTokens: 100, baselineLoss: 2, candidateLoss: 1, qualityGate: 'passed',
    evaluationPolicy: 'independent', supervision: 'final-assistant-only', activation: 'not-activated', servingValidation: 'required', artifacts: inventory }
  fs.writeFileSync(path.join(artifact, 'training-result.json'), JSON.stringify(result))
  fs.writeFileSync(path.join(directory, 'config.json'), config)
  fs.writeFileSync(path.join(directory, 'dataset-manifest.json'), JSON.stringify({ ...manifest, datasetId }))
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify({ username, runLabel, method, trainingTarget: target,
    baseModel: manifest.baseModel, status: 'candidate', datasetId }))
  return { username, runLabel, directory, artifact, result, model: adapters.trainingCandidateModelName(username, runLabel, target) }
}

test('actual review and role assignment require verified files, serving identity and an explicit decision', async t => {
  const run = fixture('review-owner')
  // Serving startup is outside candidate approval; never start a host service in this fixture.
  t.mock.method(OllamaClient.prototype, 'isRunning', async () => true)
  let template = 'fixture template'
  t.mock.method(OllamaClient.prototype, 'showModel', async (model: string) => ({
    template, modelfile: model === run.model ? 'FROM sha256-' + run.result.artifacts['model.gguf'] : 'FROM baseline',
  }))
  t.mock.method(OllamaClient.prototype, 'chat', async (model: string, messages: any[]) => ({
    model, message: { role: 'assistant', content: model + ': ' + messages.at(-1).content },
  }))
  const modelId = 'ollama.' + run.model
  const etc = getProfilePaths(run.username).etc
  fs.mkdirSync(etc, { recursive: true })
  const registry = { version: '1.0.0', description: 'Synthetic fixture registry', models: {
    base: { provider: 'ollama', description: 'Baseline fixture', model: 'baseline:latest', roles: ['persona'], capabilities: ['text'], adapters: [], options: {} },
    controller: { provider: 'ollama', description: 'Controller fixture', model: 'controller:latest', roles: ['orchestrator'], capabilities: ['text'], adapters: [], options: {} },
  }, defaults: { persona: 'base', orchestrator: 'controller' } }
  const registryFile = path.join(etc, 'models.json')
  fs.writeFileSync(registryFile, JSON.stringify(migrateModelRegistry(registry as any).registry))
  const assign = (selected: string) => withUserContext({ username: run.username, userId: run.username, role: 'owner' },
    () => handleAssignModelRole({ user: { username: run.username, userId: run.username, role: 'owner', isAuthenticated: true },
      body: { role: 'persona', modelId: selected } } as any))
  const before = fs.readFileSync(registryFile, 'utf8')
  const denied = await assign(modelId)
  assert.notEqual(denied.status, 200)
  assert.match(denied.error!, /Review and accept/)
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before)
  await assert.rejects(adapters.prepareTrainingCandidate(run.username, '../../escape'), /Invalid training run/)
  const review = await adapters.testTrainingCandidate(run.username, run.runLabel, { baselineProvider: 'ollama', baselineModel: 'baseline:latest', prompts: ['Normal task', 'Correct a mistake', 'Edge case'] })
  assert.equal(review.cases.length, 3)
  assert.ok(review.cases.every(item => item.candidate.includes(item.prompt) && item.baseline.includes(item.prompt)))
  await assert.rejects(adapters.decideTrainingCandidate(run.username, run.runLabel, { reviewId: review.id, decision: 'accepted', notes: 'checked', checks: [true] }), /every candidate response/)
  template = 'changed template'
  await assert.rejects(adapters.decideTrainingCandidate(run.username, run.runLabel, { reviewId: review.id, decision: 'accepted', notes: 'checked', checks: [true, true, true] }), /identity changed/)
  template = 'fixture template'
  await adapters.decideTrainingCandidate(run.username, run.runLabel, { reviewId: review.id, decision: 'accepted', notes: 'Synthetic review meets fixture criteria.', checks: [true, true, true] })
  assert.equal((await assign(modelId)).status, 200)
  const assigned = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
  assert.equal(assigned.defaults.persona, modelId)
  assert.equal(assigned.defaults.orchestrator, 'controller')
  assert.equal(adapters.getActiveAdapter(run.username)?.runLabel, run.runLabel)
  const { handleGetModelInfo } = await import('./api/handlers/model-info.js')
  const info = await handleGetModelInfo({ user: { username: run.username, isAuthenticated: true } } as any)
  assert.equal(info.data?.activeModel, run.model)
  assert.equal(info.data?.adapter.runLabel, run.runLabel)
  assert.equal((await assign('base')).status, 200)
  assert.equal(adapters.getActiveAdapter(run.username), null)
  const reopened = await adapters.reopenTrainingCandidateReview(run.username, run.runLabel)
  assert.ok(reopened.reopenedAt)
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'ollama', run.model), /Review and accept/)
  await assert.rejects(adapters.decideTrainingCandidate(run.username, run.runLabel, { reviewId: reopened.id, decision: 'accepted', notes: 'Reuse old review', checks: [true, true, true] }), /fresh comparison/)
  const fresh = await adapters.testTrainingCandidate(run.username, run.runLabel, { baselineProvider: 'ollama', baselineModel: 'baseline:latest', prompts: ['Normal task', 'Correct a mistake', 'Edge case'] })
  assert.equal(fresh.reopenedAt, undefined)
  await adapters.decideTrainingCandidate(run.username, run.runLabel, { reviewId: fresh.id, decision: 'accepted', notes: 'Fresh serving identity checked', checks: [true, true, true] })
  assert.equal((await adapters.assertTrainingModelApproved(run.username, 'ollama', run.model))?.runLabel, run.runLabel)
  fs.writeFileSync(registryFile, '{broken')
  const unreadable = await assign('base')
  assert.notEqual(unreadable.status, 200)
  assert.match(unreadable.error!, /existing assignments were preserved/)
  assert.equal(fs.readFileSync(registryFile, 'utf8'), '{broken')
  fs.writeFileSync(path.join(run.artifact, 'adapter_model.safetensors'), 'tampered')
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'ollama', run.model), /checksum mismatch/)
  await assert.rejects(adapters.assertTrainingModelApproved('other-owner', 'ollama', run.model), /no review owned/)
})

test('legacy adapter toggles cannot bypass role selection and persona controls share one profile owner', async () => {
  const username = 'settings-owner'
  const { loadBackendConfig } = await import('./llm-backend.js')
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.writeFileSync(path.join(root, 'etc', 'llm-backend.json'), JSON.stringify({ activeBackend: 'ollama' }))
  loadBackendConfig(true)
  const paths = getProfilePaths(username)
  fs.mkdirSync(paths.etc, { recursive: true })
  const file = path.join(paths.etc, 'models.json')
  const registry = { version: '1.0.0', description: 'Fixture settings', globalSettings: { includePersonaSummary: true, useAdapter: true, activeAdapter: 'unreviewed-old-model' },
    defaults: { persona: 'base' }, models: { base: { provider: 'ollama', model: 'baseline:latest', roles: ['persona'], capabilities: ['text'], adapters: [], options: {} } } }
  fs.writeFileSync(file, JSON.stringify(migrateModelRegistry(registry as any).registry))
  const { ModelResolverNode } = await import('./nodes/llm/model-resolver.node.js')
  const { handleGetAgentConfig, handleSetAgentConfig } = await import('./api/handlers/agent-config.js')
  const { handleSetPersonaToggle, handleGetPersonaToggle } = await import('./api/handlers/persona-toggle.js')
  const { handleUpdateModelSettings } = await import('./api/handlers/model-registry.js')
  const user = { username, userId: username, role: 'owner', isAuthenticated: true }
  const persona = path.join(root, 'profiles', username, 'persona')
  fs.mkdirSync(persona, { recursive: true })
  fs.writeFileSync(path.join(persona, 'core.json'), '{}')
  const { createDefaultPersonaFacetConfig } = await import('./persona-facets.js')
  fs.writeFileSync(path.join(persona, 'facets.json'), JSON.stringify({ ...createDefaultPersonaFacetConfig(), activeFacet: 'inactive' }))
  const resolved = await withUserContext({ username, userId: username, role: 'owner' }, () => ModelResolverNode.execute({ role: 'persona' }, { username } as any, {}))
  assert.equal(resolved.model, 'baseline:latest')
  assert.equal(resolved.modelId, 'base')
  assert.equal(resolved.usingLora, false)
  const initial = fs.readFileSync(file, 'utf8')
  assert.equal((await handleSetAgentConfig({ user, body: { useAdapter: true } } as any)).status, 400)
  assert.equal(fs.readFileSync(file, 'utf8'), initial)
  assert.equal((await handleSetPersonaToggle({ user, body: { enabled: false } } as any)).status, 200)
  assert.equal((await handleGetAgentConfig({ user } as any)).data?.config.includePersonaSummary, false)
  assert.equal((await handleUpdateModelSettings({ user, body: { globalSettings: { includePersonaSummary: true } } } as any)).status, 200)
  assert.equal((await handleGetPersonaToggle({ user } as any)).data?.includePersonaSummary, true)
  const final = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(final.globalSettings, { includePersonaSummary: true })
  assert.deepEqual(final.defaults, JSON.parse(initial).defaults)
  assert.equal((await handleGetPersonaToggle({ user: { isAuthenticated: false } } as any)).status, 401)
})

test('historical candidates from retired providers remain readable without becoming launchable', async () => {
  const run = fixture('historical-owner', 'retired-provider');
  assert.equal(adapters.listTrainingCandidates(run.username)[0].target, 'retired-provider');
  await assert.rejects(adapters.prepareTrainingCandidate(run.username, run.runLabel), /retired serving provider/);
  assert.equal(fs.existsSync(run.artifact), true);
});

test('llama.cpp review compares the exact loaded adapter against its unadapted base', async t => {
  const run = fixture('llama-review-owner', 'llama-cpp')
  const adapterPath = path.join(run.artifact, 'adapter.gguf')
  let loaded = false
  let template = 'fixture-native-template'
  let heldRoute: string | undefined
  let heldResponse: import('node:http').ServerResponse | undefined
  let onHeld: (() => void) | undefined
  const requests: Array<{ url: string; body: any }> = []
  const server = createServer((request, response) => {
    void (async () => {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = text ? JSON.parse(text) : null
      requests.push({ url: request.url!, body })
      response.setHeader('Content-Type', 'application/json')
      if (heldRoute && request.url?.startsWith(heldRoute)) {
        heldResponse = response
        onHeld?.()
        return
      }
      if (request.url?.startsWith('/props?model=')) {
        response.end(JSON.stringify({ model_path: '/fixture/base.gguf', model_alias: 'fixture-base',
          chat_template: template, default_generation_settings: { n_ctx: 4096 }, is_sleeping: false }))
      } else if (request.url?.startsWith('/lora-adapters?model=')) {
        response.end(JSON.stringify(loaded ? [{ id: 7, path: adapterPath, scale: 0 }] : []))
      } else if (request.url === '/v1/chat/completions') {
        response.end(JSON.stringify({ choices: [{ message: { content: (body.lora?.length ? 'candidate: ' : 'base: ') + body.messages.at(-1).content } }] }))
      } else { response.writeHead(404); response.end('{}') }
    })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: error.message })) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const etc = getProfilePaths(run.username).etc
  fs.mkdirSync(etc, { recursive: true })
  fs.writeFileSync(path.join(etc, 'models.json'), JSON.stringify(migrateModelRegistry({ version: '1.0.0', description: 'Synthetic llama.cpp review',
    defaults: { persona: 'base' }, models: { base: { provider: 'llama-cpp', model: 'fixture-base', description: 'Fixture base', roles: ['persona'],
      capabilities: ['text'], adapters: [], options: { endpoint } },
      trained: { provider: 'llama-cpp', model: 'fixture-base', description: 'Fixture adapter', roles: [], capabilities: ['text'],
        adapters: [adapterPath], options: { endpoint, lora: [{ path: adapterPath, scale: 1 }] } } } } as any).registry))
  // Observe the existing launcher boundary inside this temporary fixture only.
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'llama-cpp-services'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const user = { username: run.username, userId: run.username, role: 'owner', isAuthenticated: true }
  const assign = () => withUserContext(user, () => handleAssignModelRole({ user, body: { role: 'persona', modelId: 'trained' } } as any))
  assert.match((await assign()).error ?? '', /Review and accept/)
  assert.equal(await adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base'), null)
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base', { endpoint, lora: [{ path: adapterPath, scale: 1 }] }), /Review and accept/)
  await assert.rejects(adapters.prepareTrainingCandidate(run.username, run.runLabel), /Load this exact candidate/)
  loaded = true
  assert.equal((await adapters.prepareTrainingCandidate(run.username, run.runLabel)).model, 'fixture-base')
  const review = await adapters.testTrainingCandidate(run.username, run.runLabel, { baselineProvider: 'llama-cpp',
    baselineModel: 'fixture-base', prompts: ['Greet someone', 'Explain a correction', 'Discuss an unfamiliar topic'] })
  assert.ok(review.cases.every(row => row.baseline === 'base: ' + row.prompt && row.candidate === 'candidate: ' + row.prompt))
  const chats = requests.filter(request => request.url === '/v1/chat/completions')
  assert.equal(chats.length, 6)
  assert.ok(chats.every((request, index) => JSON.stringify(request.body.lora) === JSON.stringify(index % 2 ? [{ id: 7, scale: 1 }] : [])))
  assert.ok(chats.every(request => request.body.chat_template_kwargs.enable_thinking === false))
  template = 'changed-template'
  await assert.rejects(adapters.decideTrainingCandidate(run.username, run.runLabel,
    { reviewId: review.id, decision: 'accepted', notes: 'fixture', checks: [true, true, true] }), /identity changed/)
  template = 'fixture-native-template'
  await adapters.decideTrainingCandidate(run.username, run.runLabel,
    { reviewId: review.id, decision: 'accepted', notes: 'synthetic fixture review', checks: [true, true, true] })
  const options = { endpoint, lora: [{ path: adapterPath, scale: 1 }] }
  assert.equal((await adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base', options))?.runLabel, run.runLabel)
  loaded = false
  const beforeAssignment = requests.length
  assert.equal((await adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base',
    { endpoint, lora: [{ scale: 1, path: adapterPath }] }, 'assignment'))?.runLabel, run.runLabel)
  assert.equal((await assign()).status, 200)
  assert.equal(requests.length, beforeAssignment, 'Cold assignment validates saved approval without serving discovery or loading')
  assert.equal(adapters.getActiveAdapter(run.username)?.runLabel, run.runLabel)
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base',
    { endpoint, lora: [{ path: adapterPath, scale: 2 }] }), /serving configuration changed/)
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base',
    { endpoint: endpoint + '/other', lora: options.lora }), /serving configuration changed/)
  const beforeStaticRejection = requests.length
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base',
    { endpoint: endpoint + '/other', lora: options.lora }, 'assignment'), /serving configuration changed/)
  assert.equal(requests.length, beforeStaticRejection, 'Changed assignment config is rejected without network discovery')
  loaded = true
  const { callProvider } = await import('./providers/bridge.js')
  const context = { username: run.username, userId: run.username, role: 'owner' }
  const answer = await withUserContext(context, () => callProvider('llama-cpp', [{ role: 'user', content: 'Dispatch fixture' }],
    { ...options, model: 'fixture-base' }))
  assert.equal(answer.content, 'candidate: Dispatch fixture')
  const baseAnswer = await withUserContext(context, () => callProvider('llama-cpp', [{ role: 'user', content: 'Base fixture' }],
    { endpoint, model: 'fixture-base', lora: [] }))
  assert.equal(baseAnswer.content, 'base: Base fixture')
  for (const route of ['/props?', '/lora-adapters?']) {
    heldRoute = route
    const reached = new Promise<void>(resolve => { onHeld = resolve })
    const controller = new AbortController()
    const before = requests.filter(request => request.url === '/v1/chat/completions').length
    const pending = withUserContext(context, () => callProvider('llama-cpp', [{ role: 'user', content: 'Cancelled fixture' }],
      { ...options, model: 'fixture-base', signal: controller.signal })).then(
      () => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }))
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await reached
      controller.abort(new Error('fixture caller stopped'))
      const result = await Promise.race([pending, new Promise<{ status: 'pending' }>(resolve => {
        deadline = setTimeout(() => resolve({ status: 'pending' }), 1000)
      })])
      assert.equal(result.status, 'rejected', 'caller cancellation must stop ' + route + ' during approval')
      if (result.status === 'rejected') assert.match(result.error.message, /fixture caller stopped/)
      assert.equal(requests.filter(request => request.url === '/v1/chat/completions').length, before)
    } finally {
      clearTimeout(deadline)
      heldResponse?.destroy()
      heldRoute = undefined
      await pending
    }
  }
  await assert.rejects(withUserContext({ ...context, username: 'another-profile' }, () => callProvider('llama-cpp',
    [{ role: 'user', content: 'Dispatch fixture' }], { ...options, model: 'fixture-base' })), /no review owned/)
  assert.equal(await adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base'), null)
  await assert.rejects(adapters.assertTrainingModelApproved('another-profile', 'llama-cpp', 'fixture-base', { endpoint, lora: [{ path: adapterPath, scale: 1 }] }), /no review owned/)
  assert.ok(requests.every(request => request.url.startsWith('/props?model=fixture-base')
    || request.url.startsWith('/lora-adapters?model=fixture-base') || request.url === '/v1/chat/completions'))
  fs.writeFileSync(adapterPath, 'tampered')
  const beforeTamperedAssignment = requests.length
  assert.match((await assign()).error ?? '', /checksum mismatch/)
  assert.equal(requests.length, beforeTamperedAssignment, 'Tampered assignment artifact is rejected without network discovery')
  await assert.rejects(adapters.assertTrainingModelApproved(run.username, 'llama-cpp', 'fixture-base', { endpoint, lora: [{ path: adapterPath, scale: 1 }] }), /checksum mismatch/)
})
