import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '../../../..')

test('sleep workflow admits exactly one ordered stage at a time', async () => {
  const runtimeFile = path.join('/tmp', `metahuman-sleep-runtime-${randomUUID()}.json`)
  process.env.MH_SLEEP_RUNTIME_FILE = runtimeFile
  const [{ SLEEP_WORKFLOW_STAGES, advanceSleepWorkflow, beginSleepWorkflow }, { UnifiedQueueManager }, runtime] = await Promise.all([
    import('./sleep-workflow.js'),
    import('./unified-queue-manager.js'),
    import('../sleep-runtime.js'),
  ])

  try {
    const manager = new UnifiedQueueManager()
    const result = beginSleepWorkflow({
      id: 'sleep-parent-test',
      originatingCognitiveMode: 'environment',
      username: 'test-owner',
      source: 'user',
      input: { force: true },
    } as any, manager.enqueue.bind(manager))
    assert.equal('skipped' in result, false)
    assert.deepEqual(SLEEP_WORKFLOW_STAGES.slice(0, 4).map(stage => stage.handler), [
      'agent.organizer', 'agent.curator', 'agent.environment-training-curator', 'training.personalization',
    ])
    assert.equal(SLEEP_WORKFLOW_STAGES.filter(stage => stage.agentId === 'environment-training-curator').length, 1)
    assert.ok(!SLEEP_WORKFLOW_STAGES.some(stage => stage.agentId === 'environment-training-trainer'))

    for (const stage of SLEEP_WORKFLOW_STAGES) {
      const active = manager.getAllTasks()
      assert.equal(active.length, 1)
      assert.equal(active[0].handler, stage.handler)
      assert.equal(active[0].username, 'test-owner')
      assert.equal(active[0].originatingCognitiveMode, 'environment')
      assert.equal(active[0].input.args?.includes('--username') ?? false, false)
      if (stage.handler === 'vector.index-build') assert.equal(active[0].input.agentId, undefined)
      if (stage.handler === 'agent.environment-training-curator') {
        assert.equal(active[0].input.agentId, 'environment-training-curator')
        assert.equal(active[0].correlationId, 'sessionId' in result ? result.sessionId : undefined)
        assert.equal(active[0].input.sleepWorkflow.stageId, stage.id)
        assert.equal(active[0].input.args, undefined)
      }
      const task = manager.claim(active[0].id)
      assert.ok(task)
      const receipt = stage.handler === 'agent.environment-training-curator'
        ? { stdout: JSON.stringify({ attempted: 2, proposalsSaved: 2 }), stderr: '' } : {}
      manager.complete(task.id, true, receipt)
      advanceSleepWorkflow(manager, task, 'completed')
      if (stage.handler === 'agent.environment-training-curator') {
        assert.deepEqual(manager.getTask(task.id)?.result, receipt)
        assert.equal(runtime.readSleepRuntimeState().currentSession?.stages.find(value => value.id === stage.id)?.state, 'completed')
      }
    }

    const state = runtime.readSleepRuntimeState()
    assert.equal(state.phase, 'awake')
    assert.equal(state.currentSession, undefined)
    assert.equal(state.recentSessions[0]?.state, 'completed')
    assert.ok(state.recentSessions[0]?.stages.every(stage => stage.state === 'completed'))

    const stageEnabled = (stage: (typeof SLEEP_WORKFLOW_STAGES)[number]) =>
      stage.id !== 'review-persona' && stage.id !== 'curate-environment-decisions'
    const skippedResult = beginSleepWorkflow({
      id: 'sleep-parent-disabled-child-test',
      username: 'test-owner',
      source: 'user',
      input: { force: true },
    } as any, manager.enqueue.bind(manager), stageEnabled)
    assert.equal('skipped' in skippedResult, false)

    for (const stage of SLEEP_WORKFLOW_STAGES.filter(stageEnabled)) {
      const [active] = manager.getAllTasks()
      assert.equal(active?.handler, stage.handler)
      const task = manager.claim(active.id)
      assert.ok(task)
      manager.complete(task.id, true, {})
      advanceSleepWorkflow(manager, task, 'completed', undefined, stageEnabled)
    }

    const skippedState = runtime.readSleepRuntimeState()
    const personaReview = skippedState.recentSessions[0]?.stages.find(stage => stage.id === 'review-persona')
    assert.equal(personaReview?.state, 'skipped')
    assert.equal(personaReview?.error, 'Disabled in Agent Catalog')
    const decisionReview = skippedState.recentSessions[0]?.stages.find(stage => stage.id === 'curate-environment-decisions')
    assert.equal(decisionReview?.state, 'skipped')
    assert.equal(decisionReview?.error, 'Disabled in Agent Catalog')

    for (const interruption of ['failed', 'wake', 'restart'] as const) {
      const interruptedManager = new UnifiedQueueManager()
      beginSleepWorkflow({
        id: `sleep-decision-review-${interruption}`, username: 'test-owner', source: 'user', input: { force: true },
      } as any, interruptedManager.enqueue.bind(interruptedManager))
      for (let index = 0; index < 2; index++) {
        const [active] = interruptedManager.getAllTasks()
        const task = interruptedManager.claim(active.id)!
        interruptedManager.complete(task.id, true, {})
        advanceSleepWorkflow(interruptedManager, task, 'completed')
      }
      const [review] = interruptedManager.getAllTasks()
      assert.equal(review.handler, 'agent.environment-training-curator')
      if (interruption === 'failed') {
        const task = interruptedManager.claim(review.id)!
        interruptedManager.complete(task.id, false, 'Curator proposal failed')
        advanceSleepWorkflow(interruptedManager, task, 'failed', 'Curator proposal failed')
        const stage = runtime.readSleepRuntimeState().currentSession?.stages.find(value => value.id === 'curate-environment-decisions')
        assert.equal(stage?.state, 'failed')
        assert.equal(stage?.error, 'Curator proposal failed')
        assert.equal(interruptedManager.getTask(task.id)?.state, 'failed')
        assert.equal(interruptedManager.getAllTasks()[0]?.handler, 'training.personalization')
        while (interruptedManager.getAllTasks().length) {
          const [active] = interruptedManager.getAllTasks()
          const next = interruptedManager.claim(active.id)!
          interruptedManager.complete(next.id, true, next.handler === 'training.personalization'
            ? { skipped: true, reason: 'Automatic training disabled in fixture' } : {})
          advanceSleepWorkflow(interruptedManager, next, 'completed')
        }
        const completed = runtime.readSleepRuntimeState().recentSessions[0]
        assert.equal(completed?.state, 'completed')
        assert.equal(completed?.stages.find(value => value.id === 'curate-environment-decisions')?.state, 'failed')
        assert.equal(completed?.stages.find(value => value.id === 'train-personalization')?.state, 'skipped')
        assert.equal(completed?.stages.at(-1)?.state, 'completed')
      } else {
        if (interruption === 'wake') runtime.wakeSleepSession('User activity resumed')
        else runtime.reconcileSleepRuntime([])
        interruptedManager.cancel(review.id, 'Sleep interrupted')
        assert.equal(advanceSleepWorkflow(interruptedManager, review, 'completed'), null)
        assert.equal(runtime.readSleepRuntimeState().currentSession, undefined)
        assert.equal(runtime.readSleepRuntimeState().recentSessions[0]?.state, interruption === 'wake' ? 'cancelled' : 'interrupted')
        assert.equal(interruptedManager.getAllTasks().length, 0)
      }
    }
  } finally {
    fs.rmSync(runtimeFile, { force: true })
    delete process.env.MH_SLEEP_RUNTIME_FILE
  }
})

test('sleep-owned agents have no independent autonomy schedules', async () => {
  const { SLEEP_WORKFLOW_STAGES } = await import('./sleep-workflow.js')
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'etc', 'agents.json'), 'utf8'))
  const sleepOwned = [
    'organizer',
    'curator',
    'desire-agent',
  ]
  for (const id of sleepOwned) assert.equal(config.agents[id].type, 'manual', id)

  const scheduledAwake = Object.values(config.agents).filter((agent: any) =>
    agent.enabled && !['manual', 'event'].includes(agent.type) && agent.id !== 'sleep-workflow') as any[]
  assert.ok(scheduledAwake.length > 0)
  assert.ok(scheduledAwake.every(agent => JSON.stringify(agent.allowedModes) === JSON.stringify(['semi'])))
  assert.deepEqual(config.agents['sleep-workflow'].allowedModes, ['semi', 'full'])
  assert.equal(SLEEP_WORKFLOW_STAGES.filter(stage => stage.id.includes('desire')).length, 1)
  assert.equal(SLEEP_WORKFLOW_STAGES.find(stage => stage.id.includes('desire'))?.agentId, 'desire-agent')
  assert.equal(SLEEP_WORKFLOW_STAGES.at(-1)?.handler, 'vector.index-build')
})
