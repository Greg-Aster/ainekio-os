/**
 * Memory Policy Module
 *
 * Memory capture and tool-output visibility policy for cognitive modes and user roles.
 * Graph context nodes own retrieval and context assembly.
 */

import { getModeDefinition, type CognitiveModeId } from './cognitive-mode.js';

// ============================================================================
// User Roles
// ============================================================================

export type UserRole = 'owner' | 'standard' | 'guest' | 'anonymous';

// ============================================================================
// Event Types
// ============================================================================

export type EventType =
  | 'conversation'
  | 'inner_dialogue'
  | 'tool_invocation'
  | 'file_read'
  | 'file_write'
  | 'summary'
  | 'observation'
  | 'reflection'
  | 'dream'
  | 'daydream'
  | 'task'
  | 'operator_feedback';  // Human-in-the-loop approval/rejection feedback for training

// ============================================================================
// Memory Write Policy
// ============================================================================

/**
 * Determines if memory writes are allowed for a given cognitive mode and event type.
 *
 * Policy Rules:
 * - Dual Mode: All events can be written (full memory capture)
 * - Agent Mode: Only action-oriented events (tool invocations, approvals, summaries)
 * - Environment Mode: Conversational exchanges and summaries
 * - Emulation Mode: No writes allowed (read-only)
 *
 * @param mode - Current cognitive mode
 * @param eventType - Type of event being captured
 * @returns true if memory write is allowed, false otherwise
 */
export function canWriteMemory(mode: CognitiveModeId, eventType: EventType): boolean {
  const modeConfig = getModeDefinition(mode);
  const writeLevel = modeConfig.defaults.memoryWriteLevel;

  // Emulation mode: read-only (no writes)
  if (writeLevel === 'read_only') {
    return false;
  }

  if (writeLevel === 'conversation') {
    const allowedEvents: EventType[] = [
      'conversation',
      'summary',
    ];
    return allowedEvents.includes(eventType);
  }

  // Agent mode: command_only (selective writes)
  if (writeLevel === 'command_only') {
    // Allow only action-oriented events
    const allowedEvents: EventType[] = [
      'tool_invocation',
      'summary',
      'file_write', // Write operations are actions
    ];
    return allowedEvents.includes(eventType);
  }

  // Dual mode: full writes
  return true;
}

export const MemoryPolicy = {
  canWriteMemory,
};
