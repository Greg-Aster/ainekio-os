import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCatalogService } from './agent-catalog.js';
import { AGENT_CATALOG_DEFINITIONS } from './agent-catalog-definitions.js';
import { eventBus } from './infrastructure/event-bus/client.js';
import { TriggerConfigService } from './queue/trigger-config-service.js';
import { setAuditEnabled } from './audit.js';

setAuditEnabled(false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-agent-catalog-'));
process.once('exit', () => { fs.rmSync(root, { recursive: true, force: true }); eventBus.disconnect(); setAuditEnabled(true); });
const operatorChildren = ['boredom-observer', 'boredom-movement', 'boredom-reflection'];
const brainDir = path.join(root, 'brain');
const agentsDir = path.join(brainDir, 'agents');
const etcDir = path.join(root, 'etc');
fs.mkdirSync(path.join(agentsDir, 'organizer'), { recursive: true });
fs.mkdirSync(path.join(agentsDir, 'curiosity-researcher'), { recursive: true });
fs.mkdirSync(path.join(agentsDir, 'curiosity-service'), { recursive: true });
fs.mkdirSync(path.join(agentsDir, 'daydreamer'), { recursive: true });
fs.mkdirSync(path.join(brainDir, 'services'), { recursive: true });
fs.mkdirSync(etcDir, { recursive: true });
for (const file of [
  path.join(agentsDir, 'organizer', 'index.ts'),
  path.join(agentsDir, 'curiosity-researcher', 'index.ts'),
  path.join(agentsDir, 'curiosity-service', 'index.ts'),
  path.join(agentsDir, 'daydreamer', 'index.ts'),
  path.join(brainDir, 'services', 'maintenance-service.ts'),
]) fs.writeFileSync(file, 'export {};\n');

const triggerPath = path.join(etcDir, 'agents.json');
fs.writeFileSync(triggerPath, `${JSON.stringify({
  version: '1.0.0',
  revision: 4,
  globalSettings: { pauseAll: false, timezone: 'UTC' },
  agents: {
    organizer: {
      id: 'organizer',
      enabled: true,
      type: 'manual',
      lifecycle: 'scheduled-work',
      handler: 'agent.organizer',
      priority: 'normal',
      allowedModes: ['reactive', 'semi', 'full'],
      startupPolicy: 'skip',
    },
    mood: {
      id: 'mood', enabled: false, type: 'event', eventPattern: 'conversation.user-message.appended',
      lifecycle: 'scheduled-work', handler: 'agent.mood', priority: 'normal',
      allowedModes: ['semi', 'full'], startupPolicy: 'skip',
    },
    ...Object.fromEntries(operatorChildren.map(id => [id, {
      id, enabled: true, type: 'manual', lifecycle: 'workflow', runtimeOwner: 'robot-operator',
      handler: AGENT_CATALOG_DEFINITIONS[id].handler, priority: 'normal',
      allowedModes: ['reactive', 'semi', 'full'], startupPolicy: 'skip',
    }])),
  },
}, null, 2)}\n`);
const servicesPath = path.join(etcDir, 'services.json');
fs.writeFileSync(servicesPath, `${JSON.stringify({
  services: {
    'maintenance-service': {
      id: 'maintenance-service',
      enabled: true,
      agentPath: 'services/maintenance-service.ts',
      priority: 'normal',
    },
  },
}, null, 2)}\n`);

const triggerConfig = new TriggerConfigService(triggerPath);
let revisions = 0;
triggerConfig.subscribe(() => revisions += 1);
const catalog = new AgentCatalogService({ agentsDir, brainDir, servicesConfigPath: servicesPath, triggerConfigService: triggerConfig });
// Read maintained executable sources with isolated registration inputs, never the
// user's enabled/scheduled installation choices. Mutations below use dummy sources.
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const live = new AgentCatalogService({ agentsDir: path.join(sourceRoot, 'brain/agents'),
  brainDir: path.join(sourceRoot, 'brain'), servicesConfigPath: servicesPath, triggerConfigService: triggerConfig }).getSnapshot();
assert.equal(
  live.counts.total,
  Object.values(AGENT_CATALOG_DEFINITIONS).filter(definition => !definition.internalOwner).length,
  'every public maintained definition must appear exactly once',
);
assert.equal(live.counts.triggerRegistered, 2, 'only the two fixture Trigger Manager entries are counted');
assert.deepEqual(live.agents.filter(agent => agent.triggerRegistered).map(agent => agent.id), ['mood', 'organizer']);
assert.equal(live.counts.services, 1, 'only the fixture Maintenance service is registered');
assert.deepEqual(live.agents.filter(agent => agent.serviceRegistered).map(agent => agent.id), ['maintenance-service']);
assert.equal(live.counts.missingSource, 0, 'every maintained catalog item must have a resolvable implementation');
assert.deepEqual(
  live.agents.filter(agent => agent.canRegister).map(agent => agent.id),
  Object.values(AGENT_CATALOG_DEFINITIONS).filter(definition => !definition.internalOwner
    && definition.lifecycle !== 'service' && !['organizer', 'mood', ...operatorChildren].includes(definition.id))
    .map(definition => definition.id).sort(),
  'installed but unscheduled agents must remain visible and registerable',
);
assert.equal(live.agents.find(agent => agent.id === 'curiosity')?.sourceAgentId, 'curiosity-service', 'source aliases must not create duplicate catalog entries');
assert.equal(live.agents.some(agent => agent.id === 'curiosity-service'), false, 'aliased source id must not appear as a second agent');
assert.equal(live.agents.some(agent => agent.id === 'transcriber'), false, 'the retired duplicate Transcriber must not return to the agent catalog');
assert.deepEqual(live.agents.filter(agent => agent.id.startsWith('environment-bridge')).map(agent => agent.id), ['environment-bridge'], 'only the automatic bridge is offered');
assert.equal(live.agents.find(agent => agent.id === 'mood')?.enabled, false, 'Mood must remain opt-in even while registered');
assert.equal(AGENT_CATALOG_DEFINITIONS.mood.defaultTrigger?.enabled, false, 're-registering Mood must preserve its disabled default');
assert.equal(live.agents.some(agent => agent.id === 'desire-agent'), true, 'the sole Desire Agent must be public');
for (const internalId of ['desire-planner', 'desire-generator', 'desire-executor', 'desire-outcome-reviewer', 'desire-signal']) {
  assert.equal(live.agents.some(agent => agent.id === internalId), false, `${internalId} must not be independently runnable`);
}
for (const childId of operatorChildren) {
  const child = live.agents.find(agent => agent.id === childId);
  assert.equal(child?.owner, 'robot-operator', `${childId} must expose Robot Operator as its runtime owner`);
  assert.equal(child?.triggerRegistered, false, `${childId} must not claim Trigger Manager registration`);
  assert.equal(child?.canUnregister, false, `${childId} cannot be removed through Trigger Manager controls`);
  assert.equal(child?.canRun, true, `${childId} must remain manually runnable from Agent Monitor`);
}
for (const serviceId of ['environment-bridge', 'maintenance-service', 'robot-operator']) {
  assert.equal(
    AGENT_CATALOG_DEFINITIONS[serviceId]?.executionContext,
    'system',
    `${serviceId} must start without selecting a user profile`,
  );
}

const before = catalog.getSnapshot();
assert.equal(before.agents.find(agent => agent.id === 'curiosity-researcher')?.canRegister, true);
assert.equal(before.agents.find(agent => agent.id === 'curiosity')?.sourceReady, true, 'custom roots must honor source aliases');
assert.equal(before.agents.find(agent => agent.id === 'maintenance-service')?.serviceRegistered, true);

const registered = catalog.register('curiosity-researcher', 'catalog-spec');
assert.equal(registered.revision, 5);
assert.equal(registered.agents.find(agent => agent.id === 'curiosity-researcher')?.triggerRegistered, true);
const persisted = triggerConfig.load(false).config.agents['curiosity-researcher'];
assert.deepEqual(AGENT_CATALOG_DEFINITIONS['curiosity-researcher'].defaultTrigger, { type: 'manual' }, 'Catalog registration has been manual since the October autonomy consolidation');
assert.equal(persisted.type, AGENT_CATALOG_DEFINITIONS['curiosity-researcher'].defaultTrigger!.type);
assert.equal(persisted.interval, AGENT_CATALOG_DEFINITIONS['curiosity-researcher'].defaultTrigger!.interval);
assert.deepEqual(persisted.allowedModes, ['reactive', 'semi', 'full'], 'manual work remains available in every mode');

const unregistered = catalog.unregister('curiosity-researcher', 'catalog-spec');
assert.equal(unregistered.revision, 6);
assert.equal(unregistered.agents.find(agent => agent.id === 'curiosity-researcher')?.canRegister, true, 'unregistering must preserve installed source');
assert.equal(triggerConfig.load(false).config.agents['curiosity-researcher'], undefined);
const daydreamerRegistered = catalog.register('daydreamer', 'catalog-spec');
assert.equal(daydreamerRegistered.revision, 7);
const daydreamerTrigger = triggerConfig.load(false).config.agents.daydreamer;
const daydreamerDefault = AGENT_CATALOG_DEFINITIONS.daydreamer.defaultTrigger!;
assert.deepEqual(daydreamerDefault, { type: 'manual' }, 'Catalog registration must not restore the retired default idle schedule');
assert.equal(daydreamerTrigger.type, daydreamerDefault.type);
assert.equal(daydreamerTrigger.inactivityThreshold, daydreamerDefault.inactivityThreshold);
assert.equal(daydreamerTrigger.probability, daydreamerDefault.probability);
assert.equal(daydreamerTrigger.jitterMs, daydreamerDefault.jitterMs);
assert.deepEqual(daydreamerTrigger.allowedModes, ['reactive', 'semi', 'full'], 'manual registration must not reinstate the retired idle trigger');
assert.equal(daydreamerTrigger.maxRetries, daydreamerDefault.maxRetries ?? 1);
const daydreamerUnregistered = catalog.unregister('daydreamer', 'catalog-spec');
assert.equal(daydreamerUnregistered.revision, 8);
assert.equal(triggerConfig.load(false).config.agents.daydreamer, undefined);
assert.equal(revisions, 4, 'register and unregister must each live-notify configuration subscribers');
assert.throws(() => catalog.register('maintenance-service', 'catalog-spec'), /persistent service/);
assert.throws(() => catalog.register('../escape', 'catalog-spec'), /lowercase kebab-case/);

console.log('agent-catalog.spec.ts passed');
