import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test, mock } from 'node:test';
import type { UnifiedRequest } from '../types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-active-operator-handler-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => { throw new Error('Network access is forbidden in this fixture'); };

fs.mkdirSync(path.join(root, 'etc/cognitive-graphs'), { recursive: true });
fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true });
fs.mkdirSync(path.join(root, 'brain/agents/system-code-review'), { recursive: true });
fs.writeFileSync(path.join(root, 'brain/agents/system-code-review/cli.ts'), 'export {};\n');
fs.copyFileSync(
  new URL('../../../../../etc/queue.json', import.meta.url),
  path.join(root, 'etc/queue.json'),
);
const defaultAgentsConfig = JSON.parse(
  fs.readFileSync(new URL('../../../../../etc/agents.json', import.meta.url), 'utf8'),
);
assert.equal(defaultAgentsConfig.agents['system-code-review']?.enabled, false);
const optedInAgentsConfig = structuredClone(defaultAgentsConfig);
optedInAgentsConfig.agents['system-code-review'].enabled = true;
fs.writeFileSync(
  path.join(root, 'etc/agents.json'),
  JSON.stringify(optedInAgentsConfig, null, 2),
);
const defaultReviewGraph = JSON.parse(
  fs.readFileSync(new URL('../../../../../etc/cognitive-graphs/system-code-review-mode.json', import.meta.url), 'utf8'),
);
assert.equal(defaultReviewGraph.nodes.some((node: any) => node.data?.nodeType === 'tts'), false);
const defaultControllerGraph = fs.readFileSync(
  new URL('../../../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url),
  'utf8',
);
const parsedControllerGraph = JSON.parse(defaultControllerGraph);
const defaultCatalogTaskIds: string[] = parsedControllerGraph.nodes.find((node: any) => node.id === 'task-catalog')?.data?.properties?.taskIds ?? [];
assert.equal(defaultCatalogTaskIds.includes('system-code-review'), false);
assert.equal(defaultCatalogTaskIds.includes('sleep-workflow'), false);
fs.writeFileSync(
  path.join(root, 'etc/cognitive-graphs/robot-autonomy-controller-mode.json'),
  defaultControllerGraph,
);

const { ROOT, registerProfileStorageConfigGetter } = await import('../../path-builder.js');
assert.equal(ROOT, root);
registerProfileStorageConfigGetter(username => ({ path: path.join(root, 'profiles', username), type: 'internal' }));
const { eventBus } = await import('../../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { setAuditEnabled } = await import('../../audit.js');
setAuditEnabled(false);
const { claimWorkCoordinatorOwnership } = await import('../../queue/work-submission.js');
claimWorkCoordinatorOwnership();

const registry = await import('../../agent-monitor-registry.js');
const runner = await import('../../agent-process-runner.js');

let running = false;
const startCalls: Array<{ agent: string; options: unknown }> = [];
let startResult: Awaited<ReturnType<typeof runner.startAgentProcess>> = {
  agent: 'robot-operator',
  started: true,
  success: true,
  pid: 424242,
};

const registryMock = mock.module('../../agent-monitor-registry.js', {
  namedExports: {
    ...registry,
    isAgentRunning: (name: string) => name === 'robot-operator' && running,
  },
});

const runnerMock = mock.module('../../agent-process-runner.js', {
  namedExports: {
    ...runner,
    startAgentProcess: async (agent: string, options: unknown) => {
      startCalls.push({ agent, options });
      return startResult;
    },
  },
});

const {
  handleActiveOperatorControl,
  handleGetActiveOperatorStatus,
  handleUpdateActiveOperatorConfig,
  readActiveOperatorStatus,
} = await import('./active-operator.js');
const { getQueueSystem } = await import('../../queue/queue-system.js');
const { loadActiveOperatorConfig } = await import('../../active-operator/index.js');
const { robotAutonomyTaskCatalogNode } = await import('../../nodes/robot-operator/task-catalog.node.js');
const { collectSystemReviewIssues } = await import('../../help-tickets/code-review.js');
const { getPendingTechnicalTickets, updateTicket } = await import('../../help-tickets/index.js');
const { openExecutionStore } = await import('../../durable-execution/storage.js');
const { ExecutionStore } = await import('../../durable-execution/store.js');
const { ExecutionCheckpointer } = await import('../../durable-execution/checkpointer.js');

function writeServicesConfig(enabled: boolean) {
  fs.writeFileSync(
    path.join(root, 'etc/services.json'),
    JSON.stringify({ services: { 'robot-operator': { id: 'robot-operator', enabled } } }, null, 2),
  );
}

function ownerRequest(body: Record<string, unknown>): UnifiedRequest {
  return {
    path: '/api/active-operator/control',
    method: 'POST',
    body,
    user: { userId: 'fixture-owner', username: 'fixture-owner', role: 'owner', isAuthenticated: true },
  };
}

beforeEach(() => {
  running = false;
  startCalls.length = 0;
  startResult = { agent: 'robot-operator', started: true, success: true, pid: 424242 };
  writeServicesConfig(true);
});

after(async () => {
  await getQueueSystem().dispose();
  registryMock.restore();
  runnerMock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

test('set-mode and start launch robot-operator when enabled in services.json and not running', async () => {
  const fullRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'full' }));
  assert.equal(fullRes.status, 200);
  assert.equal(loadActiveOperatorConfig().autonomyMode, 'full');
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].agent, 'robot-operator');
  assert.deepEqual(startCalls[0].options, {
    actor: 'fixture-owner',
    source: 'api/active-operator/control',
    useBootstrap: true,
    detached: true,
    waitForMs: 5000,
    checkLock: true,
  });

  startCalls.length = 0;
  const semiRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'semi' }));
  assert.equal(semiRes.status, 200);
  assert.equal(loadActiveOperatorConfig().autonomyMode, 'semi');
  assert.equal(startCalls.length, 1);

  startCalls.length = 0;
  const startRes = await handleActiveOperatorControl(ownerRequest({ action: 'start' }));
  assert.equal(startRes.status, 200);
  assert.equal(loadActiveOperatorConfig().autonomyMode, 'full');
  assert.equal(startCalls.length, 1);
});

test('does not start robot-operator when already running, disabled in services.json, or switching to reactive', async () => {
  running = true;
  const alreadyRunningRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'full' }));
  assert.equal(alreadyRunningRes.status, 200);
  assert.equal(startCalls.length, 0);

  running = false;
  writeServicesConfig(false);
  const disabledRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'full' }));
  assert.equal(disabledRes.status, 200);
  assert.equal(startCalls.length, 0);

  writeServicesConfig(true);
  for (const body of [
    { action: 'set-mode', mode: 'reactive' },
    { action: 'stop' },
    { action: 'reset' },
  ]) {
    const res = await handleActiveOperatorControl(ownerRequest(body));
    assert.equal(res.status, 200);
  }
  assert.equal(startCalls.length, 0);
});

test('treats lock-repaired alreadyRunning start result as success and surfaces genuine start failures', async () => {
  startResult = {
    agent: 'robot-operator',
    started: false,
    success: false,
    alreadyRunning: true,
    pid: 51515,
    error: 'Agent is already running',
  };
  const lockRepairedRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'full' }));
  assert.equal(lockRepairedRes.status, 200);
  assert.equal(startCalls.length, 1);

  startResult = {
    agent: 'robot-operator',
    started: false,
    success: false,
    error: 'Agent bootstrap not found',
  };
  const failedRes = await handleActiveOperatorControl(ownerRequest({ action: 'set-mode', mode: 'full' }));
  assert.equal(failedRes.status, 500);
  assert.equal(failedRes.error, 'Agent bootstrap not found');
});

test('POST /api/active-operator/config also starts robot-operator when activating semi or full', async () => {
  const res = await handleUpdateActiveOperatorConfig({
    path: '/api/active-operator/config',
    method: 'POST',
    body: { autonomyMode: 'semi', semiAssessmentMinutes: 2 },
    user: { userId: 'fixture-owner', username: 'fixture-owner', role: 'owner', isAuthenticated: true },
  });
  assert.equal(res.status, 200);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].agent, 'robot-operator');
  assert.equal((startCalls[0].options as { source: string }).source, 'api/active-operator/config');
});

test('passive status and non-graph catalog reads do not create or mutate help tickets while active graph execution persists system errors', async () => {
  const username = 'passive-status-owner';
  const stateDir = path.join(root, 'profiles', username, 'state');
  const ticketsDir = path.join(stateDir, 'help-tickets');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'conversation-buffer-system.json'),
    JSON.stringify({
      messages: [
        {
          role: 'system',
          content: 'Unhandled workflow exception',
          timestamp: Date.parse('2026-11-13T17:00:00.000Z'),
          meta: { severity: 'error', taskId: 'task-passive-1' },
        },
      ],
      lastUpdated: Date.parse('2026-11-13T17:00:00.000Z'),
    }),
  );

  const statusRes = await handleGetActiveOperatorStatus({
    path: '/api/active-operator/status',
    method: 'GET',
    user: { userId: username, username, role: 'owner', isAuthenticated: true },
  });
  assert.equal(statusRes.status, 200);
  assert.equal(fs.existsSync(ticketsDir), false, 'GET /api/active-operator/status must not create help-tickets directory');

  const passiveCatalog = await robotAutonomyTaskCatalogNode.execute(
    {},
    { sessionId: 'passive-catalog', username } as any,
    { taskIds: ['system-code-review'], includeActivityHistory: false },
  );
  const passiveIssues = (passiveCatalog.activationState as { systemIssues: Array<{ errorEvidence?: { message?: string } }> }).systemIssues;
  assert.equal(passiveIssues.length, 1, 'passive catalog preview still exposes recorded buffer errors in memory');
  assert.equal(passiveIssues[0].errorEvidence?.message, 'Unhandled workflow exception');
  assert.equal(fs.existsSync(ticketsDir), false, 'passive catalog execute without graphExecution must not persist help tickets');

  const graphCatalog = await robotAutonomyTaskCatalogNode.execute(
    {},
    { sessionId: 'graph-catalog', username, graphExecution: { executionId: 'exec-review-1' } } as any,
    { taskIds: ['system-code-review'], includeActivityHistory: false },
  );
  const graphIssues = (graphCatalog.activationState as { systemIssues: Array<{ id: string }> }).systemIssues;
  assert.equal(graphIssues.length, 1);
  const ticketFiles = fs.readdirSync(ticketsDir).filter(file => file.endsWith('.json'));
  assert.equal(ticketFiles.length, 1, 'real graphExecution catalog runs persist system error tickets');
  const ticketPath = path.join(ticketsDir, ticketFiles[0]);
  const initialStat = fs.statSync(ticketPath);

  await readActiveOperatorStatus(username, true);
  assert.equal(fs.statSync(ticketPath).mtimeMs, initialStat.mtimeMs, 'passive status reads must not rewrite existing help tickets');

  const pending = getPendingTechnicalTickets(username);
  assert.equal(pending.length, 1);
  updateTicket(username, pending[0].id, { status: 'resolved' });
  assert.deepEqual(
    collectSystemReviewIssues(username, { persist: false }),
    [],
    'resolved tickets must immediately disappear from non-mutating issue reads without stale cache entries',
  );
});

test('readActiveOperatorStatus caches controller graph properties and terminal assessments while reflecting real file and store changes', async () => {
  const username = 'cached-status-owner';
  const controllerGraphFile = path.join(root, 'etc/cognitive-graphs/robot-autonomy-controller-mode.json');
  fs.writeFileSync(controllerGraphFile, defaultControllerGraph);

  const parentDefinition = {
    graphId: 'Editable Active Operator',
    graphHash: 'fixture-hash',
    runtimeVersion: 'fixture',
    checkpointSchemaVersion: 1,
    nodeVersions: { active_operator_dispatch: 'fixture', robot_autonomy_controller_parser: 'fixture' },
  };

  async function recordCompletedAssessment(key: string, checkpointId: string, activation: number, reason: string) {
    const store = openExecutionStore(username);
    try {
      const parent = store.enter(username, parentDefinition, key, {
        context: {
          robotOperatorContext: {
            robotObserver: {
              triggerSource: 'autonomy',
              requestedBy: 'robot-autonomy-controller',
              graph: 'robot-autonomy-controller',
            },
          },
        },
      });
      const executionId = parent.executionId;
      const lease = store.claim(executionId, parentDefinition);
      const assessedAt = new Date().toISOString();
      const entry = {
        operationId: 'robot-autonomy-executor',
        activation,
        instruction: `Execute step (${activation})`,
        reason,
      };
      const assessment = {
        executionId,
        mode: 'full',
        assessedAt,
        updates: [entry],
        selected: activation >= 100 ? [entry] : [],
        levels: {
          'robot-autonomy-executor': { ...entry, assessedAt },
        },
      };
      await new ExecutionCheckpointer(store, lease).put(
        { configurable: { thread_id: executionId } },
        {
          v: 4,
          id: checkpointId,
          ts: assessedAt,
          channel_versions: {},
          versions_seen: {},
          channel_values: {
            nodeEntries: [
              [
                'parser-1',
                {
                  status: 'completed',
                  definition: { type: 'robot_autonomy_controller_parser' },
                  outputs: { assessment },
                },
              ],
            ],
          },
        },
        { source: 'loop', step: 0, parents: {} },
      );
      store.settle(lease, 'completed');
      store.release(lease);
    } finally {
      store.close();
    }
  }

  await recordCompletedAssessment('exec-assessment-1', '0001-ckpt', 65, 'Initial assessment');

  let graphFileReads = 0;
  let checkpointDecodes = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const readSpy = mock.method(fs, 'readFileSync', ((target: fs.PathOrFileDescriptor, ...rest: any[]) => {
    if (String(target) === controllerGraphFile) graphFileReads += 1;
    return (originalReadFileSync as any)(target, ...rest);
  }) as typeof fs.readFileSync);
  const originalDecode = ExecutionStore.prototype.decodeDocument;
  const decodeSpy = mock.method(ExecutionStore.prototype, 'decodeDocument', function (this: InstanceType<typeof ExecutionStore>, ...args: Parameters<typeof originalDecode>) {
    checkpointDecodes += 1;
    return originalDecode.apply(this, args);
  });

  try {
    const cold = await readActiveOperatorStatus(username, true);
    assert.equal(cold.assessments.length, 1);
    assert.equal((cold.assessments[0] as { levels: Record<string, { activation: number }> }).levels['robot-autonomy-executor'].activation, 65);
    const coldGraphReads = graphFileReads;
    const coldDecodes = checkpointDecodes;
    assert.ok(coldDecodes > 0, 'cold read decodes the head checkpoint assessment');

    for (let i = 0; i < 3; i++) {
      const warm = await readActiveOperatorStatus(username, true);
      assert.deepEqual(warm.assessments, cold.assessments);
      assert.deepEqual(warm.operations, cold.operations);
    }
    assert.equal(graphFileReads, coldGraphReads, 'unchanged controller graph file must not be re-read on warm status polls');
    assert.equal(checkpointDecodes, coldDecodes, 'immutable terminal execution checkpoints must not be re-decoded on warm status polls');

    const restrictedGraph = JSON.parse(defaultControllerGraph) as { nodes: Array<{ data?: { nodeType?: string; properties?: Record<string, unknown> } }> };
    const catalogNode = restrictedGraph.nodes.find(node => node.data?.nodeType === 'robot_autonomy_task_catalog');
    assert.ok(catalogNode?.data?.properties);
    catalogNode.data.properties.taskIds = ['robot-autonomy-executor'];
    fs.writeFileSync(controllerGraphFile, JSON.stringify(restrictedGraph, null, 2));

    const afterGraphEdit = await readActiveOperatorStatus(username, true);
    assert.deepEqual(
      (afterGraphEdit.operations as Array<{ id: string }>).map(op => op.id),
      ['robot-autonomy-executor'],
      'modifying controller graph properties on disk must invalidate the stat-keyed cache immediately',
    );
    assert.equal(graphFileReads, coldGraphReads + 1);

    await recordCompletedAssessment('exec-assessment-2', '0002-ckpt', 95, 'Updated assessment');
    const afterNewAssessment = await readActiveOperatorStatus(username, true);
    assert.equal(afterNewAssessment.assessments.length, 2);
    assert.equal((afterNewAssessment.operations[0] as { activation: number }).activation, 95);
  } finally {
    readSpy.mock.restore();
    decodeSpy.mock.restore();
    fs.writeFileSync(controllerGraphFile, defaultControllerGraph);
  }
});
