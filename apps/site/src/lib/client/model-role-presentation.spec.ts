import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_ROLES, MODEL_ROLE_OPTIONS } from '@metahuman/core/model-roles';
import { buildModelRoleSections, buildBaseModelChoices, modelChoiceForAssignment, adapterChoiceForAssignment, type ModelInventoryEntry, type WorkflowModelSummary } from './model-role-presentation.js';

const base: ModelInventoryEntry = { id: 'base', aliases: ['default.persona'], provider: 'llama-cpp',
  model: 'qwen-small', adapters: [], options: { endpoint: 'http://localhost:8081', contextWindow: 8192, lora: [] } };
const intent: ModelInventoryEntry = { ...base, id: 'intent', aliases: ['old-intent'],
  baseModel: 'training/Qwen-small', adapters: ['/intent.gguf'],
  options: { ...base.options, lora: [{ path: '/intent.gguf', scale: 1 }] } };
const task: ModelInventoryEntry = { ...intent, id: 'task', aliases: [], adapters: ['/task.gguf'],
  options: { ...base.options, lora: [{ path: '/task.gguf', scale: 1 }] } };

test('base selection contains one model while each adapter retains its exact assignment', () => {
  const choices = buildBaseModelChoices([intent, task, base, { ...base, id: 'base-alias' }]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].base.id, 'base');
  assert.equal(choices[0].label, 'Qwen-small');
  assert.deepEqual(choices[0].adapters.map(model => model.id), ['intent', 'task']);
  assert.equal(modelChoiceForAssignment(choices, 'old-intent'), choices[0]);
  assert.equal(adapterChoiceForAssignment(choices[0], 'old-intent')?.id, 'intent');
  assert.equal(adapterChoiceForAssignment(choices[0], 'task')?.id, 'task');
  assert.equal(adapterChoiceForAssignment(choices[0], 'default.persona'), undefined);
});

test('turning off an adapter-only deployment prepares a plain base without training metadata', () => {
  const snapshot = JSON.stringify(intent);
  const [choice] = buildBaseModelChoices([intent, task]);
  assert.equal(choice.registeredBase, false);
  assert.equal(choice.base.id, 'llama-cpp.qwen-small');
  assert.equal(choice.base.model, intent.model);
  assert.equal(choice.base.options?.endpoint, intent.options?.endpoint);
  assert.equal(choice.base.options?.contextWindow, intent.options?.contextWindow);
  assert.deepEqual(choice.base.adapters, []);
  assert.deepEqual(choice.base.options?.lora, []);
  assert.equal(choice.base.metadata, undefined);
  assert.equal(JSON.stringify(intent), snapshot);
});

test('distinct providers and endpoints remain distinct model deployments', () => {
  const choices = buildBaseModelChoices([base, intent,
    { ...base, id: 'other-server', options: { ...base.options, endpoint: 'http://localhost:8082' } },
    { ...base, id: 'ollama-model', provider: 'ollama', options: {} }]);
  assert.equal(choices.length, 3);
  assert.deepEqual(choices.map(choice => choice.adapters.length), [1, 0, 0]);
});

test('duplicate adapter aliases display once without losing the currently assigned alias', () => {
  const [choice] = buildBaseModelChoices([base, intent, { ...intent, id: 'intent-copy', aliases: ['old-copy'] }]);
  assert.equal(choice.adapters.length, 1);
  assert.equal(adapterChoiceForAssignment(choice, 'old-copy')?.id, 'intent');
});

test('the canonical base entry supplies options instead of an older role-specific alias', () => {
  const canonical = { ...base, id: 'llama-cpp.qwen-small', options: { ...base.options, contextWindow: 262144 } };
  const [choice] = buildBaseModelChoices([base, canonical, intent]);
  assert.equal(choice.base.id, canonical.id);
  assert.equal(choice.base.options?.contextWindow, 262144);
});

const workflows: WorkflowModelSummary[] = [
  { key: 'environment', name: 'Environment Mode', models: [
    { nodeId: 'intent', label: 'Intent Orchestrator', role: 'orchestrator', selection: 'role' },
    { nodeId: 'task', label: 'Task Decision', role: 'environmentActionSelector', selection: 'role' },
    { nodeId: 'plan', label: 'Delegated planning', role: 'persona', selection: 'role' },
    { nodeId: 'conversation', label: 'Conversation', role: 'persona', selection: 'role' },
  ] },
  { key: 'review', name: 'Goal Review', models: [
    { nodeId: 'review', label: 'Review', role: 'orchestrator', selection: 'role' },
    { nodeId: 'conversation', label: 'Conversation', role: 'persona', selection: 'role' },
  ] },
];

test('Environment uses the single canonical Orchestrator category', () => {
  const sections = buildModelRoleSections(workflows, 'environment');
  assert.deepEqual(sections[0].roles.map(item => item.role), [
    'orchestrator', 'environmentActionSelector', 'persona',
  ]);
  assert.equal(sections[0].roles[0].label, 'Orchestrator');
  assert.equal(sections[1].roles.some(item => item.role === 'orchestrator'), false);
});

test('repeated workflow consumers share one selector while all saved roles remain available', () => {
  const snapshot = JSON.stringify(workflows);
  const roles = buildModelRoleSections(workflows, 'environment').flatMap(section => section.roles);
  assert.deepEqual(roles.map(item => item.role).sort(), [...MODEL_ROLES].sort());
  const persona = roles.find(item => item.role === 'persona')!;
  assert.match(persona.description, /Environment Mode: Delegated planning/);
  assert.match(persona.description, /Environment Mode: Conversation/);
  assert.match(persona.description, /Goal Review: Conversation/);
  assert.equal(JSON.stringify(workflows), snapshot);
});

test('presentation follows changed graph roles and does not assume an Environment model', () => {
  const changed = structuredClone(workflows);
  changed[0].models[0].role = 'planner';
  const sections = buildModelRoleSections(changed, 'environment');
  assert.equal(sections[0].roles[0].role, 'planner');
  assert.equal(sections[0].roles.some(item => item.role === 'orchestrator'), false);
  assert.equal(buildModelRoleSections(workflows, 'review')[0].roles[0].role, 'orchestrator');
});

test('missing graphs and runtime-selected roles do not fabricate fixed workflow assignments', () => {
  assert.equal(buildModelRoleSections([], 'environment')[0].label, 'Other saved roles');
  const runtime = structuredClone(workflows);
  runtime[0].models[0].selection = 'runtime-role';
  assert.equal(buildModelRoleSections(runtime, 'environment')[0].roles.some(item => item.role === 'orchestrator'), false);
});

test('every category presents its exact shared definition and label', () => {
  const roles = buildModelRoleSections(workflows, 'environment').flatMap(section => section.roles);
  for (const definition of MODEL_ROLE_OPTIONS) {
    const presentation = roles.find(item => item.role === definition.value)!;
    assert.equal(presentation.label, definition.label);
    assert.equal(presentation.description.split('\n')[0], definition.description);
  }
  assert.equal(roles.some(item => String(item.role) === 'environmentIntent'), false);
});

test('Lightweight remains independently selectable and shows its configured body-event usage', () => {
  const withBodyEvents = [...workflows, {
    key: 'robot-body-response', name: 'Robot Body Response', models: [
      { nodeId: 'response', label: 'Body Response', role: 'lightweight', selection: 'role' },
    ],
  }];
  const sections = buildModelRoleSections(withBodyEvents, 'environment');
  const roles = sections.flatMap(section => section.roles);
  assert.equal(roles.filter(item => item.role === 'lightweight').length, 1);
  const lightweight = roles.find(item => item.role === 'lightweight')!;
  assert.equal(lightweight.label, 'Lightweight');
  assert.match(lightweight.description, /Robot Body Response: Body Response/);
  assert.equal(sections[1].roles.includes(lightweight), true);
  assert.deepEqual(buildModelRoleSections(withBodyEvents, 'robot-body-response')[0].roles
    .map(item => item.role), ['lightweight']);
  assert.equal(buildModelRoleSections([], 'environment').flatMap(section => section.roles)
    .some(item => item.role === 'lightweight'), true);
});

test('BB-Codex and BB-Gemini remain distinct choices in role model dropdowns', () => {
  const choices = buildBaseModelChoices([
    { id: 'big-brother.codex', provider: 'big-brother', model: 'gpt-6.1-sol', baseModel: 'BB-Codex', capabilities: ['text', 'image'] },
    { id: 'big-brother.gemini', provider: 'big-brother', model: 'gemini-3.8-flash-low', baseModel: 'BB-Gemini', capabilities: ['text'] },
  ]);
  assert.equal(choices.length, 2);
  assert.equal(choices[0].label, 'BB-Codex (gpt-6.1-sol)');
  assert.equal(choices[1].label, 'BB-Gemini (gemini-3.8-flash-low)');
  assert.equal(modelChoiceForAssignment(choices, 'big-brother.codex')?.base.id, 'big-brother.codex');
  assert.equal(modelChoiceForAssignment(choices, 'big-brother.gemini')?.base.id, 'big-brother.gemini');
});
