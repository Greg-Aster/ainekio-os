import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const root = mkdtempSync(path.join(os.tmpdir(), 'portal-status-'));
after(() => rmSync(root, { recursive: true, force: true }));
let llamaRunning = true;
let provider = 'llama-cpp';
const model = () => ({ id: 'fixture', provider, model: 'fixture-model', options: { temperature: 0.6 } });
const registry = () => ({ version: 'fixture', models: { fixture: model() }, defaults: { persona: 'fixture' } });
mock.module('../../identity.js', { namedExports: {
  loadPersonaCore: () => ({ identity: { name: 'Fixture' } }), loadDecisionRules: () => ({ trustLevel: 'observe' }),
} });
mock.module('../../memory.js', { namedExports: { listActiveTasks: () => [] } });
mock.module('../../adapters.js', { namedExports: { getActiveAdapter: () => null } });
mock.module('../../model-resolver.js', { namedExports: { loadModelRegistry: registry, resolveModelForCognitiveMode: model } });
mock.module('../../cognitive-mode.js', { namedExports: { loadCognitiveMode: () => ({ currentMode: 'dual' }) } });
mock.module('../../vector-index.js', { namedExports: { getIndexStatus: async () => ({ exists: false }) } });
mock.module('../../agent-monitor.js', { namedExports: { listAvailableAgents: () => [] } });
mock.module('../../llm-backend.js', { namedExports: {
  getBackendStatus: async () => ({ resolvedBackend: 'llama-cpp', health: llamaRunning ? 'healthy' : 'offline' }),
  detectAvailableBackends: async () => ({
    llamaCpp: { configured: true, running: llamaRunning, model: 'fixture-model' },
    ollama: { installed: true, running: true },
  }),
} });
mock.module('../../runtime-mode.js', { namedExports: { getRuntimeMode: () => ({ headless: false }) } });
mock.module('../../index.js', { namedExports: { systemPaths: { root, logs: root }, getProfilePaths: () => ({ episodic: root, etc: root }) } });
mock.module('../../config.js', { namedExports: { loadCuriosityConfig: () => ({}), loadOperatorConfig: () => ({}) } });
mock.module('../../memory-metrics-cache.js', { namedExports: { getMemoryMetrics: async () => ({ totalMemories: 0, memoriesByType: {} }) } });
mock.module('./remote-server.js', { namedExports: { fetchRemoteModels: async () => { throw new Error('No remote configured'); } } });
mock.module('../../runpod-config.js', { namedExports: { hasRunpodCredentials: () => false } });
const { handleGetStatus } = await import('./status.js');

async function status() {
  const response = await handleGetStatus({ method: 'GET', path: '/api/status',
    user: { username: 'fixture', userId: 'fixture', role: 'owner', isAuthenticated: true } });
  assert.equal(response.status, 200);
  return response.data as {
    modelRoles: Record<string, { model: string | null; needsConfig?: boolean; unavailableReason?: string }>;
    systemHealth: { backendAvailability: { llamaCpp: { running: boolean } } };
  };
}

test('status agrees with backend health for running, offline and recovered llama.cpp roles', async () => {
  provider = 'llama-cpp';
  for (const running of [true, false, true]) {
    llamaRunning = running;
    const result = await status();
    assert.equal(result.systemHealth.backendAvailability.llamaCpp.running, running);
    assert.equal(result.modelRoles.persona.model, running ? 'fixture-model' : null);
    assert.equal(result.modelRoles.persona.needsConfig, running ? undefined : true);
  }
});

test('status retains existing Ollama and remote model reporting', async () => {
  for (provider of ['ollama', 'openai']) {
    assert.equal((await status()).modelRoles.persona.model, 'fixture-model');
  }
});
