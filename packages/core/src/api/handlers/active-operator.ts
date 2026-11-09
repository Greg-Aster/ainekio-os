/**
 * Active Operator API Handlers
 *
 * Unified handlers for active operator status, configuration and control.
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { audit } from '../../audit.js';
import { getModeController, loadActiveOperatorConfig, updateActiveOperatorConfig } from '../../active-operator/index.js';
import { getQueueManager } from '../../queue/index.js';
import type { AutonomyMode } from '../../queue/types.js';
import { isRobotAutonomyWorkItem, readRobotOperatorRuntimeState } from '../../robot-operator.js';

type ControlAction = 'start' | 'stop' | 'set-mode' | 'emergency-stop' | 'reset';

function jsonError(error: unknown): UnifiedResponse {
  return {
    status: 500,
    error: (error as Error).message,
  };
}

function authRequired(): UnifiedResponse {
  return {
    status: 401,
    error: 'Authentication required',
  };
}

/**
 * GET /api/active-operator/status
 */
export async function readActiveOperatorStatus(username?: string, includeConfiguration = false) {
  const controller = getModeController();
  const modeStatus = controller.getStatus();
  const manager = getQueueManager();
  const activeWork = manager.getAllTasks();
  const allWork = [...activeWork, ...manager.getHistory()];
  const autonomyEpisodes = allWork
    .filter(task => task.handler.startsWith('workflow.') && isRobotAutonomyWorkItem(task))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 12)
    .map(task => {
      const child = task.metadata?.childAgent || task.input?.agentId || task.handler.slice('workflow.'.length);
      const cycleId = typeof task.result?.cycle?.cycleId === 'string'
        ? task.result.cycle.cycleId
        : typeof task.input?.cycleId === 'string'
          ? task.input.cycleId
          : task.correlationId;
      const related = allWork
        .filter(candidate => candidate.id !== task.id && (
          candidate.parentTaskId === task.id
          || Boolean(cycleId && candidate.correlationId === cycleId)
        ))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const activeRelated = related.find(candidate => ['queued', 'leased', 'waiting'].includes(candidate.state));
      const failedRelated = related.find(candidate => candidate.state === 'failed' || candidate.state === 'cancelled');
      const latestRelated = related[0];
      const state = activeRelated?.state || failedRelated?.state || latestRelated?.state || task.state;
      const outcome = task.error?.message
        || task.result?.reason
        || failedRelated?.error?.message
        || failedRelated?.cancellationReason
        || (activeRelated ? `${activeRelated.handler} ${activeRelated.state}` : undefined)
        || (latestRelated ? `completed through ${latestRelated.handler}` : undefined)
        || (task.result?.queued ? 'stimulus queued' : task.state);
      return {
        id: task.id,
        child,
        handler: task.handler,
        state,
        source: task.source,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        downstreamCount: related.length,
        outcome: typeof outcome === 'string' ? outcome.slice(0, 500) : task.state,
      };
    });

  let operations: unknown[] = []
  let assessments: unknown[] = []
  if (username) {
    const [{ robotAutonomyTaskCatalogNode }, { readActivationAssessments }, { loadGraphForMode }, { loadRobotOperatorConfig }] = await Promise.all([
      import('../../nodes/robot-operator/task-catalog.node.js'), import('../../active-operator/activation-history.js'),
      import('../../graph-streaming.js'), import('../../robot-operator.js'),
    ])
    const loaded = await loadGraphForMode(loadRobotOperatorConfig().robotAutonomyControllerGraph, username)
    const catalogNode = loaded.graph.nodes.find(node => node.data.nodeType === 'robot_autonomy_task_catalog')
    const catalog = await robotAutonomyTaskCatalogNode.execute({}, { username },
      { ...catalogNode?.data.properties, includeActivityHistory: true })
    operations = catalog.activationState.operations
    assessments = await readActivationAssessments(username, 12)
  }
  return {
    ...(includeConfiguration ? { configuration: loadActiveOperatorConfig() } : {}),
    operations, assessments,
    mode: modeStatus.mode,
    isExecuting: modeStatus.isExecuting,
    currentTask: modeStatus.currentTask || null,
    health: modeStatus.health,
    healthMessage: modeStatus.healthMessage,
    robotOperator: {
      runtime: readRobotOperatorRuntimeState(),
      episodes: autonomyEpisodes,
    },
    queue: {
      length: activeWork.length,
      tasks: activeWork.slice(0, 10).map(task => ({
        id: task.id,
        type: task.type,
        handler: task.handler,
        state: task.state,
        priority: task.priority,
        source: task.source,
        createdAt: task.createdAt,
      })),
      hasUserMessages: activeWork.some(task => task.type === 'user_message'),
    },
  };
}

export async function handleGetActiveOperatorStatus(req?: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    return { status: 200, data: await readActiveOperatorStatus(req?.user.username, req?.user.role === 'owner') };
  } catch (error) {
    console.error('[active-operator/status] GET error:', error);
    return jsonError(error);
  }
}

/**
 * GET /api/active-operator/config
 */
export async function handleGetActiveOperatorConfig(): Promise<UnifiedResponse> {
  try {
    return {
      status: 200,
      data: loadActiveOperatorConfig(),
    };
  } catch (error) {
    console.error('[active-operator/config] GET error:', error);
    return jsonError(error);
  }
}

/**
 * POST /api/active-operator/config
 */
export async function handleUpdateActiveOperatorConfig(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    if (!req.user.isAuthenticated) {
      return authRequired();
    }

    if (req.user.role !== 'owner') {
      return {
        status: 403,
        error: 'Only owner can modify active operator config',
      };
    }

    const input = { ...(req.body || {}) };
    const body = {
      ...(input.autonomyMode !== undefined ? { autonomyMode: input.autonomyMode } : {}),
      ...(input.semiAssessmentMinutes !== undefined ? { semiAssessmentMinutes: input.semiAssessmentMinutes } : {}),
    };
    const requestedMode = body.autonomyMode as AutonomyMode | undefined;
    if (requestedMode && !['reactive', 'semi', 'full'].includes(requestedMode)) {
      return { status: 400, error: 'autonomyMode must be reactive, semi, or full' };
    }
    if (body.semiAssessmentMinutes !== undefined && (typeof body.semiAssessmentMinutes !== 'number'
      || !Number.isFinite(body.semiAssessmentMinutes) || body.semiAssessmentMinutes <= 0)) {
      return { status: 400, error: 'semiAssessmentMinutes must be a positive number' };
    }
    const config = updateActiveOperatorConfig(body);
    if (requestedMode) await getModeController().setMode(requestedMode, req.user.username);

    return {
      status: 200,
      data: { ...config, autonomyMode: getModeController().mode },
    };
  } catch (error) {
    console.error('[active-operator/config] POST error:', error);
    return jsonError(error);
  }
}

/**
 * POST /api/active-operator/control
 */
export async function handleActiveOperatorControl(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    if (!req.user.isAuthenticated) {
      return authRequired();
    }

    if (req.user.role !== 'owner') {
      return {
        status: 403,
        error: 'Only owner can control active operator',
      };
    }

    const body = req.body || {};
    const action = body.action as ControlAction;

    if (!action || !['start', 'stop', 'set-mode', 'emergency-stop', 'reset'].includes(action)) {
      return {
        status: 400,
        error: 'Invalid action. Use: start, stop, set-mode, emergency-stop, reset',
      };
    }

    let result: { success: boolean; mode: string; message: string };
    const controller = getModeController();

    switch (action) {
      case 'start': {
        await controller.setMode('full', req.user.username);
        result = {
          success: true,
          mode: 'full',
          message: 'Full autonomy enabled',
        };
        break;
      }

      case 'stop': {
        await controller.setMode('reactive', req.user.username);
        result = {
          success: true,
          mode: 'reactive',
          message: 'Reactive mode enabled',
        };
        break;
      }

      case 'set-mode': {
        const mode = body.mode as AutonomyMode;
        if (!['reactive', 'semi', 'full'].includes(mode)) {
          return { status: 400, error: 'mode must be reactive, semi, or full' };
        }
        await controller.setMode(mode, req.user.username);
        result = { success: true, mode, message: `${mode} mode enabled` };
        break;
      }

      case 'emergency-stop': {
        await controller.emergencyStop(req.user.username);
        result = {
          success: true,
          mode: 'reactive',
          message: 'Active Operator emergency stopped',
        };
        break;
      }

      case 'reset': {
        await controller.reset(req.user.username);
        result = {
          success: true,
          mode: 'reactive',
          message: 'Active Operator reset to initial state',
        };
        break;
      }

      default:
        result = {
          success: false,
          mode: 'reactive',
          message: 'Unknown action',
        };
    }

    audit({
      category: 'system',
      level: 'info',
      event: 'active_operator_control',
      actor: req.user.username,
      details: {
        action,
        result: result.mode,
        message: result.message,
      },
    });

    return {
      status: 200,
      data: result,
    };
  } catch (error) {
    console.error('[active-operator/control] POST error:', error);
    return jsonError(error);
  }
}
