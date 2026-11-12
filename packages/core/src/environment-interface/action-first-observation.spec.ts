import assert from 'node:assert/strict'
import test from 'node:test'

import { getQueueManager } from '../queue/index.js'
import { environmentObservationNeedsCognition } from '../api/handlers/environment-bridge.js'
import {
  enqueueEnvironmentAction,
  recordEnvironmentActionResult,
  sanitizeEnvironmentBridgeObservation,
} from './store.js'

test('image acquisition has a longer dispatch window without weakening control expiry', () => {
  const manager = getQueueManager()
  const originalState = manager.exportState()
  try {
    manager.clear()
    const queuedAt = new Date().toISOString()
    const imageRequest = enqueueEnvironmentAction({
      type: 'captureImage',
      sessionId: 'robot-1',
      createdAt: queuedAt,
    })
    const imageDeadline = Date.parse(manager.getTask(imageRequest.id)?.deadline ?? '')
    assert.equal(imageDeadline - Date.parse(queuedAt), 10_000)

    manager.clear()
    const controlQueuedAt = new Date().toISOString()
    const controlRequest = enqueueEnvironmentAction({
      type: 'requestMotion',
      description: 'model-authored-motion',
      sessionId: 'robot-1',
      createdAt: controlQueuedAt,
    })
    const controlDeadline = Date.parse(manager.getTask(controlRequest.id)?.deadline ?? '')
    assert.equal(controlDeadline - Date.parse(controlQueuedAt), 2_000)
  } finally {
    manager.importState(originalState)
  }
})

test('completed robot actions do not synthesize a workflow-specific recapture', () => {
  const manager = getQueueManager()
  const originalState = manager.exportState()
  try {
    manager.clear()
    const action = enqueueEnvironmentAction({
      type: 'requestMotion',
      description: 'model-authored-motion',
      sessionId: 'robot-1',
      metadata: {
        robotObserver: {
          cycleId: 'observer-cycle',
          step: 2,
          triggerSource: 'autonomy',
          graph: 'environment',
          requestedBy: 'environment-perception',
        },
      },
    }, { username: 'owner', source: 'autonomy' })
    manager.claim(action.id, 'environment-adapter:robot-1')

    const completed = recordEnvironmentActionResult({
      id: 'observer-action-complete',
      timestamp: new Date().toISOString(),
      type: 'completed',
      message: 'done',
      actionId: action.id,
    })
    assert.equal('postActionObservation' in (completed ?? {}), false)
    assert.equal(manager.getAllTasks().some(task => task.input.type === 'captureImage'), false)
  } finally {
    manager.importState(originalState)
  }
})

test('a failed Boredom Movement stimulus capture returns to its autonomy graph for revision', () => {
  const manager = getQueueManager()
  const originalState = manager.exportState()
  try {
    manager.clear()
    const capture = enqueueEnvironmentAction({
      type: 'captureImage',
      sessionId: 'robot-1',
      metadata: {
        robotObserver: {
          cycleId: 'boredom-failed-capture',
          step: 1,
          triggerSource: 'autonomy',
          requestedBy: 'boredom-movement',
          graph: 'environment',
          instruction: 'Choose a contextually relevant boredom response.',
        },
      },
    }, {
      username: 'owner',
      source: 'autonomy',
      correlationId: 'boredom-failed-capture',
    })
    const observation = sanitizeEnvironmentBridgeObservation({
      environmentId: 'ainekio',
      adapter: 'ainekio-gateway',
      sessionId: 'robot-1',
      timestamp: new Date().toISOString(),
      capabilities: { actions: ['captureImage'], visual: true },
      feedback: [{
        id: 'capture-expired',
        timestamp: new Date().toISOString(),
        type: 'expired',
        message: 'capture expired',
        actionId: capture.id,
      }],
    })
    assert.equal(environmentObservationNeedsCognition(observation), true)
  } finally {
    manager.importState(originalState)
  }
})
