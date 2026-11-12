export const fastBodyEventContextSchema = {
  id: 'fast_body_event_context', name: 'Fast Body Event Context', category: 'environment' as const,
  inputs: [],
  outputs: [
    { name: 'event', type: 'object' as const },
    { name: 'eventKind', type: 'string' as const },
    { name: 'messages', type: 'array' as const },
    { name: 'jsonSchema', type: 'object' as const },
    { name: 'sessionId', type: 'string' as const },
  ],
  properties: { tippedPrompt: '', rapidMovementPrompt: '', motorStallPrompt: '', recentReactionLimit: 6 },
  propertySchemas: {
    tippedPrompt: { type: 'text_multiline' as const, default: '', label: 'Tipping Prompt', rows: 8 },
    rapidMovementPrompt: { type: 'text_multiline' as const, default: '', label: 'Rapid Movement Prompt', rows: 8 },
    motorStallPrompt: { type: 'text_multiline' as const, default: '', label: 'Motor Stall Prompt', rows: 8 },
    recentReactionLimit: {
      type: 'number' as const, default: 6, label: 'Recent Reaction Limit',
      description: 'Maximum recent Fast Body Event speech reactions supplied to this call. 0 omits prior reactions.',
      min: 0, max: 20, step: 1,
    },
  },
  description: 'Supplies the reported event kind, relevant event details and an editable prompt for speech, preserving the original event as evidence.',
}

export const fastBodyEventResponseSchema = {
  id: 'fast_body_event_response', name: 'Fast Body Event Response', category: 'environment' as const,
  inputs: [{ name: 'response', type: 'string' as const }],
  outputs: [
    { name: 'speech', type: 'string' as const },
  ],
  properties: {},
  description: 'Parses the model-selected speech for delivery through the existing output owners.',
}
