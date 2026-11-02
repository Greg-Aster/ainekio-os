import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENVIRONMENT_REQUEST_INTENT_JSON_SCHEMA,
  parseEnvironmentIntentRouting,
  resolveOrchestratorActionRequirement,
} from './orchestrator-llm.node.js';

test('Environment intent selects context and routes without owning the later objective decision', () => {
  const routing = parseEnvironmentIntentRouting(JSON.stringify({
    needsResponse: true, needsAction: true, needsGoalReview: false, needsToolUse: false,
    taskPlanner: 'vision',
    taskContext: ['environment', 'vision'],
    conversationContext: ['conversationHistory', 'robotStatus'],
  }));
  assert.equal(routing.needsAction, true);
  assert.equal(routing.taskPlanner, 'vision');
  assert.deepEqual(ENVIRONMENT_REQUEST_INTENT_JSON_SCHEMA.required, Object.keys(routing));
  assert.equal('needsTaskLifecycle' in ENVIRONMENT_REQUEST_INTENT_JSON_SCHEMA.properties, false);
});

test('delegated tool use is independent of movement and legacy routes remain readable', () => {
  const legacy = { needsResponse: true, needsAction: false, needsGoalReview: false, taskContext: [], conversationContext: [] };
  assert.deepEqual(parseEnvironmentIntentRouting(JSON.stringify(legacy)), legacy);
  const routing = { ...legacy, needsToolUse: true };
  assert.deepEqual(parseEnvironmentIntentRouting(JSON.stringify(routing)), routing);
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify({ ...routing, needsToolUse: 'true' })), /boolean needsToolUse/);
});

test('Environment complexity never changes the advisory action hint', () => {
  assert.equal(resolveOrchestratorActionRequirement({
    declaredNeedsAction: false,
    actionType: 'none',
    complexity: 1,
    cognitiveMode: 'environment',
  }), false);
});

test('non-Environment orchestrators retain complexity escalation', () => {
  assert.equal(resolveOrchestratorActionRequirement({
    declaredNeedsAction: false,
    actionType: 'none',
    complexity: 0.9,
    cognitiveMode: 'dual',
  }), true);
});

test('explicit Environment action decisions remain available as advisory hints', () => {
  assert.equal(resolveOrchestratorActionRequirement({
    declaredNeedsAction: true,
    actionType: 'robot_movement',
    complexity: 0.2,
    cognitiveMode: 'environment',
  }), true);
});

test('Environment routing preserves model-selected recall query and record types', () => {
  const input = { needsResponse: true, needsAction: false, needsGoalReview: false, taskContext: [],
    conversationContext: ['persona.personality', 'memory', 'conversationHistory'],
    memoryQuery: 'Most recent recorded dream, with its date', memoryTypes: ['dream'] };
  assert.deepEqual(parseEnvironmentIntentRouting(JSON.stringify(input)), input);
  const { taskContext: _task, ...missing } = input;
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify(missing)), /valid context entries in taskContext/);
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify({ ...input, taskContext: ['unknown'] })), /valid context entries/);
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify({ ...input, memoryTypes: [123] })), /Invalid memory types/);
});


test('Intent requires its explicit boolean Goal Review selection', () => {
  const base = { needsResponse: true, needsAction: false, needsToolUse: false,
    taskPlanner: 'specialist', taskContext: [], conversationContext: [] }
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify(base)), /boolean needsGoalReview/)
  for (const needsGoalReview of [true, false]) {
    assert.equal(parseEnvironmentIntentRouting(JSON.stringify({ ...base, needsGoalReview })).needsGoalReview, needsGoalReview)
  }
  assert.throws(() => parseEnvironmentIntentRouting(JSON.stringify({ ...base, needsGoalReview: 'false' })), /boolean needsGoalReview/)
})

test('autonomy context selection preserves independent source choices and memory scope', async () => {
  const { parseAutonomyContext } = await import('./orchestrator-llm.node.js');
  const route = { needsResponse: false, needsAction: false, needsGoalReview: false, needsToolUse: false, taskPlanner: 'specialist', conversationContext: [] };
  const selected = parseAutonomyContext(JSON.stringify({ ...route, taskContext: ['persona.values', 'innerDialogue', 'vision', 'memory'],
    memoryQuery: 'A previous shared activity', memoryTypes: ['conversation'], memoryOrder: 'relevance' }));
  assert.equal(selected.needsPersona, true);
  assert.equal(selected.needsInnerDialogue, true);
  assert.equal(selected.needsVision, true);
  assert.equal(selected.needsMemory, true);
  assert.equal(selected.needsConversationHistory, false);
  assert.equal(selected.needsActivityHistory, false);
  assert.deepEqual(selected.personaSections, ['values']);
  assert.equal(selected.memoryQuery, 'A previous shared activity');
  assert.throws(() => parseAutonomyContext(JSON.stringify({ ...route, taskContext: ['invented-source'] })), /Invalid autonomy/);
  assert.throws(() => parseAutonomyContext(JSON.stringify({ ...route, taskContext: ['memory'], memoryOrder: 'oldest' })), /Invalid memory order/);
});
