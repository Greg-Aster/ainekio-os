import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mh-big-brother-cli-'))
process.env.METAHUMAN_ROOT = root
await fs.mkdir(path.join(root, 'etc'))
await fs.writeFile(path.join(root, 'etc', 'tool-executor.json'), JSON.stringify({ backends: {
  codex: { enabled: true, command: 'codex', args: ['exec', '--model=old-model', '-c', 'model_reasoning_effort="low"'], reasoningEffort: 'low' },
} }))
const { buildBigBrotherCLIInvocation, parseBigBrotherTerminalEvent } = await import('./cli.js')
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
test.after(() => fs.rm(root, { recursive: true, force: true }))

const claude = parseBigBrotherTerminalEvent('claude-code', JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: 'Inspect the owner path' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'owner.ts' } },
      { type: 'text', text: 'The owner path is healthy.' },
    ],
  },
}))
assert.equal(claude.finalText, 'The owner path is healthy.')
assert.equal(claude.reasoningSteps[0]?.type, 'thought')
assert.equal(claude.reasoningSteps[1]?.toolName, 'Read')

const codex = parseBigBrotherTerminalEvent('codex', JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'Codex completed the task.' },
}))
assert.equal(codex.finalText, 'Codex completed the task.')
assert.deepEqual(codex.displayLines, ['Codex completed the task.'])

const legacyCodexEvent = parseBigBrotherTerminalEvent('codex', JSON.stringify({
  msg: { type: 'agent_reasoning', text: 'Check the shared session.' },
}))
assert.equal(legacyCodexEvent.reasoningSteps[0]?.content, 'Check the shared session.')

const codexInvocation = buildBigBrotherCLIInvocation('codex', 'Describe the attached image.', {
  images: [{ mimeType: 'image/jpeg', base64: '/9j/2Q==' }],
})
try {
  assert.ok(codexInvocation.args.includes('model_reasoning_effort="low"'))
  assert.equal(codexInvocation.args.some(arg => arg.startsWith('service_tier=')), false)
  const imageArgIndex = codexInvocation.args.indexOf('--image')
  assert.equal(imageArgIndex, codexInvocation.args.length - 2)
  const imagePath = codexInvocation.args[imageArgIndex + 1]
  assert.deepEqual(await fs.readFile(imagePath), Buffer.from('/9j/2Q==', 'base64'))
} finally {
  await fs.rm(codexInvocation.tempDir, { recursive: true, force: true })
}

test('Codex uses the selected profile model and reasoning ahead of stale CLI arguments', async () => {
  const { saveUserConfig } = await import('../../config.js')
  saveUserConfig('operator.json', { bigBrotherMode: {
    provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'medium',
  } }, 'fixture')
  const invocation = buildBigBrotherCLIInvocation('codex', 'Hello', { username: 'fixture' })
  try {
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gpt-6-luna')
    assert.equal(invocation.args.some(arg => arg.includes('old-model')), false)
    assert.ok(invocation.args.includes('model_reasoning_effort="medium"'))
    assert.equal(invocation.args.includes('model_reasoning_effort="low"'), false)
  } finally { await fs.rm(invocation.tempDir, { recursive: true, force: true }) }
  saveUserConfig('operator.json', { bigBrotherMode: { provider: 'claude-code', model: 'sonnet' } }, 'fixture')
  const other = buildBigBrotherCLIInvocation('codex', 'Hello', { username: 'fixture' })
  try { assert.equal(other.args.includes('sonnet'), false) }
  finally { await fs.rm(other.tempDir, { recursive: true, force: true }) }
})

test('diagnostic invocation selects full access, high reasoning and the exact resume thread', async () => {
  const invocation = buildBigBrotherCLIInvocation('codex', 'fixture', {
    diagnostic: { model: 'fixture-choice', reasoning: true, threadId: 'fixture-thread' },
  })
  try {
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'fixture-choice')
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'))
    assert.ok(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'))
    assert.deepEqual(invocation.args.slice(invocation.args.indexOf('resume'), invocation.args.indexOf('resume') + 3), ['resume', 'fixture-thread', '-'])
    assert.equal(invocation.args.includes('--last'), false)
    assert.equal(invocation.args.includes('--color'), false)
    assert.equal(invocation.timeout, 0)
    assert.equal(parseBigBrotherTerminalEvent('codex', JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' })).threadId, 'fixture-thread')
  } finally { await fs.rm(invocation.tempDir, { recursive: true, force: true }) }
})

test('ordinary per-call reasoning requests high or none; absent retains configured effort', async () => {
  const { saveUserConfig } = await import('../../config.js')
  saveUserConfig('operator.json', { bigBrotherMode: {
    provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'medium',
  } }, 'reasoning-fixture')
  for (const enableThinking of [true, false, undefined]) {
    const invocation = buildBigBrotherCLIInvocation('codex', 'Hello', { username: 'reasoning-fixture', enableThinking })
    try {
      const overrides = invocation.args.filter(arg => arg.startsWith('model_reasoning_effort='))
      assert.deepEqual(overrides, [`model_reasoning_effort="${enableThinking === true ? 'high' : enableThinking === false ? 'none' : 'medium'}"`])
    } finally { await fs.rm(invocation.tempDir, { recursive: true, force: true }) }
  }
})

test('native model transport keeps the selected model and leaves diagnostic context settings untouched', async () => {
  const { saveUserConfig } = await import('../../config.js')
  saveUserConfig('operator.json', { bigBrotherMode: { provider: 'codex', model: 'selected-model', reasoningEffort: 'medium' } }, 'native-choice')
  const native = buildBigBrotherCLIInvocation('codex', '', { username: 'native-choice', enableThinking: false,
    modelRequest: { messages: [{ role: 'system', content: 'Supplied instruction' }, { role: 'user', content: 'Supplied input' }] } })
  const diagnostic = buildBigBrotherCLIInvocation('codex', 'Existing diagnostic request', {
    username: 'native-choice', diagnostic: { reasoning: false }, enableThinking: false,
  })
  try {
    assert.equal(native.appServer?.model, 'selected-model')
    assert.equal(native.appServer?.reasoning, 'none')
    assert.equal(native.args[0], 'app-server')
    assert.equal(native.args.includes('--json'), false)
    assert.equal(native.args.includes('--color'), false)
    assert.equal(native.timeout, 0, 'Model execution has no imposed elapsed-time cutoff')
    assert.equal(diagnostic.args[0], 'exec')
    assert.equal(diagnostic.appServer, undefined)
    assert.equal(diagnostic.stdin, 'Existing diagnostic request')
    assert.ok(diagnostic.args.includes('model_reasoning_effort="medium"'))
    assert.equal(diagnostic.args.some(arg => /project_doc_max_bytes|memories\.|skills\.|developer_instructions/.test(arg)), false)
  } finally {
    await fs.rm(native.tempDir, { recursive: true, force: true })
    await fs.rm(diagnostic.tempDir, { recursive: true, force: true })
  }
})

test('native model context capacity overrides only when the graph supplies its configured value', async () => {
  const configPath = path.join(root, 'etc', 'tool-executor.json')
  const original = await fs.readFile(configPath, 'utf8')
  const config = JSON.parse(original)
  config.backends.codex.args.push('-c', 'model_context_window=64000')
  await fs.writeFile(configPath, JSON.stringify(config))
  try {
    for (const contextWindow of [undefined, 872000]) {
      const invocation = buildBigBrotherCLIInvocation('codex', '', {
        modelRequest: { messages: [{ role: 'user', content: 'Supplied input' }],
          ...(contextWindow !== undefined ? { contextWindow } : {}) },
      })
      try {
        assert.deepEqual(invocation.args.filter(argument => argument.startsWith('model_context_window=')),
          [`model_context_window=${contextWindow ?? 64000}`])
      } finally { await fs.rm(invocation.tempDir, { recursive: true, force: true }) }
    }
  } finally { await fs.writeFile(configPath, original) }
})
