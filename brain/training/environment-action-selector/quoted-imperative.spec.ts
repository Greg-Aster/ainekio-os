import assert from 'node:assert/strict'
import test from 'node:test'
import { DEVELOPMENT_CASES, EVALUATION_CASES, buildDevelopmentRecords, validateDevelopmentRecords } from './generate-training-data.js'

test('quoted commands remain conversation-only while unquoted commands retain body intent', async () => {
  const selected = [...DEVELOPMENT_CASES, ...EVALUATION_CASES].filter(c => c.suite.startsWith('quoted-imperative-'))
  const rows = await buildDevelopmentRecords(selected)
  assert.deepEqual(validateDevelopmentRecords(rows, selected), [])
  const development = rows.filter(r => r.metadata.sourceSplit === 'development')
  const fit = new Set(development.map(r => r.user))
  for (const row of rows) {
    const input = JSON.parse(row.user), output = JSON.parse(row.output), i = row.metadata.instructionIndex
    assert.ok(!input.currentInstruction.includes('Whoa, quick movement!'))
    assert.ok(!input.currentInstruction.includes('Take a bow, my friend.'))
    if (row.metadata.sourceSplit === 'evaluation') assert.ok(!fit.has(row.user))
    const peers = rows.filter(r => r.metadata.suite === row.metadata.suite)
    assert.equal(new Set(peers.map(r => r.metadata.developmentFold)).size, 1)
    assert.equal(row.metadata.inputSource, 'user')
    if (i === 2 || i === 7) { assert.equal(output.program, null); continue }
    assert.ok(!output.taskDecision.objective.includes('"'), 'Objectives must not echo raw nested quotes')
    const steps = output.program.steps
    assert.equal(steps.length, [1, 1, 0, 1, 2, 1, 1][i])
    for (const step of steps) {
      assert.equal(step.kind, 'action')
      assert.ok(['requestMotion', 'stop'].includes(step.action.type))
    }
    if (i === 0) {
      const direct = peers.find(r => r.metadata.instructionIndex === 5 && r.metadata.contextVariation === row.metadata.contextVariation)!
      const directOutput = JSON.parse(direct.output)
      assert.notDeepEqual(steps[0].action, directOutput.program.steps[0].action)
    }
  }
})
