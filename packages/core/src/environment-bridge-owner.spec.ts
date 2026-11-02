import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-bridge-switch-'));
process.env.METAHUMAN_ROOT = fixture;
fs.mkdirSync(path.join(fixture, 'etc'), { recursive: true });
fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
const ids = ['environment-bridge'];
fs.writeFileSync(path.join(fixture, 'etc/agents.json'), JSON.stringify({ agents: {} }));
fs.writeFileSync(path.join(fixture, 'etc/services.json'), JSON.stringify({ services: Object.fromEntries(ids.map(id => [id, {
  id, enabled: true, type: 'manual', startOnSystemBoot: true, agentPath: 'environment-bridge/index.ts',
}])) }));
for (const id of ids) {
  const directory = path.join(fixture, 'brain/agents/environment-bridge');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.ts'), `
import { acquireLock } from ${JSON.stringify(path.join(sourceRoot, 'packages/core/src/locks.ts'))};
const lock = acquireLock('agent-environment-bridge', { exitOnSignal: false });
const timer = setInterval(() => {}, 1000);
process.once('SIGTERM', () => { clearInterval(timer); lock.release(); });
`);
}
const { startAgentProcess } = await import('./agent-process-runner.js');
const { getRunningAgents, stopAgent } = await import('./agent-monitor-registry.js');
const { setAuditEnabled } = await import('./audit.js');
const { eventBus } = await import('./infrastructure/event-bus/client.js');
setAuditEnabled(false);

test('connection settings use the existing service owner and retain both remote routes', async () => {
  const { setAgentVariable } = await import('./agent-monitor.js');
  setAgentVariable(ids[0], 'cloudflareHostname', 'bridge.example.invalid');
  setAgentVariable(ids[0], 'sshTarget', 'operator@workshop-host');
  setAgentVariable(ids[0], 'sshGatewayPort', 9876);
  setAgentVariable(ids[0], 'transport', 'ssh');
  setAgentVariable(ids[0], 'adapterUrl', 'ws://127.0.0.1:8790/environment');
  setAgentVariable(ids[0], 'remoteAdapterUrl', 'ws://127.0.0.1:18790/environment');
  setAgentVariable(ids[0], 'robotId', 'robot-two');
  setAgentVariable(ids[0], 'followRobot', true);
  let config = JSON.parse(fs.readFileSync(path.join(fixture, 'etc/services.json'), 'utf8'));
  assert.equal(config.services[ids[0]].remoteAdapterUrl, 'ws://127.0.0.1:18790/environment');
  assert.equal(config.services[ids[0]].robotId, 'robot-two');
  assert.equal(config.services[ids[0]].followRobot, true);
  assert.equal(config.services[ids[0]].transport, 'ssh');
  assert.equal(config.services[ids[0]].sshTarget, 'operator@workshop-host');
  assert.equal(config.services[ids[0]].sshGatewayPort, 9876);
  assert.equal(config.services[ids[0]].cloudflareHostname, 'bridge.example.invalid');
  setAgentVariable(ids[0], 'transport', 'cloudflare');
  config = JSON.parse(fs.readFileSync(path.join(fixture, 'etc/services.json'), 'utf8'));
  assert.equal(config.services[ids[0]].sshTarget, 'operator@workshop-host');
  assert.equal(config.services[ids[0]].transport, 'cloudflare');
  setAgentVariable(ids[0], 'transport', 'local');
  config = JSON.parse(fs.readFileSync(path.join(fixture, 'etc/services.json'), 'utf8'));
  assert.equal(config.services[ids[0]].transport, 'local');
  assert.equal(config.services[ids[0]].sshTarget, 'operator@workshop-host');
  assert.equal(config.services[ids[0]].remoteAdapterUrl, 'ws://127.0.0.1:18790/environment');
  assert.equal(getRunningAgents().length, 0, 'saving alone must not start a connection');
});

test('one catalogued connection owner starts once and preserves configured endpoints', async () => {
  const result = await startAgentProcess(ids[0], { source: 'connection-fixture', useBootstrap: false,
    waitForMs: 3000, checkLock: true });
  assert.equal(result.success, true, result.error);
  const again = await startAgentProcess(ids[0], { source: 'connection-fixture', checkLock: true });
  assert.equal(again.alreadyRunning, true);
  assert.equal(getRunningAgents().filter(agent => ids.includes(agent.name)).length, 1);
  const config = JSON.parse(fs.readFileSync(path.join(fixture, 'etc/services.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.services), ids);
});

test.after(async () => {
  for (const agent of getRunningAgents()) {
    const stopped = await stopAgent(agent.name);
    assert.equal(stopped.success, true, stopped.message);
  }
  eventBus.disconnect();
  fs.rmSync(fixture, { recursive: true, force: true });
});
