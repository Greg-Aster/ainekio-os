/**
 * Project Management API Handlers
 *
 * Endpoints for managing projects (task containers with goals).
 *
 * POST /api/projects - Create a new project
 * GET /api/projects - List all projects
 * GET /api/projects/:id - Get project details with tasks
 * GET /api/tasks/actionable - Tasks with no incomplete dependencies
 * GET /api/tasks/blocked - Tasks and their incomplete dependencies
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse, errorResponse, badRequestResponse } from '../types.js';
import {
  createProject,
  getProject,
  listProjects,
  getProjectTasks,
  getBlockingDependencies,
  getActionableTasks,
  getBlockedTasks,
} from '../../memory.js';
import { audit } from '../../audit.js';

/**
 * POST /api/projects
 * Create a new project
 */
export async function handleCreateProject(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const body = req.body as {
      title: string;
      description?: string;
      priority?: string;
      targetDate?: string;
      tags?: string[];
      source?: string;
      sourceId?: string;
    };

    if (!body.title) {
      return badRequestResponse('title is required');
    }

    const projectId = createProject(body.title, {
      description: body.description,
      priority: body.priority,
      targetDate: body.targetDate,
      tags: body.tags,
      source: body.source,
      sourceId: body.sourceId,
    });

    audit({
      category: 'data_change',
      level: 'info',
      event: 'project_created',
      actor: req.user.username,
      details: {
        projectId,
        title: body.title,
        source: body.source,
      },
    });

    const project = getProject(projectId);

    return successResponse({
      success: true,
      project,
    });
  } catch (error) {
    return errorResponse((error as Error).message, 500);
  }
}

/**
 * GET /api/projects
 * List all projects
 */
export async function handleListProjects(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const includeArchived = req.query?.includeArchived === 'true';
    const projects = listProjects(includeArchived);

    return successResponse({
      success: true,
      projects,
      count: projects.length,
    });
  } catch (error) {
    return errorResponse((error as Error).message, 500);
  }
}

/**
 * GET /api/projects/:id
 * Get project details with tasks
 */
export async function handleGetProject(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const projectId = req.params?.id;
    if (!projectId) {
      return badRequestResponse('project ID is required');
    }

    const project = getProject(projectId);
    if (!project) {
      return errorResponse('Project not found', 404);
    }

    const tasks = getProjectTasks(projectId);

    // Calculate task statistics
    const stats = {
      total: tasks.length,
      todo: tasks.filter((t) => t.status === 'todo').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      done: tasks.filter((t) => t.status === 'done').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    };

    return successResponse({
      success: true,
      project,
      tasks,
      stats,
    });
  } catch (error) {
    return errorResponse((error as Error).message, 500);
  }
}

/**
 * GET /api/tasks/actionable
 * Get tasks that are ready to work on (no blocking dependencies)
 */
export async function handleGetActionableTasks(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const tasks = getActionableTasks();

    return successResponse({
      success: true,
      tasks,
      count: tasks.length,
    });
  } catch (error) {
    return errorResponse((error as Error).message, 500);
  }
}

/**
 * GET /api/tasks/blocked
 * Get tasks that are blocked by dependencies
 */
export async function handleGetBlockedTasks(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const blocked = getBlockedTasks();

    // Include blocking dependency info
    const tasksWithBlockers = blocked.map((task) => ({
      ...task,
      blockedBy: getBlockingDependencies(task).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    }));

    return successResponse({
      success: true,
      tasks: tasksWithBlockers,
      count: tasksWithBlockers.length,
    });
  } catch (error) {
    return errorResponse((error as Error).message, 500);
  }
}
