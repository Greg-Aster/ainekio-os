import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import type {
  EnvironmentObservation,
  EnvironmentVisualFrame,
  SpatialCuriosityState,
} from '../environment-interface/types.js';
import type { RouterCallOptions, RouterResponse } from '../model-router.js';

const repoRoot = path.resolve(new URL('../../../../', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-embodied-curiosity-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => {
  throw new Error('Network calls are prohibited in embodied-curiosity tests');
};

fs.mkdirSync(path.join(root, 'etc/cognitive-graphs'), { recursive: true });
fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true });
for (const agentId of [
  'reflector',
  'daydreamer',
  'curiosity',
  'curiosity-researcher',
  'inner-curiosity',
  'train-of-thought',
  'desire-agent',
  'mood',
  'boredom-observer',
  'boredom-movement',
  'boredom-reflection',
  'robot-status',
  'robot-autonomy-controller',
]) {
  fs.mkdirSync(path.join(root, 'brain/agents', agentId), { recursive: true });
  fs.writeFileSync(path.join(root, 'brain/agents', agentId, 'cli.ts'), 'export {};\n');
}
fs.copyFileSync(path.join(repoRoot, 'etc/queue.json'), path.join(root, 'etc/queue.json'));
fs.copyFileSync(path.join(repoRoot, 'etc/agents.json'), path.join(root, 'etc/agents.json'));
for (const graphFile of [
  'environment-mode.json',
  'robot-active-task-mode.json',
  'robot-autonomy-controller-mode.json',
  'robot-display-feedback-mode.json',
  'robot-speech-mode.json',
  'system-code-review-mode.json',
]) {
  fs.copyFileSync(
    path.join(repoRoot, 'etc/cognitive-graphs', graphFile),
    path.join(root, 'etc/cognitive-graphs', graphFile),
  );
}
fs.writeFileSync(
  path.join(root, 'etc/services.json'),
  JSON.stringify({ services: { 'robot-operator': { id: 'robot-operator', enabled: true } } }, null, 2),
);

const llmCalls: RouterCallOptions[] = [];
let llmResponder: (options: RouterCallOptions) => Promise<string> | string = () => '{}';

const realModelRouter = await import('../model-router.js');
const modelRouterMock = mock.module('../model-router.js', {
  namedExports: {
    ...realModelRouter,
    callLLM: async (options: RouterCallOptions): Promise<RouterResponse> => {
      llmCalls.push(options);
      const content = await llmResponder(options);
      return {
        content,
        model: 'qwen3.5:9b',
        modelId: 'llama-cpp.qwen3.5:9b',
        role: options.role,
        provider: 'llama-cpp',
      };
    },
  },
});

const username = 'ainekio-fixture';
const realUsers = await import('../users.js');
const usersMock = mock.module('../users.js', {
  namedExports: {
    ...realUsers,
    getUser: (id: string) => (id === username ? { id: username, username, role: 'owner' } : null),
    getUserByUsername: (name?: string) => (name === username ? { id: username, username, role: 'owner' } : null),
  },
});

const profileRoot = path.join(root, 'profiles', username);
for (const sub of ['persona', 'etc', 'state', 'memory/episodic', 'memory/tasks/active', 'logs/audit']) {
  fs.mkdirSync(path.join(profileRoot, sub), { recursive: true });
}
fs.copyFileSync(
  path.join(repoRoot, 'profiles/Ainekio/persona/core.json'),
  path.join(profileRoot, 'persona/core.json'),
);
fs.copyFileSync(
  path.join(repoRoot, 'profiles/Ainekio/etc/models.json'),
  path.join(profileRoot, 'etc/models.json'),
);

const { ROOT, registerProfileStorageConfigGetter } = await import('../path-builder.js');
assert.equal(ROOT, root);
registerProfileStorageConfigGetter(() => undefined);

const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { setAuditEnabled } = await import('../audit.js');
setAuditEnabled(false);
const { claimWorkCoordinatorOwnership } = await import('../queue/work-submission.js');
claimWorkCoordinatorOwnership();

const { getQueueSystem, ensureQueueSystemStarted } = await import('../queue/queue-system.js');
const { getQueueManager } = await import('../queue/unified-queue-manager.js');
const { getModeController, updateActiveOperatorConfig, loadActiveOperatorConfig } = await import('./index.js');
const {
  EMBODIED_CURIOSITY_SYSTEM_1_PROMPT,
  EMBODIED_CURIOSITY_SYSTEM_2_PROMPT,
  buildEmbodiedCuriositySystem1Schema,
  readEmbodiedCuriosityTrainingBank,
  runEmbodiedCuriosityCycle,
  runEmbodiedCuriosityEscalation,
  tryRunEmbodiedCuriosityFromTrigger,
} = await import('./embodied-curiosity.js');
const { loadRobotOperatorConfig } = await import('../robot-operator.js');
const {
  BOREDOM_ENRICHMENT_TASK_IDS,
  DEFAULT_ROBOT_AUTONOMY_TASK_IDS,
} = await import('../nodes/robot-operator/autonomy-task-options.js');
const { robotAutonomyTaskCatalogNode } = await import('../nodes/robot-operator/task-catalog.node.js');
const { nodeRegistry } = await import('../nodes/index.js');
const {
  dispatchEnvironmentActions,
  dispatchEnvironmentVisualReads,
  recordEnvironmentActionResult,
  recordEnvironmentObservation,
  setEnvironmentBridgeEnabled,
  subscribeEnvironmentActions,
  writeEnvironmentBridgeState,
} = await import('../environment-interface/store.js');
const { projectSelectorState } = await import('../environment-interface/task-selection.js');
const { appendToBuffer, loadBufferForUser } = await import('../conversation-buffer.js');
const { executeRobotAutonomyTriggerWork } = await import('../queue/robot-autonomy-trigger-handler.js');
const { listEpisodicFiles, readCapturedEpisodicEvent } = await import('../memory.js');
const { withUserContext } = await import('../context.js');
const { openExecutionStore } = await import('../durable-execution/storage.js');
const { relayExecutionOutbox } = await import('../durable-execution/coordinator-outbox.js');

const VALID_JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00,
  0xff, 0xd9,
]).toString('base64')}`;

function buildSpatialCuriosity(overrides: Partial<SpatialCuriosityState> = {}): SpatialCuriosityState {
  return {
    headingDeg: 45,
    currentSector: 1,
    secondsStationary: 12,
    secondsSinceHumanActivity: 900,
    sectors: Array.from({ length: 8 }, (_, sector) => ({
      sector,
      centerDeg: sector * 45,
      lastSeenSecAgo: sector === 1 ? 2 : sector === 4 ? null : 180 + sector * 15,
      freeFloorMeters: sector === 4 ? null : 1.4,
      objects: sector === 2 ? ['backpack'] : [],
    })),
    trackedObjects: [
      {
        trackId: 'trk-backpack-1',
        label: 'backpack',
        sector: 2,
        inspected: false,
        lastSeenSecAgo: 4,
      },
    ],
    ...overrides,
  };
}

function buildConnectedObservation(
  sessionId: string,
  spatialCuriosity = buildSpatialCuriosity(),
  visual?: EnvironmentVisualFrame,
): EnvironmentObservation {
  const timestamp = new Date().toISOString();
  return {
    id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    environmentId: 'ainekio-room',
    adapter: 'body-control-v2',
    sessionId,
    timestamp,
    capabilities: {
      movement: true,
      visual: true,
      navigation: true,
      actions: ['move', 'stop', 'captureImage', 'requestMotion', 'faceExpression', 'speak'],
      locomotion: {
        commands: ['walk', 'turn'],
        goalKinds: ['distance', 'relativeTurn', 'approach', 'follow', 'visual'],
        lateral: true,
      },
      expressionLibrary: [
        { name: 'curious', label: 'Curious expression' },
        { name: 'happy', label: 'Happy expression' },
      ],
    },
    state: {
      adapterConnected: true,
      body: {
        authenticated: true,
        robotId: 'ainekio-v2',
        speakerReady: true,
      },
      gateway: {
        robots: {
          'ainekio-v2': {
            connection_state: 'online',
            epoch: 3,
            body_command_sequence: 19,
            mode: 'stand',
            posture: 'standing',
          },
        },
      },
      camera: { ready: true },
      recognition: {
        visionOperations: ['search', 'select', 'release'],
      },
      locomotionMeasurement: {
        yaw: {
          available: true,
          source: 'imu',
          robotId: 'ainekio-v2',
          sessionId,
          referenceId: 'epoch-3',
          degrees: 45,
          observedAt: timestamp,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          uncertaintyDegrees: 2,
        },
      },
      spatialCuriosity,
    },
    ...(visual ? { visual, visuals: [visual] } : {}),
  };
}

beforeEach(async () => {
  llmCalls.length = 0;
  llmResponder = () => '{}';
  writeEnvironmentBridgeState({
    enabled: true,
    updatedAt: new Date().toISOString(),
    sessions: {},
    feedback: [],
  });
  setEnvironmentBridgeEnabled(true);
});

after(async () => {
  await getQueueSystem().dispose();
  modelRouterMock.restore();
  usersMock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Phase 1: defaults exclude housekeeping/code-review, system-code-review has no TTS and is disabled, and Ainekio persona/models are updated', () => {
  assert.equal((DEFAULT_ROBOT_AUTONOMY_TASK_IDS as readonly string[]).includes('system-code-review'), false);
  assert.equal((DEFAULT_ROBOT_AUTONOMY_TASK_IDS as readonly string[]).includes('sleep-workflow'), false);
  assert.deepEqual(
    [...BOREDOM_ENRICHMENT_TASK_IDS].sort(),
    ['curiosity', 'curiosity-researcher', 'daydreamer', 'inner-curiosity', 'reflector', 'train-of-thought'],
  );

  const controllerGraph = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'etc/cognitive-graphs/robot-autonomy-controller-mode.json'), 'utf8'),
  );
  const graphTaskIds: string[] = controllerGraph.nodes.find((n: any) => n.id === 'task-catalog')?.data?.properties?.taskIds ?? [];
  assert.equal(graphTaskIds.includes('system-code-review'), false);
  assert.equal(graphTaskIds.includes('sleep-workflow'), false);

  const shippedAgents = JSON.parse(fs.readFileSync(path.join(repoRoot, 'etc/agents.json'), 'utf8'));
  assert.equal(shippedAgents.agents['system-code-review']?.enabled, false);

  const codeReviewGraph = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'etc/cognitive-graphs/system-code-review-mode.json'), 'utf8'),
  );
  assert.equal(codeReviewGraph.nodes.some((n: any) => n.id === 'speech' || n.data?.nodeType === 'tts'), false);
  assert.equal(
    codeReviewGraph.edges.some((e: any) => e.id === 'record-response-speech-conversation' || e.target === 'speech'),
    false,
  );

  const personaCore = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'profiles/Ainekio/persona/core.json'), 'utf8'),
  );
  assert.equal(personaCore.goals.shortTerm.length, 2);
  assert.match(personaCore.goals.shortTerm[0].goal, /Explore my surroundings, get comfortable moving and expressing myself in my V2 body/);
  assert.equal(personaCore.goals.midTerm.length, 2);
  assert.match(personaCore.goals.midTerm[1].goal, /without interrupting unnecessarily or freezing into inactivity/);

  const modelsConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'profiles/Ainekio/etc/models.json'), 'utf8'),
  );
  const envMap = modelsConfig.cognitiveModeMappings.environment;
  for (const role of [
    'orchestrator',
    'persona',
    'planner',
    'summarizer',
    'curator',
    'psychotherapist',
    'coder',
    'fallback',
    'environmentActionSelector',
    'environmentVision',
    'autonomy',
    'lightweight',
  ]) {
    assert.equal(envMap[role], 'llama-cpp.qwen3.5:9b', `environment.${role} must target llama-cpp.qwen3.5:9b`);
  }
});

test('Phase 1: BOREDOM_ENRICHMENT_TASK_IDS are gated by boredomInactivityMinutes differently in Semi vs Full mode', async () => {
  const sessionId = 'session-gating';
  updateActiveOperatorConfig({ boredomInactivityMinutes: 10 });
  assert.equal(loadActiveOperatorConfig().boredomInactivityMinutes, 10);

  // 1. Semi mode with recent human activity (120s < 600s threshold) -> enrichment gated
  await getModeController().setMode('semi', username);
  recordEnvironmentObservation(
    buildConnectedObservation(sessionId, buildSpatialCuriosity({ secondsSinceHumanActivity: 120, secondsStationary: 900 })),
  );
  const semiActive = await robotAutonomyTaskCatalogNode.execute(
    {},
    { username, robotOperatorContext: { sessionId } } as any,
    { includeActivityHistory: false },
  );
  for (const id of BOREDOM_ENRICHMENT_TASK_IDS) {
    assert.equal((semiActive.taskIds as string[]).includes(id), false, `${id} must be gated during recent human activity in Semi`);
    assert.equal((semiActive.unavailableTaskIds as string[]).includes(id), true);
  }

  // 2. Semi mode after human inactivity (700s >= 600s threshold) -> enrichment unlocked even if robot moved recently
  recordEnvironmentObservation(
    buildConnectedObservation(sessionId, buildSpatialCuriosity({ secondsSinceHumanActivity: 700, secondsStationary: 5 })),
  );
  const semiQuiet = await robotAutonomyTaskCatalogNode.execute(
    {},
    { username, robotOperatorContext: { sessionId } } as any,
    { includeActivityHistory: false },
  );
  for (const id of BOREDOM_ENRICHMENT_TASK_IDS) {
    assert.equal((semiQuiet.taskIds as string[]).includes(id), true, `${id} must unlock after human inactivity in Semi`);
  }

  // 3. Full mode with connected body while actively exploring (secondsStationary = 30 < 600s) -> enrichment stays gated!
  await getModeController().setMode('full', username);
  recordEnvironmentObservation(
    buildConnectedObservation(sessionId, buildSpatialCuriosity({ secondsSinceHumanActivity: 900, secondsStationary: 30 })),
  );
  const fullExploring = await robotAutonomyTaskCatalogNode.execute(
    {},
    { username, robotOperatorContext: { sessionId } } as any,
    { includeActivityHistory: false },
  );
  for (const id of BOREDOM_ENRICHMENT_TASK_IDS) {
    assert.equal((fullExploring.taskIds as string[]).includes(id), false, `${id} must stay gated while exploring in Full mode`);
    assert.equal((fullExploring.unavailableTaskIds as string[]).includes(id), true);
  }
  assert.deepEqual((fullExploring.activationState as any).inactivity, {
    boredomInactivityMinutes: 10,
    secondsSinceHumanInteraction: 900,
    secondsStationary: 30,
  });

  // 4. Full mode with connected body once settled (secondsStationary = 650 >= 600s, human inactive = 900 >= 600s) -> enrichment unlocked!
  recordEnvironmentObservation(
    buildConnectedObservation(sessionId, buildSpatialCuriosity({ secondsSinceHumanActivity: 900, secondsStationary: 650 })),
  );
  const fullSettled = await robotAutonomyTaskCatalogNode.execute(
    {},
    { username, robotOperatorContext: { sessionId } } as any,
    { includeActivityHistory: false },
  );
  for (const id of BOREDOM_ENRICHMENT_TASK_IDS) {
    assert.equal((fullSettled.taskIds as string[]).includes(id), true, `${id} must unlock once settled in Full mode`);
  }

  // 5. Recent user message in conversation buffer overrides stale camera human-activity timer
  await appendToBuffer(username, 'conversation', {
    role: 'user',
    content: 'Hey Ainekio!',
    timestamp: Date.now() - 15_000,
  });
  const fullRecentChat = await robotAutonomyTaskCatalogNode.execute(
    {},
    { username, robotOperatorContext: { sessionId } } as any,
    { includeActivityHistory: false },
  );
  assert.ok((fullRecentChat.activationState as any).inactivity.secondsSinceHumanInteraction < 60);
  for (const id of BOREDOM_ENRICHMENT_TASK_IDS) {
    assert.equal((fullRecentChat.taskIds as string[]).includes(id), false);
  }
});

test('Phase 2: spatialCuriosity survives projectSelectorState and robot_autonomy_controller_context intact', async () => {
  const spatialCuriosity = buildSpatialCuriosity();
  const observation = buildConnectedObservation('session-spatial', spatialCuriosity);

  const projectedState = projectSelectorState(observation.state) as Record<string, any>;
  assert.deepEqual(projectedState.spatialCuriosity, spatialCuriosity);
  assert.equal(projectedState.spatialCuriosity.sectors.length, 8);
  assert.equal(projectedState.spatialCuriosity.trackedObjects.length, 1);

  const contextNode = nodeRegistry.get('robot_autonomy_controller_context')!;
  const activationState = {
    mode: 'full',
    assessedAt: observation.timestamp,
    localTime: '15:00:00',
    timeZone: 'America/Los_Angeles',
    bodyConnection: { connected: true, sessionId: observation.sessionId, robotId: 'ainekio-v2', reason: null },
    inactivity: { boredomInactivityMinutes: 10, secondsSinceHumanInteraction: 900, secondsStationary: 12 },
    systemIssues: [],
    operations: [],
  };

  const selection = await contextNode.execute!(
    { activationState, observation },
    { username } as any,
    { contextPurpose: 'selection' },
  );
  const parsedSelection = JSON.parse(selection.request);
  assert.deepEqual(parsedSelection.spatialCuriosity, spatialCuriosity);
  assert.deepEqual(parsedSelection.inactivity, activationState.inactivity);

  const assessmentWithoutEnvSelected = await contextNode.execute!(
    {
      instruction: 'Assess Semi operations.',
      fullInstruction: 'Assess Full operations.',
      activationState,
      observation,
      contextSelection: { contextSources: [] },
    },
    { username } as any,
    { contextPurpose: 'assessment' },
  );
  assert.equal(assessmentWithoutEnvSelected.valid, true);
  const envelope = JSON.parse(assessmentWithoutEnvSelected.messages[1].content);
  assert.deepEqual(envelope.robotStimulus.state.spatialCuriosity, spatialCuriosity);
  assert.deepEqual(envelope.activeOperator.inactivity, activationState.inactivity);
});

test('Phase 3: System 1 runEmbodiedCuriosityCycle executes in 1 LLM hop via precomputedEnvironmentPlan without interpretationFence and records training candidate', async () => {
  await ensureQueueSystemStarted();
  await getModeController().setMode('full', username);
  updateActiveOperatorConfig({ boredomInactivityMinutes: 10 });

  // Clear recent chat buffer so human inactivity > threshold while secondsStationary < threshold
  const chatBufferPath = path.join(root, 'profiles', username, 'state/conversation-buffer-conversation.json');
  if (fs.existsSync(chatBufferPath)) fs.rmSync(chatBufferPath, { force: true });

  const sessionId = 'session-sys1';
  const frame: EnvironmentVisualFrame = {
    id: 'frame-curiosity-1',
    timestamp: new Date().toISOString(),
    mimeType: 'image/jpeg',
    dataUrl: VALID_JPEG_DATA_URL,
  };
  const observation = buildConnectedObservation(
    sessionId,
    buildSpatialCuriosity({ secondsStationary: 15, secondsSinceHumanActivity: 1200 }),
    frame,
  );
  recordEnvironmentObservation(observation);
  const unsubscribe = subscribeEnvironmentActions(sessionId, () => {});

  try {
    // Verify malformed/unsupported action is rejected by validateEnvironmentSelectorOutput
    llmResponder = () => JSON.stringify({
      taskDecision: {
        objective: 'Fly into orbit',
        completionCriteria: 'In orbit',
        outcome: 'act',
        reason: 'Unsupported test',
        continuationPolicy: 'none',
        requiredCompletionBasis: 'action_result',
      },
      program: {
        steps: [{ kind: 'action', action: { type: 'teleportToMars' } }],
      },
      inspectedTrackIds: [],
      escalateToMind: false,
      escalateReason: null,
    });
    await assert.rejects(
      () => runEmbodiedCuriosityCycle({ username, sessionId, observation, cycleId: 'cycle-invalid' }),
      /failed selector validation/,
    );
    assert.equal(readEmbodiedCuriosityTrainingBank(username).candidates.length, 0);

    // Valid single-hop System 1 physical turn + markInspected + escalateToMind=false
    llmCalls.length = 0;
    llmResponder = (call) => {
      assert.equal(call.messages[0]?.content, EMBODIED_CURIOSITY_SYSTEM_1_PROMPT);
      assert.equal(call.role, 'environmentVision');
      return JSON.stringify({
        taskDecision: {
          objective: 'Turn toward unseen rear sector 4 to scan the room',
          completionCriteria: 'Relative turn of 90 degrees completes',
          outcome: 'act',
          reason: 'Sector 4 has lastSeenSecAgo=null and navigable floor in adjacent sectors',
          continuationPolicy: 'none',
          requiredCompletionBasis: 'action_result',
        },
        program: {
          steps: [
            {
              kind: 'action',
              action: {
                type: 'move',
                direction: 'left',
                continuous: true,
                durationMs: 0,
                turn: 45,
                locomotionGoal: {
                  kind: 'relativeTurn',
                  degrees: 90,
                  tolerance: 10,
                },
              },
            },
          ],
        },
        inspectedTrackIds: ['trk-backpack-1'],
        escalateToMind: false,
        escalateReason: null,
      });
    };

    const triggerResult = await executeRobotAutonomyTriggerWork(
      {
        id: 'trigger-sys1-1',
        username,
        handler: 'workflow.robot-autonomy-controller',
        source: 'autonomy',
        input: { agentId: 'robot-autonomy-controller', sessionId, cycleId: 'cycle-sys1-1' },
      } as any,
      { signal: new AbortController().signal } as any,
    );

    assert.equal(llmCalls.length, 1, 'System 1 embodied curiosity must make exactly 1 LLM call (zero orchestrator/selector extra hops)');
    assert.equal(triggerResult.embodiedCuriosity, true);
    assert.equal(triggerResult.executionStatus, 'waiting');

    // Verify no stale interpretationFence was attached to active-task state or dispatched command
    const store = openExecutionStore(username);
    try {
      const entry = store.entry(String(triggerResult.executionId));
      assert.equal(entry.context.environmentInterpretation, undefined);
      assert.ok(entry.context.precomputedEnvironmentPlan);
    } finally {
      store.close();
    }

    let moveCommand: ReturnType<typeof dispatchEnvironmentActions>[number] | undefined;
    for (let step = 0; step < 5; step += 1) {
      const batch = dispatchEnvironmentActions(sessionId);
      assert.ok(batch.length > 0, 'Expected queued environment command');
      for (const cmd of batch) {
        if (cmd.type === 'move') {
          moveCommand = cmd;
        } else {
          await recordEnvironmentActionResult({
            id: `fb-aux-${step}-${cmd.id}`,
            actionId: cmd.id,
            timestamp: new Date().toISOString(),
            type: 'completed',
            message: `${cmd.type} completed`,
          });
        }
      }
      if (moveCommand) break;
    }
    assert.ok(moveCommand, 'Expected System 1 move action to be dispatched');
    assert.equal(moveCommand.type, 'move');
    assert.equal(moveCommand.metadata?.interpretationFence, undefined);

    const visualReads = dispatchEnvironmentVisualReads(sessionId);
    assert.equal(visualReads.some(r => r.operation === 'markInspected'), true);
    const markReq = visualReads.find(r => r.operation === 'markInspected')!;
    assert.deepEqual(markReq.trackIds, ['trk-backpack-1']);

    // Verify Training Bank persisted compact image_ref instead of raw base64 dataUrl
    const bank = readEmbodiedCuriosityTrainingBank(username);
    assert.equal(bank.candidates.length, 1);
    const savedCandidate = bank.candidates[0]!;
    assert.equal(savedCandidate.cycleId, 'cycle-sys1-1');
    assert.equal(savedCandidate.hasImage, true);
    assert.equal(savedCandidate.frameId, frame.id);
    assert.equal(JSON.stringify(savedCandidate.messages).includes('data:image/jpeg;base64'), false);
    assert.equal(JSON.stringify(savedCandidate.messages).includes(frame.id), true);

    // Complete physical action so active execution finishes cleanly
    const completedSys1 = recordEnvironmentActionResult({
      id: 'fb-sys1-1',
      actionId: moveCommand.id,
      timestamp: new Date().toISOString(),
      type: 'completed',
      message: 'Finite left turn completed',
      data: { executionEnded: true },
    });
    if (completedSys1?.action.executionId) {
      const store = openExecutionStore(completedSys1.username);
      try { await relayExecutionOutbox(store, completedSys1.action.executionId); } finally { store.close(); }
    }
  } finally {
    unsubscribe();
  }
});

test('Phase 4: System 2 runEmbodiedCuriosityEscalation persists memory, desire seed, optional speech via submitCoordinatorWork, and enforces per-executionId idempotency', async () => {
  await ensureQueueSystemStarted();
  const sessionId = 'session-sys2';
  const frame: EnvironmentVisualFrame = {
    id: 'frame-discovery-1',
    timestamp: '2026-11-13T23:20:00.000Z',
    mimeType: 'image/jpeg',
    dataUrl: VALID_JPEG_DATA_URL,
  };
  const observation = buildConnectedObservation(sessionId, buildSpatialCuriosity(), frame);
  observation.timestamp = '2026-11-13T23:20:00.000Z';
  recordEnvironmentObservation(observation);

  // Case A: Persona chooses to speak aloud + record observationMemory + record desireUpdate
  llmCalls.length = 0;
  llmResponder = (call) => {
    assert.equal(call.messages[0]?.content, EMBODIED_CURIOSITY_SYSTEM_2_PROMPT);
    return JSON.stringify({
      observationMemory: 'Observed a canvas backpack resting beside the east desk leg at 2026-11-13T23:20:00.000Z.',
      desireUpdate: 'Check later whether Greg left project hardware tools next to the backpack.',
      spokenReply: 'Found your backpack tucked by the desk leg.',
    });
  };

  const first = await runEmbodiedCuriosityEscalation(
    {
      executionId: 'exec-discovery-speak',
      sessionId,
      cycleId: 'cycle-discovery-speak',
      escalateReason: 'Newly inspected backpack in sector 2',
      inspectedTrackIds: ['trk-backpack-1'],
    },
    username,
  );

  assert.equal(llmCalls.length, 1);
  assert.ok(first.observationMemoryPath && fs.existsSync(first.observationMemoryPath));
  const savedMemory = await withUserContext({ userId: username, username, role: 'owner' }, () => (
    readCapturedEpisodicEvent(username, first.observationMemoryPath!)
  ));
  assert.equal(savedMemory.type, 'observation');
  assert.deepEqual(savedMemory.tags, ['embodied-curiosity', 'spatial-discovery']);
  assert.equal(savedMemory.metadata?.executionId, 'exec-discovery-speak');

  const innerEntries = loadBufferForUser(username, 'inner').messages;
  const desireEntry = innerEntries.find(m => m.meta?.executionId === 'exec-discovery-speak');
  assert.ok(desireEntry);
  assert.deepEqual(desireEntry.meta?.tags, ['autonomy', 'embodied-curiosity', 'desire-seed']);

  const convEntries = loadBufferForUser(username, 'conversation').messages;
  const replyEntry = convEntries.find(m => m.meta?.executionId === 'exec-discovery-speak');
  assert.ok(replyEntry);
  assert.equal(replyEntry.role, 'assistant');
  assert.equal(replyEntry.content, 'Found your backpack tucked by the desk leg.');
  assert.equal(replyEntry.meta?.dialogueSource, 'embodied-curiosity');

  assert.equal(first.spokenReplyQueued, true);
  assert.ok(first.speechTaskId);
  const manager = getQueueManager();
  const allTasks = [...manager.getAllTasks(), ...manager.getHistory()];
  const speechTask = allTasks.find(t => t.id === first.speechTaskId);
  assert.ok(speechTask);
  assert.equal(speechTask.handler, 'tts.robot-speech');
  assert.equal(speechTask.input.text, 'Found your backpack tucked by the desk leg.');

  // Repeat with the same executionId -> strictly idempotent (0 extra LLM calls, 0 extra speech)
  const duplicate = await runEmbodiedCuriosityEscalation(
    {
      executionId: 'exec-discovery-speak',
      sessionId,
      cycleId: 'cycle-discovery-speak',
      escalateReason: 'Duplicate replay check',
    },
    username,
  );
  assert.equal(duplicate.skipped, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(llmCalls.length, 1, 'Idempotent guard must prevent duplicate System 2 LLM calls for the same executionId');

  // Case B: Persona selects silent observation (spokenReply: null) -> zero speech queued
  const speechCountBeforeSilent = [...manager.getAllTasks(), ...manager.getHistory()]
    .filter(t => t.handler === 'tts.robot-speech').length;
  const episodicCountBeforeSilent = await withUserContext({ userId: username, username, role: 'owner' }, () => listEpisodicFiles().length);

  llmResponder = () => JSON.stringify({
    observationMemory: 'The north hallway doorway is clear at 2026-11-13T23:20:00.000Z.',
    desireUpdate: null,
    spokenReply: null,
  });

  const silent = await runEmbodiedCuriosityEscalation(
    {
      executionId: 'exec-discovery-silent',
      sessionId,
      cycleId: 'cycle-discovery-silent',
      escalateReason: 'Quiet room geometry update',
    },
    username,
  );
  assert.equal(silent.spokenReplyQueued, false);
  assert.equal(silent.speechTaskId, null);
  assert.equal(silent.desireUpdateRecorded, false);
  assert.ok(silent.observationMemoryPath);

  const speechCountAfterSilent = [...manager.getAllTasks(), ...manager.getHistory()]
    .filter(t => t.handler === 'tts.robot-speech').length;
  assert.equal(speechCountAfterSilent, speechCountBeforeSilent, 'spokenReply=null must queue zero tts.robot-speech items');
  const episodicCountAfterSilent = await withUserContext({ userId: username, username, role: 'owner' }, () => listEpisodicFiles().length);
  assert.equal(episodicCountAfterSilent, episodicCountBeforeSilent + 1);
});

test('Phase 4: System 1 escalateToMind=true on an async physical action schedules System 2 escalation upon graph.resume', async () => {
  await ensureQueueSystemStarted();
  const sessionId = 'session-async-escalation';
  const frame: EnvironmentVisualFrame = {
    id: 'frame-async-discovery-1',
    timestamp: '2026-11-13T23:25:00.000Z',
    mimeType: 'image/jpeg',
    dataUrl: VALID_JPEG_DATA_URL,
  };
  const observation = buildConnectedObservation(
    sessionId,
    buildSpatialCuriosity({ secondsStationary: 8, secondsSinceHumanActivity: 1200 }),
    frame,
  );
  recordEnvironmentObservation(observation);
  const unsubscribe = subscribeEnvironmentActions(sessionId, () => {});

  try {
    let system2Invocations = 0;
    llmResponder = (call) => {
      if (call.messages[0]?.content === EMBODIED_CURIOSITY_SYSTEM_1_PROMPT) {
        return JSON.stringify({
          taskDecision: {
            objective: 'Glance right toward newly spotted crate in sector 2',
            completionCriteria: 'Glance motion completes',
            outcome: 'act',
            reason: 'New uninspected crate visible in sector 2',
            continuationPolicy: 'none',
            requiredCompletionBasis: 'action_result',
          },
          program: {
            steps: [
              {
                kind: 'action',
                action: { type: 'requestMotion', description: 'glance right toward sector 2 crate' },
              },
            ],
          },
          inspectedTrackIds: ['trk-backpack-1'],
          escalateToMind: true,
          escalateReason: 'Spotted an unfamiliar crate next to the backpack',
        });
      }
      if (call.messages[0]?.content === EMBODIED_CURIOSITY_SYSTEM_2_PROMPT) {
        system2Invocations += 1;
        return JSON.stringify({
          observationMemory: 'Observed an unfamiliar wooden crate beside the backpack at 2026-11-13T23:25:00.000Z.',
          desireUpdate: 'Ask Greg about the wooden crate when he returns.',
          spokenReply: null,
        });
      }
      return '{}';
    };

    const cycleResult = await runEmbodiedCuriosityCycle({
      username,
      sessionId,
      observation,
      cycleId: 'cycle-async-escalate-1',
    });
    assert.equal(cycleResult.executionStatus, 'waiting');
    assert.equal(cycleResult.escalateToMind, true);
    assert.equal(cycleResult.escalationScheduled, false, 'Escalation must wait until physical move finishes');

    let motionCommand: ReturnType<typeof dispatchEnvironmentActions>[number] | undefined;
    for (let step = 0; step < 5; step += 1) {
      const batch = dispatchEnvironmentActions(sessionId);
      if (batch.length === 0) break;
      for (const cmd of batch) {
        if (cmd.type === 'requestMotion') {
          motionCommand = cmd;
        } else {
          const aux = recordEnvironmentActionResult({
            id: `fb-async-aux-${step}-${cmd.id}`,
            actionId: cmd.id,
            timestamp: new Date().toISOString(),
            type: 'completed',
            message: `${cmd.type} completed`,
          });
          if (aux?.action.executionId) {
            const store = openExecutionStore(aux.username);
            try { await relayExecutionOutbox(store, aux.action.executionId); } finally { store.close(); }
          }
        }
      }
      if (motionCommand) break;
    }
    assert.ok(motionCommand, 'Expected requestMotion command to be dispatched');

    const completed = recordEnvironmentActionResult({
      id: 'fb-async-motion-1',
      actionId: motionCommand.id,
      timestamp: new Date().toISOString(),
      type: 'completed',
      message: 'Glance right completed',
      data: { executionEnded: true },
    });
    if (completed?.action.executionId) {
      const store = openExecutionStore(completed.username);
      try { await relayExecutionOutbox(store, completed.action.executionId); } finally { store.close(); }
    }

    const deadline = Date.now() + 5000;
    while (system2Invocations < 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(system2Invocations, 1, 'Expected graph.resume to schedule and execute System 2 curiosity escalation once');

    const innerEntries = loadBufferForUser(username, 'inner').messages;
    assert.equal(
      innerEntries.some(m => m.meta?.executionId === cycleResult.executionId && m.content.includes('wooden crate')),
      true,
    );
  } finally {
    unsubscribe();
  }
});

test('Phase 3: System 1 step with outcome=request_user exits finitely on physical completion so Cycle 2 chains immediately', async () => {
  await ensureQueueSystemStarted();
  const sessionId = 'session-continuous-cycles';
  const observation = buildConnectedObservation(
    sessionId,
    buildSpatialCuriosity({ secondsStationary: 0, secondsSinceHumanActivity: 2 }),
  );
  recordEnvironmentObservation(observation);
  const unsubscribe = subscribeEnvironmentActions(sessionId, () => {});

  const drainCycleToCompletion = async (executionId: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const store = openExecutionStore(username);
      let status: string | undefined;
      let waitingReason: string | null | undefined;
      try {
        const rec = store.list(username).find(r => r.executionId === executionId);
        status = rec?.status;
        waitingReason = rec?.waitingReason;
      } finally {
        store.close();
      }
      assert.notEqual(waitingReason, 'user_or_autonomy', 'Finite curiosity step must never park at user_or_autonomy');
      if (status === 'completed') return;

      const batch = dispatchEnvironmentActions(sessionId);
      if (batch.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      for (const cmd of batch) {
        const res = recordEnvironmentActionResult({
          id: `fb-chain-${Date.now()}-${cmd.id}`,
          actionId: cmd.id,
          timestamp: new Date().toISOString(),
          type: 'completed',
          message: `${cmd.type} completed`,
          ...(cmd.type === 'requestMotion' ? { data: { executionEnded: true } } : {}),
        });
        if (res?.action.executionId) {
          const store = openExecutionStore(res.username);
          try { await relayExecutionOutbox(store, res.action.executionId); } finally { store.close(); }
        }
      }
    }
    assert.fail(`Execution ${executionId} did not reach completed within 5000ms`);
  };

  try {
    llmResponder = () => JSON.stringify({
      taskDecision: {
        objective: 'Explore unseen sectors 0, 1, and 2',
        completionCriteria: 'Scan at least three new sectors by turning',
        outcome: 'request_user',
        reason: 'All 8 sectors are unobserved; turn right first',
        continuationPolicy: 'none',
        requiredCompletionBasis: 'action_result',
        actionPurpose: 'expression',
        observationSummary: 'Facing sector 7; all sectors unobserved.',
        completionEvidence: 'None yet.',
      },
      program: {
        steps: [
          {
            kind: 'action',
            action: { type: 'requestMotion', description: 'Turn right toward sector 0' },
          },
          {
            kind: 'action',
            action: { type: 'faceExpression', expression: 'curious' },
          },
        ],
      },
      inspectedTrackIds: [],
      escalateToMind: false,
      escalateReason: null,
    });

    const config = loadRobotOperatorConfig();
    const cycle1 = await tryRunEmbodiedCuriosityFromTrigger({
      task: {
        id: 'task-chain-1',
        type: 'generic',
        handler: 'workflow.robot-autonomy-controller',
        resource: 'local-llm',
        source: 'autonomy',
        priority: 'background',
        state: 'leased',
        username,
        input: { agentId: 'robot-autonomy-controller', sessionId },
        attempts: 1,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
      } as never,
      config,
      requestedSession: sessionId,
      signal: new AbortController().signal,
    });
    assert.ok(cycle1);
    assert.equal(cycle1.embodiedCuriosity, true);

    await drainCycleToCompletion(String(cycle1.executionId));

    const cycle2 = await tryRunEmbodiedCuriosityFromTrigger({
      task: {
        id: 'task-chain-2',
        type: 'generic',
        handler: 'workflow.robot-autonomy-controller',
        resource: 'local-llm',
        source: 'autonomy',
        priority: 'background',
        state: 'leased',
        username,
        input: { agentId: 'robot-autonomy-controller', sessionId },
        attempts: 1,
        maxAttempts: 1,
        createdAt: new Date().toISOString(),
      } as never,
      config,
      requestedSession: sessionId,
      signal: new AbortController().signal,
    });
    assert.ok(cycle2);
    assert.equal(cycle2.skipped, undefined, 'Cycle 2 must run immediately after Cycle 1 completes');
    assert.equal(cycle2.embodiedCuriosity, true);
    await drainCycleToCompletion(String(cycle2.executionId));
  } finally {
    unsubscribe();
  }
});

test('Phase 3 follow-up: System 1 schema forbids program:null/outcome:complete and deduplicates stale camera frames across cycles', async () => {
  await ensureQueueSystemStarted();
  const sessionId = 'session-frame-dedup';
  const frame1: EnvironmentVisualFrame = {
    id: 'frame-dedup-1',
    timestamp: '2026-11-15T03:39:00.000Z',
    mimeType: 'image/jpeg',
    dataUrl: VALID_JPEG_DATA_URL,
  };
  const obs1 = buildConnectedObservation(
    sessionId,
    buildSpatialCuriosity({ secondsStationary: 4, secondsSinceHumanActivity: 600 }),
    frame1,
  );
  recordEnvironmentObservation(obs1);

  // 1. Schema requires concrete program.steps, includes move/locomotionGoal, and excludes outcome='complete' / program=null
  const schema = buildEmbodiedCuriositySystem1Schema(obs1) as Record<string, any>;
  assert.equal(schema.anyOf?.length, 1, 'requireAction=true must emit only the action-bearing schema branch');
  const branch = schema.anyOf[0];
  assert.equal(branch.properties?.program?.type, 'object');
  assert.equal(branch.properties?.program?.properties?.steps?.minItems, 1);
  const outcomeEnum: string[] = branch.properties?.taskDecision?.properties?.outcome?.enum ?? [];
  assert.equal(outcomeEnum.includes('complete'), false, 'outcome=complete must not appear in System 1 schema');
  assert.match(JSON.stringify(branch.properties?.program), /"locomotionGoal"/);

  const unsubscribe = subscribeEnvironmentActions(sessionId, () => {});
  const drainActions = async (executionId: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const store = openExecutionStore(username);
      let status: string | undefined;
      try {
        status = store.list(username).find(r => r.executionId === executionId)?.status;
      } finally {
        store.close();
      }
      if (status === 'completed' || status === 'idle') return;
      const batch = dispatchEnvironmentActions(sessionId);
      if (batch.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      for (const cmd of batch) {
        const res = recordEnvironmentActionResult({
          id: `fb-dedup-${Date.now()}-${cmd.id}`,
          actionId: cmd.id,
          timestamp: new Date().toISOString(),
          type: 'completed',
          message: `${cmd.type} completed`,
          ...(cmd.type === 'requestMotion' ? { data: { executionEnded: true } } : {}),
        });
        if (res?.action.executionId) {
          const store = openExecutionStore(res.username);
          try { await relayExecutionOutbox(store, res.action.executionId); } finally { store.close(); }
        }
      }
    }
    assert.fail(`Execution ${executionId} did not settle within 15000ms`);
  };

  try {
    // 2. Runtime parser also rejects program: null even if bypassed outside schema
    llmResponder = () => JSON.stringify({
      taskDecision: {
        objective: 'Scan room',
        completionCriteria: 'Scanned',
        outcome: 'complete',
        reason: 'Null program trap test',
        continuationPolicy: 'none',
        requiredCompletionBasis: 'visual_observation',
      },
      program: null,
      inspectedTrackIds: [],
      escalateToMind: false,
      escalateReason: null,
    });
    await assert.rejects(
      () => runEmbodiedCuriosityCycle({ username, sessionId, observation: obs1, cycleId: 'cycle-null-prog' }),
      /requires non-empty program\.steps/,
    );

    const stepResponse = JSON.stringify({
      taskDecision: {
        objective: 'Check unseen sector 2',
        completionCriteria: 'Posture scan completes',
        outcome: 'act',
        reason: 'Sector 2 is unseen',
        continuationPolicy: 'none',
        requiredCompletionBasis: 'action_result',
      },
      program: {
        steps: [
          {
            kind: 'action',
            action: { type: 'requestMotion', description: 'lean toward sector 2' },
          },
        ],
      },
      inspectedTrackIds: [],
      escalateToMind: false,
      escalateReason: null,
    });

    // 3. Cycle 1 with unseen frame-dedup-1 attaches JPEG via environmentVision
    llmCalls.length = 0;
    llmResponder = () => stepResponse;
    const c1 = await runEmbodiedCuriosityCycle({
      username,
      sessionId,
      observation: obs1,
      cycleId: 'cycle-dedup-1',
    });
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0]!.role, 'environmentVision');
    assert.equal(Array.isArray(llmCalls[0]!.messages[1]!.content), true);
    const c1Parts = llmCalls[0]!.messages[1]!.content as Array<{ type: string; text?: string }>;
    const c1Envelope = JSON.parse(c1Parts[0]!.text!);
    assert.equal(c1Envelope.cameraEvidence.attached, true);
    assert.equal(c1Envelope.cameraEvidence.frameId, 'frame-dedup-1');
    await drainActions(c1.executionId);

    // 4. Cycle 2 with the SAME frame-dedup-1 skips re-attaching the stale JPEG (uses environmentActionSelector)
    llmCalls.length = 0;
    const c2 = await runEmbodiedCuriosityCycle({
      username,
      sessionId,
      observation: obs1,
      cycleId: 'cycle-dedup-2',
    });
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0]!.role, 'environmentActionSelector');
    assert.equal(typeof llmCalls[0]!.messages[1]!.content, 'string');
    const c2Envelope = JSON.parse(llmCalls[0]!.messages[1]!.content as string);
    assert.equal(c2Envelope.cameraEvidence.attached, false);
    assert.equal(c2Envelope.cameraEvidence.frameId, null);
    assert.equal(c2Envelope.cameraEvidence.lastEvaluatedFrameId, 'frame-dedup-1');
    assert.equal(c2Envelope.cameraEvidence.lastEvaluatedAt, frame1.timestamp);
    await drainActions(c2.executionId);

    // 5. Escalation write preserves lastEvaluatedFrameIds, and Cycle 3 with new frame-dedup-2 attaches again
    llmResponder = () => JSON.stringify({
      observationMemory: null,
      desireUpdate: null,
      spokenReply: null,
    });
    await runEmbodiedCuriosityEscalation(
      {
        executionId: 'exec-preserve-ledger-check',
        sessionId,
        cycleId: 'cycle-dedup-2',
        escalateReason: 'Ledger preservation check',
      },
      username,
    );

    llmCalls.length = 0;
    llmResponder = () => stepResponse;
    const c2Repeat = await runEmbodiedCuriosityCycle({
      username,
      sessionId,
      observation: obs1,
      cycleId: 'cycle-dedup-2b',
    });
    assert.equal(llmCalls[0]!.role, 'environmentActionSelector', 'Escalation ledger write must preserve lastEvaluatedFrameIds');
    await drainActions(c2Repeat.executionId);

    const frame2: EnvironmentVisualFrame = {
      id: 'frame-dedup-2',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      mimeType: 'image/jpeg',
      dataUrl: VALID_JPEG_DATA_URL,
    };
    const obs2 = buildConnectedObservation(
      sessionId,
      buildSpatialCuriosity({ secondsStationary: 2, secondsSinceHumanActivity: 660 }),
      frame2,
    );
    recordEnvironmentObservation(obs2);

    llmCalls.length = 0;
    const c3 = await runEmbodiedCuriosityCycle({
      username,
      sessionId,
      observation: obs2,
      cycleId: 'cycle-dedup-3',
    });
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0]!.role, 'environmentVision');
    const c3Parts = llmCalls[0]!.messages[1]!.content as Array<{ type: string; text?: string }>;
    const c3Envelope = JSON.parse(c3Parts[0]!.text!);
    assert.equal(c3Envelope.cameraEvidence.attached, true);
    assert.equal(c3Envelope.cameraEvidence.frameId, 'frame-dedup-2');
    await drainActions(c3.executionId);
  } finally {
    unsubscribe();
  }
});
