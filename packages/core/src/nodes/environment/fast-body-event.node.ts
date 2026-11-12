import { openExecutionStore } from '../../durable-execution/storage.js'
import type { DispatchRecord } from '../../durable-execution/types.js'
import { defineNode, NodeInputValidationError } from '../types.js'
import { fastBodyEventContextSchema, fastBodyEventResponseSchema } from './fast-body-event.schemas.js'

export interface FastBodyReactionHistoryEntry {
  eventKind: string
  speech: string
  timestamp: string
}

function recentReactionLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(20, Math.trunc(parsed))) : 6
}

function extractFastReactionSpeech(dispatches: DispatchRecord[]): { speech: string; timestamp?: number } | null {
  for (const effect of dispatches) {
    if (effect.status === 'cancelled') continue
    if (effect.kind === 'conversation_feed') {
      const payload = effect.payload as { content?: unknown; timestamp?: unknown } | null
      if (typeof payload?.content === 'string' && payload.content.trim()) {
        return { speech: payload.content, ...(typeof payload.timestamp === 'number' ? { timestamp: payload.timestamp } : {}) }
      }
    }
    if (effect.kind === 'local_tts') {
      const payload = effect.payload as { text?: unknown } | null
      if (typeof payload?.text === 'string' && payload.text.trim()) return { speech: payload.text }
    }
    if (effect.kind === 'coordinator_work') {
      const payload = effect.payload as { handler?: unknown; input?: { text?: unknown } } | null
      if (payload?.handler === 'tts.robot-speech' && typeof payload.input?.text === 'string' && payload.input.text.trim()) {
        return { speech: payload.input.text }
      }
    }
  }
  return null
}

function readRecentFastBodyReactions(username: string, limit: number, currentExecutionId?: string): FastBodyReactionHistoryEntry[] {
  if (!username || limit <= 0) return []
  const store = openExecutionStore(username)
  try {
    const reactions: FastBodyReactionHistoryEntry[] = []
    for (const record of store.iterateNodeExecutions(username, 'fast_body_event_response', true)) {
      if (record.executionId === currentExecutionId || record.cancelledAt !== null) continue
      const extracted = extractFastReactionSpeech(store.dispatches(record.executionId))
      if (!extracted) continue
      const recordedKind = store.entryOrNull(record.executionId, ['context', 'environmentObservation', 'state', 'bodyEvent', 'data', 'kind'])
      const recordedObservationAt = store.entryOrNull(record.executionId, ['context', 'environmentObservation', 'timestamp'])
      reactions.push({
        eventKind: typeof recordedKind === 'string' && recordedKind ? recordedKind : 'unknown',
        speech: extracted.speech,
        timestamp: typeof recordedObservationAt === 'string' && recordedObservationAt
          ? recordedObservationAt
          : new Date(extracted.timestamp ?? record.createdAt).toISOString(),
      })
      if (reactions.length >= limit) break
    }
    return reactions.reverse()
  } finally { store.close() }
}

export const fastBodyEventContextNode = defineNode({
  ...fastBodyEventContextSchema,
  async execute(_inputs, context, properties) {
    const observation = context.environmentObservation
    const event = observation?.state?.bodyEvent
    if (!event) throw new Error('Fast Body Event Context requires an attributed body event')
    const kind = event.data?.kind
    const prompts: Record<string, unknown> = {
      tipped: properties?.tippedPrompt,
      rapid_movement: properties?.rapidMovementPrompt,
      servo_stall: properties?.motorStallPrompt,
    }
    const systemPrompt = prompts[kind]
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      throw new Error('Fast Body Event Context requires its reaction prompt')
    }
    const username = typeof context.username === 'string' ? context.username.trim() : ''
    const recentReactions = readRecentFastBodyReactions(
      username, recentReactionLimit(properties?.recentReactionLimit), context.graphExecution?.executionId)
    return {
      event,
      eventKind: kind,
      sessionId: observation.sessionId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ eventKind: kind,
          ...(kind === 'servo_stall' ? {
            joints: event.data.joints,
            reason: event.data.reason,
            outputs_released: event.data.outputs_released,
            correction_failed: event.data.correction_failed,
            release_error: event.data.release_error,
          } : {}),
          ...(recentReactions.length ? { recentReactions } : {}),
        }) },
      ],
      jsonSchema: {
        type: 'object', additionalProperties: false, required: ['speech'],
        properties: { speech: { type: 'string' } },
      },
    }
  },
})

export const fastBodyEventResponseNode = defineNode({
  ...fastBodyEventResponseSchema,
  async execute(inputs) {
    let response
    try { response = JSON.parse(inputs.response) }
    catch { throw new NodeInputValidationError('response', 'Body reaction must be JSON') }
    if (!response || typeof response.speech !== 'string') {
      throw new NodeInputValidationError('response', 'Body reaction requires speech')
    }
    return { speech: response.speech }
  },
})
