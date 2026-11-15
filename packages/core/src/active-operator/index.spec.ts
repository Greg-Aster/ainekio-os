import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import type { AutonomyMode } from '../queue/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-active-operator-mode-'));
process.env.METAHUMAN_ROOT = root;
fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true });
fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'full' }));

const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { setAuditEnabled } = await import('../audit.js');
setAuditEnabled(false);

const realQueue = await import('../queue/index.js');
const appliedModes: AutonomyMode[] = [];
const queueMock = mock.module('../queue/index.js', {
  namedExports: {
    ...realQueue,
    ensureQueueSystemStarted: async () => ({
      setAutonomyMode(next: AutonomyMode) {
        appliedModes.push(next);
      },
    }),
  },
});

const { isRobotAutonomyWorkItem } = await import('../robot-operator.js');
const { buildDesireAgentTaskInput } = await import('../queue/work-submission.js');
const { ModeController, loadActiveOperatorConfig } = await import('./index.js');

after(() => {
  eventBus.disconnect();
  queueMock.restore();
  realQueue.resetQueueManager();
  fs.rmSync(root, { recursive: true, force: true });
});

test('reactive transition cancels Robot Operator assessments and controller-dispatched background tasks while preserving independent classification and user work', async () => {
  const manager = realQueue.getQueueManager();
  const controller = new ModeController();
  assert.equal(controller.mode, 'full');

  const controllerAssessment = manager.enqueue({
    type: 'generic',
    handler: 'workflow.robot-autonomy-controller',
    resource: 'remote-llm',
    source: 'autonomy',
    priority: 'low',
    username: 'fixture',
    input: { agentId: 'robot-autonomy-controller' },
    metadata: { producer: 'robot-operator' },
  });

  const leasedCodeReview = manager.enqueue({
    type: 'generic',
    handler: 'agent.system-code-review',
    resource: 'local-llm',
    source: 'autonomy',
    priority: 'low',
    username: 'fixture',
    input: {
      agentId: 'system-code-review',
      triggeredBy: 'robot-autonomy-controller',
      triggerSource: 'autonomy',
    },
    metadata: {
      producer: 'robot-autonomy-controller',
      controllerExecutionId: 'exec-1',
    },
  });
  assert.ok(manager.claim(leasedCodeReview.id, 'test-engine'));

  const queuedTrainOfThought = manager.enqueue({
    type: 'generic',
    handler: 'agent.train-of-thought',
    resource: 'local-llm',
    source: 'autonomy',
    priority: 'low',
    username: 'fixture',
    input: {
      agentId: 'train-of-thought',
      triggeredBy: 'robot-autonomy-controller',
      triggerSource: 'autonomy',
    },
  });

  const controllerDesire = manager.enqueue({
    ...buildDesireAgentTaskInput({
      operation: 'execute',
      desireId: 'desire-abc',
      username: 'fixture',
      source: 'autonomy',
      correlationId: 'exec-1:0',
      idempotencyKey: 'active-operator:exec-1:0',
      metadata: {
        producer: 'robot-autonomy-controller',
        selectedAgent: 'desire-agent',
        controllerExecutionId: 'exec-1',
      },
    }),
    executionScope: 'independent',
    cognitiveMode: 'environment',
  });

  const userTask = manager.enqueue({
    type: 'generic',
    handler: 'agent.system-code-review',
    resource: 'remote-llm',
    source: 'user',
    priority: 'high',
    username: 'fixture',
    input: { agentId: 'system-code-review' },
    metadata: { producer: 'robot-autonomy-controller' },
  });

  const unrelatedScheduledAutonomy = manager.enqueue({
    type: 'reflect',
    handler: 'agent.reflector',
    resource: 'local-llm',
    source: 'autonomy',
    priority: 'low',
    username: 'fixture',
    input: { agentId: 'reflector', triggeredBy: 'trigger-manager' },
    metadata: { producer: 'trigger-manager' },
  });

  // Independent operations spawned by robot-autonomy-controller remain false under isRobotAutonomyWorkItem
  assert.equal(isRobotAutonomyWorkItem(controllerAssessment), true);
  assert.equal(isRobotAutonomyWorkItem(leasedCodeReview), false);
  assert.equal(isRobotAutonomyWorkItem(queuedTrainOfThought), false);
  assert.equal(isRobotAutonomyWorkItem(controllerDesire), false);

  await controller.setMode('reactive', 'fixture');

  assert.equal(controller.mode, 'reactive');
  assert.deepEqual(appliedModes, ['reactive']);
  assert.equal(loadActiveOperatorConfig().autonomyMode, 'reactive');

  assert.equal(manager.getTask(controllerAssessment.id)?.state, 'cancelled');
  assert.equal(
    manager.getTask(controllerAssessment.id)?.cancellationReason,
    'Robot Operator disabled by Active Operator reactive mode',
  );

  const cancelledLeased = manager.getTask(leasedCodeReview.id);
  assert.ok(cancelledLeased?.cancellationRequestedAt, 'Leased controller-spawned task must receive immediate cancellation request');
  assert.equal(cancelledLeased?.cancellationReason, 'Robot Operator disabled by Active Operator reactive mode');

  assert.equal(manager.getTask(queuedTrainOfThought.id)?.state, 'cancelled');
  assert.equal(
    manager.getTask(queuedTrainOfThought.id)?.cancellationReason,
    'Robot Operator disabled by Active Operator reactive mode',
  );

  assert.equal(manager.getTask(controllerDesire.id)?.state, 'cancelled');
  assert.equal(
    manager.getTask(controllerDesire.id)?.cancellationReason,
    'Robot Operator disabled by Active Operator reactive mode',
  );

  assert.equal(manager.getTask(userTask.id)?.state, 'queued');
  assert.equal(manager.getTask(unrelatedScheduledAutonomy.id)?.state, 'queued');
});
