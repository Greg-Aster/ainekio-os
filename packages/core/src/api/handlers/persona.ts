/**
 * Persona Handlers
 *
 * Unified handlers for persona data access.
 * Core persona access for onboarding and profile clients.
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { loadPersonaCore, savePersonaCore } from '../../identity.js';
import { reconcilePersonaLearningProvenance } from '../../persona-learning.js';

/**
 * GET /api/persona-core - Get core persona data
 */
export async function handleGetPersonaCore(req: UnifiedRequest): Promise<UnifiedResponse> {
  if (!req.user.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }

  try {
    const core = loadPersonaCore(req.user.username);
    return successResponse({ success: true, persona: core });
  } catch (error) {
    console.error('[persona-core] Error loading core:', error);
    return { status: 500, error: 'Failed to load persona core' };
  }
}

/**
 * Helper to sanitize array inputs
 */
function sanitizeArray(input: any, separator = ','): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input.split(separator).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

/**
 * POST /api/persona-core - Update core persona data
 */
export async function handleUpdatePersonaCore(req: UnifiedRequest): Promise<UnifiedResponse> {
  if (!req.user.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }

  const { body } = req;
  if (!body) {
    return { status: 400, error: 'Request body is required' };
  }

  try {
    const previous = loadPersonaCore(req.user.username);
    const persona = structuredClone(previous);

    // Update identity section
    if (body.identity) {
      const identity = { ...persona.identity } as typeof persona.identity & { avatar?: string };
      const payload = body.identity;
      if (typeof payload.name === 'string') identity.name = payload.name.trim();
      if (typeof payload.role === 'string') identity.role = payload.role.trim();
      if (typeof payload.purpose === 'string') identity.purpose = payload.purpose.trim();
      if (typeof payload.humanName === 'string') identity.humanName = payload.humanName.trim();
      if (typeof payload.email === 'string') identity.email = payload.email.trim();
      if (typeof payload.avatar === 'string') identity.avatar = payload.avatar.trim();
      if (payload.aliases !== undefined) identity.aliases = sanitizeArray(payload.aliases);
      persona.identity = identity;
    }

    // Update personality section
    if (body.personality) {
      persona.personality = persona.personality || {};
      if (body.personality.communicationStyle) {
        // This endpoint retains partial communication-style edits for existing profiles.
        const current: Partial<NonNullable<typeof persona.personality.communicationStyle>> = { ...persona.personality.communicationStyle };
        const cs = body.personality.communicationStyle;
        if (cs.tone !== undefined) current.tone = sanitizeArray(cs.tone);
        if (typeof cs.humor === 'string') current.humor = cs.humor.trim();
        if (typeof cs.formality === 'string') current.formality = cs.formality.trim();
        if (typeof cs.verbosity === 'string') current.verbosity = cs.verbosity.trim();
        persona.personality.communicationStyle = current as typeof persona.personality.communicationStyle;
      }
      if (body.personality.narrativeStyle !== undefined) {
        persona.personality.narrativeStyle = String(body.personality.narrativeStyle || '').trim();
      }
    }

    // Update values section
    if (body.values) {
      persona.values = persona.values || {};
      if (body.values.boundaries !== undefined) {
        persona.values.boundaries = sanitizeArray(body.values.boundaries, '\n');
      }
    }

    // Update goals section
    if (body.goals) {
      persona.goals = persona.goals || {};
      const goalsPayload = body.goals;

      // Handle shortTerm goals (array of strings or objects)
      if (goalsPayload.shortTerm !== undefined) {
        persona.goals.shortTerm = Array.isArray(goalsPayload.shortTerm)
          ? goalsPayload.shortTerm.map((g: string | { goal: string }) =>
              typeof g === 'string' ? { goal: g, status: 'active' } : g
            )
          : [];
      }

      // Handle midTerm goals
      if (goalsPayload.midTerm !== undefined) {
        persona.goals.midTerm = Array.isArray(goalsPayload.midTerm)
          ? goalsPayload.midTerm.map((g: string | { goal: string }) =>
              typeof g === 'string' ? { goal: g, status: 'planning' } : g
            )
          : [];
      }

      // Handle longTerm goals
      if (goalsPayload.longTerm !== undefined) {
        persona.goals.longTerm = Array.isArray(goalsPayload.longTerm)
          ? goalsPayload.longTerm.map((g: string | { goal: string }) =>
              typeof g === 'string' ? { goal: g, status: 'aspirational' } : g
            )
          : [];
      }
    }

    const updated = reconcilePersonaLearningProvenance(previous, persona);
    savePersonaCore(updated, new Date(), req.user.username);

    return successResponse({ success: true, persona: updated });
  } catch (error) {
    console.error('[persona-core] Error updating core:', error);
    return { status: 500, error: 'Failed to update persona core' };
  }
}
