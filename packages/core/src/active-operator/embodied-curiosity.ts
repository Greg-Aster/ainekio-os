import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectDesireAwareness } from '../agency/lifecycle-policy.js';
import { listActiveDesires } from '../agency/storage.js';
import { getUserContext, withUserContext } from '../context.js';
import { appendToBuffer, loadBufferForUser } from '../conversation-buffer.js';
import { openExecutionStore } from '../durable-execution/storage.js';
import {
  getEnvironmentActionSubscriberCount,
  getEnvironmentFeedback,
  getLatestEnvironmentObservation,
  getLatestEnvironmentVisual,
} from '../environment-interface/store.js';
import {
  buildEnvironmentSelectorJsonSchema,
  projectSelectorState,
  validateEnvironmentSelectorOutput,
} from '../environment-interface/task-selection.js';
import type {
  EnvironmentObservation,
  EnvironmentVisualFrame,
} from '../environment-interface/types.js';
import { validEnvironmentJpegDataUrl } from '../environment-interface/visual-correlation.js';
import type { GraphExecutionState } from '../graph-executor.js';
import { loadPersonaCore } from '../identity.js';
import { captureEvent, listEpisodicFiles, readCapturedEpisodicEvent } from '../memory.js';
import { callLLM, type RouterMessage } from '../model-router.js';
import {
  selectedEnvironmentRoutes,
  type EnvironmentRequestRouting,
} from '../nodes/environment/context-routing.js';
import { measureSecondsSinceHumanInteraction } from '../nodes/robot-operator/task-catalog.node.js';
import { getProfilePaths } from '../path-builder.js';
import type { ProviderContentPart } from '../providers/types.js';
import type { QueuedTask } from '../queue/types.js';
import { submitCoordinatorWork } from '../queue/work-submission.js';
import {
  activeRobotExecutions,
  readRobotOperatorBodyConnection,
  type RobotObserverCycleMetadata,
  type RobotOperatorConfig,
} from '../robot-operator.js';
import {
  readFileSync as readProfileFile,
  resolvePath,
  writeFileSync as writeProfileFile,
} from '../storage-client.js';
import { getSpeechOutputSettings } from '../tts/robot-speech.js';
import { getUserByUsername } from '../users.js';
import { loadConfig as loadActiveOperatorConfig } from './state-persister.js';
import { DEFAULT_BOREDOM_INACTIVITY_MINUTES } from './types.js';

export const EMBODIED_CURIOSITY_SYSTEM_1_PROMPT =
  'You are the embodied instinct and curiosity controller for the companion robot described by the supplied persona. Given the current spatialCuriosity sector map, camera evidence, body capabilities, active desire or objective, and recent action receipts, select the next immediate physical step as JSON matching the schema. Use spatialCuriosity.sectors and trackedObjects to notice unseen directions, navigable floor space, uninspected objects, and human activity at their recorded timestamps. Set program to execute concrete supported body actions: use move (walk or relativeTurn) to rotate into unseen sectors or walk across clear floor toward uninspected objects, include captureImage after moving or when cameraEvidence.attached is false so you acquire a fresh view, and use requestMotion or faceExpression for in-place body posture and facial expression. Set escalateToMind=true with escalateReason when a newly captured view reveals something worth interpreting or remembering, when an objective finishes or is blocked, or when the supplied persona and social context call for deliberative thought or speech. Never fabricate sensor measurements or treat commanded actions as completed outcomes.';

export const EMBODIED_CURIOSITY_SYSTEM_2_PROMPT =
  "You are the companion described by the supplied persona. Review the supplied visual and spatial discovery, recent conversation, memories, and active desires. Return JSON with: (1) observationMemory (concise attributed record of any meaningful environmental or situational fact worth remembering, or null), (2) desireUpdate (optional next objective or desire note, or null), and (3) spokenReply (outward remark in your persona's voice if your personality, relationship, and the current situation warrant speaking aloud, or null when silent observation fits your character). Ground all factual claims in supplied sensor evidence and timestamps.";

export const EMBODIED_CURIOSITY_SYSTEM_2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['observationMemory', 'desireUpdate', 'spokenReply'],
  properties: {
    observationMemory: {
      anyOf: [{ type: 'null' }, { type: 'string', minLength: 1 }],
    },
    desireUpdate: {
      anyOf: [{ type: 'null' }, { type: 'string', minLength: 1 }],
    },
    spokenReply: {
      anyOf: [{ type: 'null' }, { type: 'string', minLength: 1 }],
    },
  },
};

const ROLLING_BANK_PATH = 'embodied-curiosity/rolling-bank.json';
const CANDIDATES_DIR = 'embodied-curiosity/candidates';
const ROLLING_BANK_MAX_ENTRIES = 200;
const ESCALATION_LEDGER_MAX_ENTRIES = 500;

export interface EmbodiedCuriosityEscalationMeta {
  escalateToMind: true;
  escalateReason: string;
  inspectedTrackIds: string[];
  sessionId: string;
  cycleId: string;
}

export interface EmbodiedCuriosityCompactMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_ref'; frameId: string; timestamp: string }
  >;
}

export interface EmbodiedCuriosityTrainingCandidate {
  id: string;
  sourceDigest: string;
  recordedAt: string;
  sessionId: string;
  cycleId: string;
  hasImage: boolean;
  frameId: string | null;
  messages: EmbodiedCuriosityCompactMessage[];
  observedOutput: string;
  escalateToMind: boolean;
  escalateReason: string | null;
}

export interface EmbodiedCuriosityTrainingBank {
  version: 1;
  candidates: EmbodiedCuriosityTrainingCandidate[];
}

export interface EmbodiedCuriosityCycleInput {
  username: string;
  sessionId: string;
  observation: EnvironmentObservation;
  environmentGraph?: string;
  cycleId?: string;
  signal?: AbortSignal;
}

export interface EmbodiedCuriosityCycleResult {
  graphExecuted: true;
  embodiedCuriosity: true;
  executionId: string;
  executionStatus: GraphExecutionState['status'];
  sessionId: string;
  agentId: 'robot-autonomy-controller';
  cycle: RobotObserverCycleMetadata;
  candidateId: string;
  inspectedTrackIds: string[];
  escalateToMind: boolean;
  escalateReason: string | null;
  escalationScheduled: boolean;
}

export interface EmbodiedCuriosityEscalationInput {
  executionId: string;
  sessionId: string;
  cycleId: string;
  escalateReason: string;
  inspectedTrackIds?: string[];
  capturedFrameIds?: string[];
}

export interface EmbodiedCuriosityEscalationResult {
  executionId: string;
  skipped?: boolean;
  duplicate?: boolean;
  observationMemoryPath: string | null;
  desireUpdateRecorded: boolean;
  spokenReplyQueued: boolean;
  speechTaskId: string | null;
  outputs: {
    observationMemory: string | null;
    desireUpdate: string | null;
    spokenReply: string | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function resolveBoredomInactivityMinutes(configured?: number): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BOREDOM_INACTIVITY_MINUTES;
}

export function hasEmbodiedCuriositySettled(options: {
  boredomInactivityMinutes?: number;
  secondsSinceHumanInteraction: number | null;
  observation?: EnvironmentObservation | null;
}): boolean {
  const thresholdSec = resolveBoredomInactivityMinutes(options.boredomInactivityMinutes) * 60;
  const humanInactive = options.secondsSinceHumanInteraction === null
    || options.secondsSinceHumanInteraction >= thresholdSec;
  const stationarySec = options.observation?.state?.spatialCuriosity?.secondsStationary ?? 0;
  return humanInactive && stationarySec >= thresholdSec;
}

export function buildEmbodiedCuriositySystem1Schema(
  observation: EnvironmentObservation,
): Record<string, unknown> {
  const recognition = isRecord(observation.state?.recognition) ? observation.state!.recognition : null;
  const visionOperations = Array.isArray(recognition?.visionOperations)
    ? recognition.visionOperations.filter((op): op is string => typeof op === 'string')
    : [];
  const base = buildEnvironmentSelectorJsonSchema({
    includeResponse: false,
    requireAction: true,
    actions: observation.capabilities.actions,
    locomotion: observation.capabilities.locomotion,
    expressions: observation.capabilities.expressionLibrary?.map(entry => entry.name) ?? [],
    visionOperations,
    actionRouteSelected: true,
  });
  const extraProperties = {
    inspectedTrackIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    escalateToMind: {
      type: 'boolean',
    },
    escalateReason: {
      anyOf: [{ type: 'null' }, { type: 'string', minLength: 1 }],
    },
  };
  const extendBranch = (branch: Record<string, unknown>): Record<string, unknown> => ({
    ...branch,
    required: [
      ...(Array.isArray(branch.required) ? branch.required : []),
      'inspectedTrackIds',
      'escalateToMind',
      'escalateReason',
    ],
    properties: {
      ...(isRecord(branch.properties) ? branch.properties : {}),
      ...extraProperties,
    },
  });
  if (Array.isArray(base.anyOf)) {
    return {
      ...base,
      anyOf: base.anyOf.map(item => (isRecord(item) ? extendBranch(item) : item)),
    };
  }
  return extendBranch(base);
}

function trainingStorageRequest(username: string, relativePath: string) {
  return {
    username,
    category: 'memory' as const,
    subcategory: 'training' as const,
    relativePath,
  };
}

function readTrainingJson<T>(username: string, relativePath: string, fallback: T): T {
  const request = trainingStorageRequest(username, relativePath);
  const resolved = resolvePath(request);
  if (!resolved.success || !resolved.path) {
    throw new Error(resolved.error || 'Embodied curiosity training storage is unavailable');
  }
  if (!fs.existsSync(resolved.path) && !fs.existsSync(`${resolved.path}.enc`)) {
    return fallback;
  }
  const read = readProfileFile({ ...request, encoding: 'utf8' });
  if (!read.success || typeof read.data !== 'string') {
    throw new Error(read.error || 'Cannot read embodied curiosity training data');
  }
  return JSON.parse(read.data) as T;
}

function writeTrainingJson(username: string, relativePath: string, value: unknown): void {
  const result = writeProfileFile({
    ...trainingStorageRequest(username, relativePath),
    data: JSON.stringify(value, null, 2),
  });
  if (!result.success) {
    throw new Error(result.error || 'Cannot write embodied curiosity training data');
  }
}

export function readEmbodiedCuriosityTrainingBank(username: string): EmbodiedCuriosityTrainingBank {
  const bank = readTrainingJson<EmbodiedCuriosityTrainingBank>(username, ROLLING_BANK_PATH, {
    version: 1,
    candidates: [],
  });
  if (bank.version !== 1 || !Array.isArray(bank.candidates)) {
    throw new Error('Invalid embodied curiosity training bank');
  }
  return bank;
}

function compactTrainingMessages(
  messages: RouterMessage[],
  visualFrame: EnvironmentVisualFrame | undefined,
): EmbodiedCuriosityCompactMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    const parts = (msg.content as ProviderContentPart[]).map(part => {
      if (part.type === 'image_url') {
        return {
          type: 'image_ref' as const,
          frameId: visualFrame?.id ?? 'unknown-frame',
          timestamp: visualFrame?.timestamp ?? '',
        };
      }
      return { type: 'text' as const, text: part.text };
    });
    return { role: msg.role, content: parts };
  });
}

export function recordEmbodiedCuriosityTrainingCandidate(input: {
  username: string;
  sessionId: string;
  cycleId: string;
  hasImage: boolean;
  visualFrame?: EnvironmentVisualFrame;
  messages: RouterMessage[];
  observedOutput: string;
  escalateToMind: boolean;
  escalateReason: string | null;
}): EmbodiedCuriosityTrainingCandidate {
  const compactMessages = compactTrainingMessages(input.messages, input.visualFrame);
  const sourceDigest = sha256Hex([compactMessages, input.observedOutput]);
  const id = sha256Hex([
    input.username,
    input.sessionId,
    input.cycleId,
    sourceDigest,
  ]).slice(0, 32);
  const candidate: EmbodiedCuriosityTrainingCandidate = {
    id,
    sourceDigest,
    recordedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    cycleId: input.cycleId,
    hasImage: input.hasImage,
    frameId: input.hasImage ? (input.visualFrame?.id ?? null) : null,
    messages: compactMessages,
    observedOutput: input.observedOutput,
    escalateToMind: input.escalateToMind,
    escalateReason: input.escalateReason,
  };
  writeTrainingJson(input.username, `${CANDIDATES_DIR}/${id}.json`, candidate);
  const existing = readEmbodiedCuriosityTrainingBank(input.username);
  const filtered = existing.candidates.filter(entry => entry.id !== id);
  filtered.push(candidate);
  const bounded = filtered.slice(-ROLLING_BANK_MAX_ENTRIES);
  writeTrainingJson(input.username, ROLLING_BANK_PATH, {
    version: 1,
    candidates: bounded,
  } satisfies EmbodiedCuriosityTrainingBank);
  return candidate;
}

function projectStandingPersonaSummary(username: string): Record<string, unknown> | null {
  try {
    const persona = loadPersonaCore(username);
    return {
      identity: persona.identity,
      background: persona.background,
      personality: {
        communicationStyle: persona.personality?.communicationStyle,
        traits: persona.personality?.traits,
        interests: persona.personality?.interests,
        narrativeStyle: persona.personality?.narrativeStyle,
      },
      values: persona.values,
      goals: persona.goals,
    };
  } catch {
    return null;
  }
}

async function loadBoundedActiveDesires(username: string, limit = 3) {
  try {
    const desires = await listActiveDesires(username);
    desires.sort((a, b) => b.strength - a.strength || b.updatedAt.localeCompare(a.updatedAt));
    return projectDesireAwareness(desires, limit);
  } catch {
    return [];
  }
}

function selectValidVisualFrame(
  username: string,
  sessionId: string,
  observation: EnvironmentObservation,
): {
  freshFrame?: EnvironmentVisualFrame;
  latestSeenFrame?: EnvironmentVisualFrame;
} {
  const candidates = [
    getLatestEnvironmentVisual(sessionId),
    observation.visual,
    ...(observation.visuals ?? []),
  ].filter((frame): frame is EnvironmentVisualFrame => (
    frame != null
    && typeof frame.id === 'string'
    && typeof frame.timestamp === 'string'
    && validEnvironmentJpegDataUrl(frame.dataUrl)
  ));
  candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const newest = candidates[0];
  if (!newest) return {};
  const lastEvaluatedId = sessionId ? getLastEvaluatedFrameId(username, sessionId) : null;
  if (lastEvaluatedId && newest.id === lastEvaluatedId) {
    return { latestSeenFrame: newest };
  }
  return { freshFrame: newest };
}

function parseSystem1Output(
  rawText: string,
  sessionId: string,
): {
  selectorPayload: string;
  taskDecision: Record<string, unknown> | null;
  program: Record<string, unknown>;
  inspectedTrackIds: string[];
  escalateToMind: boolean;
  escalateReason: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error('Embodied curiosity System 1 output is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('Embodied curiosity System 1 output must be a JSON object');
  }
  if (typeof parsed.escalateToMind !== 'boolean') {
    throw new Error('Embodied curiosity System 1 output requires boolean escalateToMind');
  }
  const escalateReason = typeof parsed.escalateReason === 'string' && parsed.escalateReason.trim()
    ? parsed.escalateReason.trim()
    : null;
  if (parsed.escalateToMind && !escalateReason) {
    throw new Error('Embodied curiosity System 1 output requires escalateReason when escalateToMind is true');
  }
  const inspectedTrackIds = Array.isArray(parsed.inspectedTrackIds)
    ? [...new Set(
        parsed.inspectedTrackIds
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map(id => id.trim()),
      )]
    : [];

  const selectorCandidate = JSON.stringify({
    taskDecision: parsed.taskDecision ?? null,
    program: parsed.program ?? null,
    ...(parsed.visualObservation !== undefined ? { visualObservation: parsed.visualObservation } : {}),
  });
  const validation = validateEnvironmentSelectorOutput(selectorCandidate, sessionId, [], false);
  if (!validation.valid || !validation.value) {
    throw new Error(
      `Embodied curiosity System 1 output failed selector validation: ${validation.errors.join('; ')}`,
    );
  }
  if (!validation.value.program?.steps?.length) {
    throw new Error('Embodied curiosity System 1 output requires non-empty program.steps');
  }
  return {
    selectorPayload: selectorCandidate,
    taskDecision: (validation.value.taskDecision as unknown as Record<string, unknown> | null) ?? null,
    program: validation.value.program as unknown as Record<string, unknown>,
    inspectedTrackIds,
    escalateToMind: parsed.escalateToMind,
    escalateReason,
  };
}

function escalationLedgerPath(username: string): string {
  const stateDir = getProfilePaths(username).state;
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, 'embodied-curiosity-escalations.json');
}

interface EscalationLedgerFile {
  version: 1;
  escalatedExecutionIds: string[];
  lastEvaluatedFrameIds?: Record<string, string>;
}

function readCuriosityStateLedger(username: string): {
  escalatedExecutionIds: string[];
  lastEvaluatedFrameIds: Record<string, string>;
} {
  const filePath = escalationLedgerPath(username);
  if (!fs.existsSync(filePath)) {
    return { escalatedExecutionIds: [], lastEvaluatedFrameIds: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<EscalationLedgerFile>;
    const escalatedExecutionIds = Array.isArray(parsed.escalatedExecutionIds)
      ? parsed.escalatedExecutionIds.filter((id): id is string => typeof id === 'string')
      : [];
    const lastEvaluatedFrameIds: Record<string, string> = {};
    if (isRecord(parsed.lastEvaluatedFrameIds)) {
      for (const [key, value] of Object.entries(parsed.lastEvaluatedFrameIds)) {
        if (typeof key === 'string' && key && typeof value === 'string' && value) {
          lastEvaluatedFrameIds[key] = value;
        }
      }
    }
    return { escalatedExecutionIds, lastEvaluatedFrameIds };
  } catch {
    return { escalatedExecutionIds: [], lastEvaluatedFrameIds: {} };
  }
}

function writeCuriosityStateLedger(username: string, ledger: EscalationLedgerFile): void {
  const filePath = escalationLedgerPath(username);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(ledger, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readEscalationLedger(username: string): Set<string> {
  return new Set(readCuriosityStateLedger(username).escalatedExecutionIds);
}

function recordEscalatedExecution(username: string, executionId: string): void {
  const current = readCuriosityStateLedger(username);
  const existing = current.escalatedExecutionIds.filter(id => id !== executionId);
  existing.push(executionId);
  const bounded = existing.slice(-ESCALATION_LEDGER_MAX_ENTRIES);
  writeCuriosityStateLedger(username, {
    version: 1,
    escalatedExecutionIds: bounded,
    ...(Object.keys(current.lastEvaluatedFrameIds).length > 0
      ? { lastEvaluatedFrameIds: current.lastEvaluatedFrameIds }
      : {}),
  });
}

function getLastEvaluatedFrameId(username: string, sessionId: string): string | null {
  return readCuriosityStateLedger(username).lastEvaluatedFrameIds[sessionId] ?? null;
}

function recordLastEvaluatedFrameId(username: string, sessionId: string, frameId: string): void {
  if (!sessionId || !frameId) return;
  const current = readCuriosityStateLedger(username);
  if (current.lastEvaluatedFrameIds[sessionId] === frameId) return;
  const entries = Object.entries(current.lastEvaluatedFrameIds).filter(([key]) => key !== sessionId);
  entries.push([sessionId, frameId]);
  const boundedFrameIds = Object.fromEntries(entries.slice(-32));
  writeCuriosityStateLedger(username, {
    version: 1,
    escalatedExecutionIds: current.escalatedExecutionIds,
    lastEvaluatedFrameIds: boundedFrameIds,
  });
}

const inFlightEscalations = new Set<string>();

export function hasEscalatedEmbodiedCuriosityExecution(username: string, executionId: string): boolean {
  const key = `${username}:${executionId}`;
  return inFlightEscalations.has(key) || readEscalationLedger(username).has(executionId);
}

function physicalStepCompleted(state: GraphExecutionState): boolean {
  if (state.status === 'completed') return true;
  const activeTask = state.nodes.get('active-task');
  return activeTask?.status === 'completed' && activeTask.outputs?.finished === true;
}

export async function maybeScheduleEmbodiedCuriosityEscalation(options: {
  username: string;
  executionId: string;
  context?: Record<string, unknown>;
  state: GraphExecutionState;
}): Promise<{ scheduled: boolean; taskId?: string; duplicate?: boolean }> {
  if (!physicalStepCompleted(options.state)) {
    return { scheduled: false };
  }
  const robotOperatorContext = isRecord(options.context?.robotOperatorContext)
    ? options.context!.robotOperatorContext
    : null;
  const escalation = isRecord(robotOperatorContext?.embodiedCuriosityEscalation)
    ? robotOperatorContext!.embodiedCuriosityEscalation
    : null;
  if (escalation?.escalateToMind !== true) {
    return { scheduled: false };
  }
  if (hasEscalatedEmbodiedCuriosityExecution(options.username, options.executionId)) {
    return { scheduled: false, duplicate: true };
  }
  const activeTaskResult = isRecord(options.state.nodes.get('active-task')?.outputs?.result)
    ? options.state.nodes.get('active-task')!.outputs!.result as Record<string, unknown>
    : null;
  const capturedFrameIds = Array.isArray(activeTaskResult?.capturedFrameIds)
    ? activeTaskResult!.capturedFrameIds.filter((id): id is string => typeof id === 'string')
    : [];
  const sessionId = typeof escalation.sessionId === 'string' ? escalation.sessionId : '';
  const cycleId = typeof escalation.cycleId === 'string' ? escalation.cycleId : options.executionId;
  const escalateReason = typeof escalation.escalateReason === 'string'
    ? escalation.escalateReason
    : 'Embodied curiosity discovery escalation';
  const inspectedTrackIds = Array.isArray(escalation.inspectedTrackIds)
    ? escalation.inspectedTrackIds.filter((id): id is string => typeof id === 'string')
    : [];

  try {
    const queued = await submitCoordinatorWork({
      type: 'generic',
      handler: 'environment.curiosity-escalation',
      resource: 'embodied-curiosity-escalation',
      executionScope: 'invocation',
      source: 'autonomy',
      username: options.username,
      priority: 'normal',
      maxAttempts: 1,
      correlationId: cycleId,
      idempotencyKey: `embodied-curiosity-escalation:${options.executionId}`,
      input: {
        executionId: options.executionId,
        sessionId,
        cycleId,
        escalateReason,
        inspectedTrackIds,
        capturedFrameIds,
      } satisfies EmbodiedCuriosityEscalationInput,
    });
    return { scheduled: true, taskId: queued.id };
  } catch (error) {
    console.warn(
      `[embodied-curiosity] Non-blocking escalation enqueue failed for ${options.executionId}:`,
      (error as Error).message,
    );
    return { scheduled: false };
  }
}

export async function runEmbodiedCuriosityCycle(
  input: EmbodiedCuriosityCycleInput,
): Promise<EmbodiedCuriosityCycleResult> {
  const user = getUserByUsername(input.username) ?? {
    id: input.username,
    username: input.username,
    role: 'owner' as const,
  };
  const cycleId = input.cycleId?.trim() || randomUUID();
  const environmentGraph = input.environmentGraph?.trim() || 'environment';
  const observation = input.observation;
  const sessionId = input.sessionId;

  const { freshFrame: visualFrame, latestSeenFrame } = selectValidVisualFrame(
    user.username,
    sessionId,
    observation,
  );
  const hasImage = Boolean(visualFrame);

  const [personaSummary, activeDesires] = await Promise.all([
    Promise.resolve(withUserContext(
      { userId: user.id, username: user.username, role: user.role },
      () => projectStandingPersonaSummary(user.username),
    )),
    loadBoundedActiveDesires(user.username, 3),
  ]);

  const receipts = getEnvironmentFeedback({ limit: 5 }).map(item => ({
    id: item.id,
    timestamp: item.timestamp,
    type: item.type,
    actionId: item.actionId ?? null,
    message: item.message,
    ...(item.data ? { data: item.data } : {}),
  }));

  const contextPayload = {
    currentTime: new Date().toISOString(),
    cycleId,
    sessionId,
    persona: personaSummary,
    activeDesires,
    observation: {
      observedAt: observation.timestamp,
      spatialCuriosity: observation.state?.spatialCuriosity ?? null,
      state: projectSelectorState(observation.state ?? {}),
      capabilities: {
        actions: observation.capabilities.actions,
        movement: observation.capabilities.movement === true,
        visual: observation.capabilities.visual === true,
        ...(observation.capabilities.locomotion ? { locomotion: observation.capabilities.locomotion } : {}),
        ...(observation.capabilities.expressionLibrary
          ? { expressionLibrary: observation.capabilities.expressionLibrary }
          : {}),
      },
    },
    cameraEvidence: visualFrame
      ? {
          attached: true,
          frameId: visualFrame.id,
          timestamp: visualFrame.timestamp,
          ...(visualFrame.metadata ? { metadata: visualFrame.metadata } : {}),
        }
      : {
          attached: false,
          frameId: null,
          timestamp: null,
          ...(latestSeenFrame
            ? {
                lastEvaluatedFrameId: latestSeenFrame.id,
                lastEvaluatedAt: latestSeenFrame.timestamp,
              }
            : {}),
        },
    recentActionReceipts: receipts,
  };

  const envelopeText = JSON.stringify(contextPayload);
  const userContent: ProviderContentPart[] | string = visualFrame?.dataUrl
    ? [
        { type: 'text', text: envelopeText },
        { type: 'image_url', image_url: { url: visualFrame.dataUrl } },
      ]
    : envelopeText;

  const messages: RouterMessage[] = [
    { role: 'system', content: EMBODIED_CURIOSITY_SYSTEM_1_PROMPT },
    { role: 'user', content: userContent },
  ];
  const responseSchema = buildEmbodiedCuriositySystem1Schema(observation);

  const llmResponse = await withUserContext(
    { userId: user.id, username: user.username, role: user.role },
    () => callLLM({
      role: hasImage ? 'environmentVision' : 'environmentActionSelector',
      cognitiveMode: 'environment',
      userId: user.username,
      signal: input.signal,
      messages,
      options: {
        enableThinking: false,
        temperature: 0.3,
        format: 'json',
        jsonSchema: responseSchema,
      },
    }),
  );

  const parsed = parseSystem1Output(llmResponse.content, sessionId);
  if (visualFrame) {
    recordLastEvaluatedFrameId(user.username, sessionId, visualFrame.id);
  }

  const candidate = recordEmbodiedCuriosityTrainingCandidate({
    username: user.username,
    sessionId,
    cycleId,
    hasImage,
    visualFrame,
    messages,
    observedOutput: llmResponse.content.trim(),
    escalateToMind: parsed.escalateToMind,
    escalateReason: parsed.escalateReason,
  });

  if (parsed.inspectedTrackIds.length > 0) {
    try {
      await submitCoordinatorWork({
        type: 'generic',
        handler: 'environment.visual-read',
        resource: `environment-mark-inspected:${sessionId}`,
        executionScope: 'invocation',
        source: 'autonomy',
        username: user.username,
        maxAttempts: 1,
        correlationId: cycleId,
        idempotencyKey: `embodied-curiosity-mark-inspected:${cycleId}`,
        input: {
          sessionId,
          vision: {
            operation: 'markInspected',
            trackIds: parsed.inspectedTrackIds,
          },
        },
      });
    } catch {
      // Best-effort perception hint; never block physical execution.
    }
  }

  const needsAction = Boolean(parsed.program);
  const routing: EnvironmentRequestRouting = {
    needsResponse: false,
    needsAction,
    needsToolUse: false,
    taskPlanner: 'specialist',
    taskContext: hasImage ? ['environment', 'vision'] : ['environment'],
    conversationContext: [],
  };
  const route = {
    ...routing,
    ...selectedEnvironmentRoutes(routing),
    useVisionPlanner: false,
    analysis: routing,
  };

  const cycle: RobotObserverCycleMetadata = {
    cycleId,
    step: 1,
    triggerSource: 'autonomy',
    graph: environmentGraph,
    requestedBy: 'robot-autonomy-controller',
  };

  const taskObj = parsed.taskDecision;
  const plannerDecision = {
    observed: (typeof taskObj?.observationSummary === 'string' && taskObj.observationSummary.trim())
      || parsed.escalateReason
      || `Spatial curiosity observation at ${observation.timestamp}.`,
    instruction: (typeof taskObj?.objective === 'string' && taskObj.objective.trim())
      || parsed.escalateReason
      || 'Execute the selected embodied curiosity step.',
    reason: (typeof taskObj?.reason === 'string' && taskObj.reason.trim())
      || parsed.escalateReason
      || 'Selected immediate embodied curiosity action from current sensor state.',
    decidedAt: new Date().toISOString(),
  };

  const escalationMeta: EmbodiedCuriosityEscalationMeta | null = parsed.escalateToMind
    ? {
        escalateToMind: true,
        escalateReason: parsed.escalateReason!,
        inspectedTrackIds: parsed.inspectedTrackIds,
        sessionId,
        cycleId,
      }
    : null;

  const robotOperatorContext: Record<string, unknown> = {
    robotObserver: cycle,
    stimulusAgent: 'robot-autonomy-controller',
    sessionId,
    plannerDecision,
    sourceObservationAt: observation.timestamp,
    currentVisualEvidence: hasImage,
    embodiedCuriosityFiniteStep: true,
    ...(visualFrame
      ? {
          frames: [visualFrame],
          selectedContext: {
            sources: {
              vision: {
                value: { frames: [visualFrame], current: true },
                scope: { sessionId },
              },
            },
          },
        }
      : {}),
    embodiedCuriosityEscalation: escalationMeta,
  };

  const [{ loadGraphForMode }, { listFailedNodes, runGraph }] = await Promise.all([
    import('../graph-streaming.js'),
    import('../graph-runtime.js'),
  ]);
  const loaded = await loadGraphForMode(environmentGraph, user.username);
  const graphContext: Record<string, unknown> = {
    userId: user.id,
    username: user.username,
    cognitiveMode: 'environment',
    mode: 'system',
    dialogueType: 'system',
    environment: 'server',
    allowMemoryWrites: false,
    environmentObservation: visualFrame
      ? { ...observation, visual: visualFrame, visuals: [visualFrame] }
      : observation,
    environmentObservationCurrent: false,
    precomputedEnvironmentPlan: {
      route,
      response: parsed.selectorPayload,
    },
    robotOperatorContext,
    abortSignal: input.signal,
  };

  const graphState = await withUserContext(
    { userId: user.id, username: user.username, role: user.role },
    () => runGraph({
      graph: loaded.graph,
      signal: input.signal,
      context: graphContext,
    }),
  );

  const failures = listFailedNodes(graphState);
  if (graphState.status === 'failed' || graphState.error || failures.length > 0) {
    throw new Error(
      `Embodied curiosity environment execution failed: ${graphState.error?.message || failures[0]?.error || graphState.status}`,
      { cause: graphState.error },
    );
  }

  const executionId = graphState.executionId || `embodied-curiosity-${cycleId}`;
  let escalationScheduled = false;
  if (escalationMeta && physicalStepCompleted(graphState)) {
    const scheduled = await maybeScheduleEmbodiedCuriosityEscalation({
      username: user.username,
      executionId,
      context: graphContext,
      state: graphState,
    });
    escalationScheduled = scheduled.scheduled;
  }

  return {
    graphExecuted: true,
    embodiedCuriosity: true,
    executionId,
    executionStatus: graphState.status,
    sessionId,
    agentId: 'robot-autonomy-controller',
    cycle,
    candidateId: candidate.id,
    inspectedTrackIds: parsed.inspectedTrackIds,
    escalateToMind: parsed.escalateToMind,
    escalateReason: parsed.escalateReason,
    escalationScheduled,
  };
}

export async function tryRunEmbodiedCuriosityFromTrigger(options: {
  task: QueuedTask;
  config: RobotOperatorConfig;
  requestedSession?: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown> | null> {
  const username = options.task.username?.trim();
  if (!username) return null;
  const bodyConnection = readRobotOperatorBodyConnection(options.requestedSession);
  if (!bodyConnection.connected || !bodyConnection.sessionId) {
    return null;
  }
  const observation = getLatestEnvironmentObservation(bodyConnection.sessionId);
  if (!observation || observation.capabilities?.movement !== true) {
    return null;
  }
  if (getEnvironmentActionSubscriberCount(bodyConnection.sessionId) < 1) {
    return null;
  }

  const nonIdleExecutions = activeRobotExecutions(username).filter(
    item => (!item.sessionId || item.sessionId === bodyConnection.sessionId)
      && ((item.status !== 'idle' && item.waitingReason !== 'user_or_autonomy') || item.resumePending),
  );
  if (nonIdleExecutions.length > 0) {
    return {
      skipped: true,
      reason: 'active_physical_execution_in_progress',
      sessionId: bodyConnection.sessionId,
      agentId: 'robot-autonomy-controller',
    };
  }

  const operatorConfig = loadActiveOperatorConfig();
  const secondsSinceHumanInteraction = measureSecondsSinceHumanInteraction(username, observation);
  if (hasEmbodiedCuriositySettled({
    boredomInactivityMinutes: operatorConfig.boredomInactivityMinutes,
    secondsSinceHumanInteraction,
    observation,
  })) {
    return null;
  }

  const cycleId = typeof options.task.input.cycleId === 'string' && options.task.input.cycleId.trim()
    ? options.task.input.cycleId.trim()
    : options.task.correlationId?.trim()
      ? options.task.correlationId.trim()
      : randomUUID();

  const result = await runEmbodiedCuriosityCycle({
    username,
    sessionId: bodyConnection.sessionId,
    observation,
    environmentGraph: options.config.environmentGraph,
    cycleId,
    signal: options.signal,
  });
  return { ...result };
}

function resolveEscalationVisualFrame(
  username: string,
  executionId: string,
  sessionId: string,
  capturedFrameIds: string[] = [],
  observation?: EnvironmentObservation,
): EnvironmentVisualFrame | undefined {
  if (capturedFrameIds.length > 0) {
    const store = openExecutionStore(username);
    try {
      for (let index = capturedFrameIds.length - 1; index >= 0; index -= 1) {
        const frame = store.frame(executionId, capturedFrameIds[index]!);
        if (frame && validEnvironmentJpegDataUrl(frame.dataUrl)) {
          return frame;
        }
      }
    } catch {
      // Fall back to latest session visual below.
    } finally {
      store.close();
    }
  }
  if (sessionId) {
    const latest = getLatestEnvironmentVisual(sessionId);
    if (latest && validEnvironmentJpegDataUrl(latest.dataUrl)) return latest;
  }
  if (observation?.visual && validEnvironmentJpegDataUrl(observation.visual.dataUrl)) {
    return observation.visual;
  }
  return undefined;
}

function loadRecentEpisodicSummary(username: string, limit = 5): Array<Record<string, unknown>> {
  try {
    const files = listEpisodicFiles().slice(-limit);
    const records: Array<Record<string, unknown>> = [];
    for (const filePath of files) {
      try {
        const event = readCapturedEpisodicEvent(username, filePath);
        records.push({
          id: event.id,
          timestamp: event.timestamp,
          type: event.type ?? 'observation',
          content: event.content,
          tags: event.tags ?? [],
        });
      } catch {
        // Skip unreadable entries.
      }
    }
    return records;
  } catch {
    return [];
  }
}

function cleanNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function runEmbodiedCuriosityEscalation(
  input: EmbodiedCuriosityEscalationInput,
  username: string,
  signal?: AbortSignal,
): Promise<EmbodiedCuriosityEscalationResult> {
  const executionId = input.executionId?.trim();
  if (!executionId) {
    throw new Error('Embodied curiosity escalation requires executionId');
  }

  const guardKey = `${username}:${executionId}`;
  if (inFlightEscalations.has(guardKey) || readEscalationLedger(username).has(executionId)) {
    return {
      executionId,
      skipped: true,
      duplicate: true,
      observationMemoryPath: null,
      desireUpdateRecorded: false,
      spokenReplyQueued: false,
      speechTaskId: null,
      outputs: {
        observationMemory: null,
        desireUpdate: null,
        spokenReply: null,
      },
    };
  }

  inFlightEscalations.add(guardKey);
  try {
    const user = getUserByUsername(username) ?? {
      id: username,
      username,
      role: 'owner' as const,
    };

    const runWithContext = <T>(fn: () => Promise<T>): Promise<T> => (
      getUserContext()?.username === user.username
        ? fn()
        : withUserContext({ userId: user.id, username: user.username, role: user.role }, fn)
    );

    return await runWithContext(async () => {
      const observation = getLatestEnvironmentObservation(input.sessionId || undefined);
      const visualFrame = resolveEscalationVisualFrame(
        user.username,
        executionId,
        input.sessionId,
        input.capturedFrameIds,
        observation,
      );
      const hasImage = Boolean(visualFrame);

      const persona = projectStandingPersonaSummary(user.username);
      const conversationMessages = loadBufferForUser(user.username, 'conversation')
        .messages
        .slice(-6)
        .map(msg => ({
          role: msg.role,
          content: msg.content,
          timestamp: typeof msg.timestamp === 'number'
            ? new Date(msg.timestamp).toISOString()
            : msg.timestamp ?? null,
        }));
      const recentMemories = loadRecentEpisodicSummary(user.username, 5);
      const activeDesires = await loadBoundedActiveDesires(user.username, 5);

      const discoveryEnvelope = {
        currentTime: new Date().toISOString(),
        executionId,
        cycleId: input.cycleId,
        sessionId: input.sessionId,
        escalateReason: input.escalateReason,
        inspectedTrackIds: input.inspectedTrackIds ?? [],
        persona,
        discovery: {
          observedAt: observation?.timestamp ?? null,
          spatialCuriosity: observation?.state?.spatialCuriosity ?? null,
          state: observation ? projectSelectorState(observation.state ?? {}) : null,
          cameraEvidence: visualFrame
            ? {
                attached: true,
                frameId: visualFrame.id,
                timestamp: visualFrame.timestamp,
                ...(visualFrame.metadata ? { metadata: visualFrame.metadata } : {}),
              }
            : { attached: false, frameId: null, timestamp: null },
        },
        recentConversation: conversationMessages,
        memories: recentMemories,
        activeDesires,
      };

      const envelopeText = JSON.stringify(discoveryEnvelope);
      const userContent: ProviderContentPart[] | string = visualFrame?.dataUrl
        ? [
            { type: 'text', text: envelopeText },
            { type: 'image_url', image_url: { url: visualFrame.dataUrl } },
          ]
        : envelopeText;

      const llmResponse = await callLLM({
        role: hasImage ? 'environmentVision' : 'persona',
        cognitiveMode: 'environment',
        userId: user.username,
        signal,
        messages: [
          { role: 'system', content: EMBODIED_CURIOSITY_SYSTEM_2_PROMPT },
          { role: 'user', content: userContent },
        ],
        options: {
          enableThinking: false,
          temperature: 0.6,
          format: 'json',
          jsonSchema: EMBODIED_CURIOSITY_SYSTEM_2_SCHEMA,
        },
      });

      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(llmResponse.content.trim());
      } catch {
        throw new Error('Embodied curiosity System 2 output is not valid JSON');
      }
      if (!isRecord(parsedRaw)) {
        throw new Error('Embodied curiosity System 2 output must be a JSON object');
      }

      const observationMemory = cleanNullableString(parsedRaw.observationMemory);
      const desireUpdate = cleanNullableString(parsedRaw.desireUpdate);
      const spokenReply = cleanNullableString(parsedRaw.spokenReply);
      const observationTimestamp = observation?.timestamp || new Date().toISOString();

      let observationMemoryPath: string | null = null;
      if (observationMemory) {
        observationMemoryPath = captureEvent(observationMemory, {
          type: 'observation',
          timestamp: observationTimestamp,
          idempotencyKey: `embodied-curiosity-memory:${executionId}`,
          tags: ['embodied-curiosity', 'spatial-discovery'],
          metadata: {
            source: 'embodied-curiosity',
            sessionId: input.sessionId,
            cycleId: input.cycleId,
            executionId,
            observationTimestamp,
          },
        });
      }

      let desireUpdateRecorded = false;
      if (desireUpdate) {
        desireUpdateRecorded = await appendToBuffer(user.username, 'inner', {
          role: 'reflection',
          content: desireUpdate,
          timestamp: Date.now(),
          meta: {
            isInnerDialogue: true,
            originalRole: 'reflection',
            source: 'autonomy',
            dialogueSource: 'embodied-curiosity',
            tags: ['autonomy', 'embodied-curiosity', 'desire-seed'],
            correlationId: input.cycleId,
            executionId,
            idempotencyKey: `embodied-curiosity-desire:${executionId}`,
          },
        });
      }

      let spokenReplyQueued = false;
      let speechTaskId: string | null = null;
      if (spokenReply) {
        await appendToBuffer(user.username, 'conversation', {
          role: 'assistant',
          content: spokenReply,
          timestamp: Date.now(),
          meta: {
            source: 'autonomy',
            dialogueSource: 'embodied-curiosity',
            correlationId: input.cycleId,
            executionId,
            idempotencyKey: `embodied-curiosity-reply:${executionId}`,
          },
        });

        if (!getSpeechOutputSettings(user.username).speechDisabled) {
          const { loadGraphForMode } = await import('../graph-streaming.js');
          const loadedSpeech = await loadGraphForMode('robot-speech', user.username);
          const speechTask = await submitCoordinatorWork({
            type: 'generic',
            handler: 'tts.robot-speech',
            resource: 'robot-speech-render',
            executionScope: 'invocation',
            source: 'autonomy',
            username: user.username,
            maxAttempts: 1,
            correlationId: input.cycleId,
            idempotencyKey: `embodied-curiosity-speech:${executionId}`,
            input: {
              text: spokenReply,
              sessionId: input.sessionId || undefined,
              requestId: `embodied-curiosity-speech:${executionId}`,
              graph: loadedSpeech.graph,
            },
          });
          spokenReplyQueued = true;
          speechTaskId = speechTask.id;
        }
      }

      recordEscalatedExecution(user.username, executionId);

      return {
        executionId,
        observationMemoryPath,
        desireUpdateRecorded,
        spokenReplyQueued,
        speechTaskId,
        outputs: {
          observationMemory,
          desireUpdate,
          spokenReply,
        },
      };
    });
  } finally {
    inFlightEscalations.delete(guardKey);
  }
}
