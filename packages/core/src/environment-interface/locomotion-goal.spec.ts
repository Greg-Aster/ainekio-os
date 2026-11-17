import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeLocomotionGoal, evaluateLocomotionGoal, summarizeDepthSpatialClearance, trackLocomotionProgress } from './active-task.js'
import type { EnvironmentLocomotionMeasurement } from './types.js'
import { buildEnvironmentSelectorJsonSchema } from './task-selection.js'

const observedAt = new Date().toISOString()
const evidence = { available: true, source: 'calibrated-ground-plane', robotId: 'robot', referenceId: 'reference', observedAt }
const start: EnvironmentLocomotionMeasurement = { position: { ...evidence, xMetres: 2, yMetres: 3, headingDegrees: 90, uncertaintyMetres: .03 } }
test('distance uses initial body heading and current position in the same measured reference', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'forward', metres: 1, tolerance: .05 })
  assert.equal(evaluateLocomotionGoal(goal, start).reached, false)
  const measured = { position: { ...start.position!, yMetres: 4 } }
  const result = evaluateLocomotionGoal(goal, measured, start)
  assert.equal(result.reached, true)
  assert.equal(result.progress.targetY, 4)
  assert.equal(evaluateLocomotionGoal(goal, { position: { ...measured.position, referenceId: 'new-calibration' } }, start).reached, false)
  assert.match(evaluateLocomotionGoal(goal, {}, start).reason!, /unavailable/)
})
test('relative turn uses accumulated orientation with its own reference independently of camera calibration', () => {
  const initial = { yaw: { ...evidence, source: 'imu', degrees: 350, uncertaintyDegrees: null } }
  const goal = normalizeLocomotionGoal({ kind: 'relativeTurn', degrees: 450, tolerance: 2 })
  assert.equal(evaluateLocomotionGoal(goal, { yaw: { ...initial.yaw, degrees: 440 } }, initial).reached, false)
  assert.equal(evaluateLocomotionGoal(goal, { yaw: { ...initial.yaw, degrees: 800 } }, initial).reached, true)
  assert.match(evaluateLocomotionGoal(goal, { yaw: { ...initial.yaw, referenceId: 'reboot' } }, initial).reason!, /reference/)
})
test('metric proximity requires exact selected ground point; follow relationship never claims endpoint completion', () => {
  const target = { frameId: 'frame', frameTimestamp: observedAt, box: { x: .2, y: .2, width: .4, height: .5 }, trackId: 'track', groundContact: { x: .4, y: .7 } }
  const approach = normalizeLocomotionGoal({ kind: 'approach', target, proximity: { kind: 'metric', metres: 1, tolerance: .1 } })
  assert.throws(() => normalizeLocomotionGoal({ ...approach, target: { ...target, groundContact: undefined } }), /ground contact/)
  const measurement = { target: { ...evidence, frameId: 'current', trackId: 'track', groundContact: target.groundContact, rangeMetres: 1, uncertaintyMetres: .05 } }
  assert.equal(evaluateLocomotionGoal(approach, measurement).reached, true)
  assert.equal(evaluateLocomotionGoal({ ...approach, kind: 'follow', endingCondition: 'Explicit termination' } as any, measurement).reached, false)
  assert.match(evaluateLocomotionGoal(approach, { target: { ...measurement.target, trackId: 'other' } }).reason!, /unavailable/)
})
test('stale measurements never establish arrival and unknown uncertainty remains unknown', () => {
  const goal = normalizeLocomotionGoal({ kind: 'relativeTurn', degrees: 20, tolerance: 1 })
  const initial = { yaw: { ...evidence, degrees: 0, uncertaintyDegrees: null } }
  const current = { yaw: { ...initial.yaw, degrees: 20, expiresAt: new Date(0).toISOString() } }
  assert.equal(evaluateLocomotionGoal(goal, current, initial).reached, false)
  assert.equal(current.yaw.uncertaintyDegrees, null)
})
test('schema requires locomotionGoal on move while retaining description-based gestures', () => {
  const schema = buildEnvironmentSelectorJsonSchema({ actions: ['move', 'requestMotion', 'captureImage'],
    locomotion: { commands: ['walk', 'w'], goalKinds: ['distance', 'relativeTurn', 'approach', 'follow', 'visual'] } })
  const visit = (value: any): any[] => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(visit)]
  const objects = visit(schema)
  assert.equal(objects.some(v => v.properties?.command), false)
  assert.ok(objects.some(v => v.properties?.type?.enum?.includes('requestMotion') && v.required?.includes('description')))
  for (const node of objects.filter(v => v.properties?.type?.enum?.includes('move') || v.properties?.type?.const === 'move')) {
    assert.ok(node.required?.includes('locomotionGoal'))
  }
})

test('missing or nonfinite numeric measurements are unavailable rather than endless steering', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'forward', metres: 1, tolerance: .1 })
  for (const xMetres of [NaN, Infinity, undefined]) {
    assert.match(evaluateLocomotionGoal(goal, { position: { ...start.position!, xMetres } } as any, start).reason!, /unavailable/)
  }
  const turn = normalizeLocomotionGoal({ kind: 'relativeTurn', degrees: 90, tolerance: 2 })
  assert.match(evaluateLocomotionGoal(turn, { yaw: { ...evidence, degrees: NaN, uncertaintyDegrees: null } }).reason!, /unavailable/)
})

test('backward distance preserves reverse traversal without adding a half-turn', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'back', metres: 1, tolerance: .05 })
  const progress = evaluateLocomotionGoal(goal, start)
  assert.equal(progress.forward, -100)
  assert.equal(progress.turn, 0)
  assert.ok(Math.abs(Number(progress.progress.targetX) - 2) < 1e-12)
  assert.equal(progress.progress.targetY, 2)
  const endpoint = { position: { ...start.position!, yMetres: 2 } }
  assert.equal(evaluateLocomotionGoal(goal, endpoint, start).reached, true)
})

test('Crab projects endpoint correction into body axes and reverses measured overshoot', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'left', metres: 1, tolerance: .05 })
  const initial: EnvironmentLocomotionMeasurement = { position: { ...evidence, xMetres: 0, yMetres: 0, headingDegrees: 0, uncertaintyMetres: null } }
  const evaluate = (xMetres: number, yMetres: number, headingDegrees = 0) => evaluateLocomotionGoal(goal,
    { position: { ...initial.position!, xMetres, yMetres, headingDegrees } }, initial, Date.now(), 'crab')
  assert.ok(Math.abs(evaluate(0, 0).forward!) < 1e-12)
  assert.equal(evaluate(0, 0).lateral, 100)
  assert.equal(evaluate(0, 1.2).lateral, -100)
  assert.equal(evaluate(0, 1.2).reached, false)
  const displaced = evaluate(.5, .5)
  assert.ok(displaced.forward! < 0 && displaced.lateral! > 0)
  assert.ok(Math.abs(Math.hypot(displaced.forward!, displaced.lateral!) - 100) < 1e-10)
  assert.equal(displaced.turn, 0)
  assert.ok(evaluate(0, 0, 90).forward! > 99)
  assert.ok(Math.abs(evaluate(0, 0, 90).lateral!) < 1e-12)
  assert.equal(evaluate(0, 1).reached, true)
})

test('Crab body projection stays within the transport percentage range at floating point boundaries', () => {
  const dx = 7 / 97, dy = 7 / 113
  const headingDegrees = Math.atan2(dy, dx) * 180 / Math.PI
  const position = { ...evidence, xMetres: 0, yMetres: 0, headingDegrees, uncertaintyMetres: null }
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'forward', metres: Math.hypot(dx, dy), tolerance: .001 })
  const result = evaluateLocomotionGoal(goal, { position }, { position }, Date.now(), 'crab')
  assert.equal(result.forward, 100)
  assert.ok(Math.abs(result.lateral!) <= 100)
})

test('MoGe depthSpatial corridor range permits open 0.45m step and halts forward walk before wall with openTurnDirection', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'forward', metres: 0.45, tolerance: 0.08 })
  const makeGrid = (center: number, left: number, right: number) => {
    const values = new Array(64).fill(0.8)
    for (const r of [2, 3, 4]) {
      for (const c of [0, 1, 2]) values[r * 8 + c] = left
      for (const c of [2, 3, 4, 5]) values[r * 8 + c] = center
      for (const c of [5, 6, 7]) values[r * 8 + c] = right
    }
    return { schema: 'ainekio-depth-grid-v1', available: true, rows: 8, columns: 8, values, valid: new Array(64).fill(true) }
  }
  const openPos = { ...start.position!, depthSpatial: makeGrid(0.85, 0.72, 1.25) } as any
  const openEval = evaluateLocomotionGoal(goal, { position: openPos }, start)
  assert.equal(openEval.reached, false)
  assert.equal(openEval.reason, undefined)
  assert.equal(openEval.forward, 100)
  assert.equal((openEval.progress.clearance as any).openTurnDirection, 'right')

  const blockedPos = { ...start.position!, depthSpatial: makeGrid(0.22, 1.15, 0.34) } as any
  const blockedSummary = summarizeDepthSpatialClearance(blockedPos)!
  assert.equal(blockedSummary.openTurnDirection, 'left')
  const blockedEval = evaluateLocomotionGoal(goal, { position: blockedPos }, start)
  assert.equal(blockedEval.reached, false)
  assert.equal(blockedEval.forward, 0)
  assert.match(blockedEval.reason!, /Forward path blocked at 0\.22m.*suggestedTurn=left/)
})

test('trackLocomotionProgress ignores duplicate frames, resets on metric progress, and flags stalled progress after 4 fresh samples over 5.5s', () => {
  const goal = normalizeLocomotionGoal({ kind: 'distance', direction: 'forward', metres: 0.45, tolerance: 0.08 })
  const baseMs = Date.parse('2026-11-12T19:00:00.000Z')
  const stepSample = (frameCounter: number, offsetMs: number, yMetres: number, stalledJoints = 0) => {
    const measurement: EnvironmentLocomotionMeasurement = {
      position: { ...start.position!, yMetres, frameCounter, frameId: `frame-${frameCounter}`, observedAt: new Date(baseMs + offsetMs).toISOString() } as any,
      yaw: { ...evidence, source: 'body-imu', degrees: 0, uncertaintyDegrees: null, imu: { joint_feedback: { stalled_joints: stalledJoints } } } as any,
    }
    const evalRes = evaluateLocomotionGoal(goal, measurement, start, baseMs + offsetMs)
    return { measurement, evalRes, nowMs: baseMs + offsetMs }
  }

  const s0 = stepSample(1, 0, 3.0)
  let tracked = trackLocomotionProgress(goal, s0.evalRes.progress, s0.measurement, undefined, s0.nowMs)
  assert.equal(tracked.stalledReason, undefined)

  // Duplicate read of frame-1 does not increment stalledSamples
  tracked = trackLocomotionProgress(goal, s0.evalRes.progress, s0.measurement, tracked.tracker, s0.nowMs + 500)
  assert.equal(tracked.tracker?.stalledSamples, 0)

  // Genuine progress (+6 cm) resets tracker
  const s1 = stepSample(2, 1000, 3.06)
  tracked = trackLocomotionProgress(goal, s1.evalRes.progress, s1.measurement, tracked.tracker, s1.nowMs)
  assert.equal(tracked.tracker?.stalledSamples, 0)

  // Stays open through the 3.2s autonomous-unsnag window (< 5.5s), then flags stalled progress once >= 5.5s
  for (const [fc, dt] of [[3, 2400], [4, 3800], [5, 5200]] as const) {
    const stuck = stepSample(fc, dt, 3.065, 4)
    tracked = trackLocomotionProgress(goal, stuck.evalRes.progress, stuck.measurement, tracked.tracker, stuck.nowMs)
    assert.equal(tracked.stalledReason, undefined)
  }
  const finalStuck = stepSample(6, 6600, 3.065, 4)
  tracked = trackLocomotionProgress(goal, finalStuck.evalRes.progress, finalStuck.measurement, tracked.tracker, finalStuck.nowMs)
  assert.match(tracked.stalledReason!, /Locomotion progress stalled \(4 consecutive measurements.*stalledJointsMask=4/)
})
