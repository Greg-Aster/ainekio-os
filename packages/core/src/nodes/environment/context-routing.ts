/** Context selection shared by interactive requests and delegated autonomy intentions. */
export const ENVIRONMENT_CONTEXT_ENTRIES = [
  'persona.identity', 'persona.background', 'persona.personality', 'persona.values', 'persona.goals',
  'conversationHistory', 'memory', 'robotStatus', 'environment', 'vision', 'executionContext',
] as const;

type EnvironmentContextEntry = typeof ENVIRONMENT_CONTEXT_ENTRIES[number];
export interface EnvironmentRequestRouting {
  needsResponse: boolean;
  needsAction: boolean;
  needsGoalReview?: boolean;
  needsToolUse?: boolean;
  taskPlanner?: 'specialist' | 'vision';
  taskContext: EnvironmentContextEntry[];
  conversationContext: EnvironmentContextEntry[];
  memoryQuery?: string;
  memoryTypes?: string[];
  memoryOrder?: 'relevance' | 'newest';
  memoryTimeRange?: { from?: string; before?: string };
  memorySleepCycle?: 'latest';
}

export function selectedEnvironmentRoutes(
  routing: Record<string, any>,
  consumer?: 'task' | 'conversation',
): Record<string, boolean> {
  if (!Array.isArray(routing.taskContext) || !Array.isArray(routing.conversationContext)) {
    return Object.fromEntries(Object.entries(routing).filter(([, value]) => typeof value === 'boolean'));
  }
  const selected: string[] = consumer ? routing[`${consumer}Context`] : [...routing.taskContext, ...routing.conversationContext];
  return {
    needsResponse: routing.needsResponse,
    needsAction: routing.needsAction,
    needsGoalReview: routing.needsGoalReview === true,
    ...(routing.needsToolUse !== undefined ? { needsToolUse: routing.needsToolUse } : {}),
    needsPersona: selected.some(entry => entry.startsWith('persona.')),
    needsConversationHistory: selected.includes('conversationHistory'),
    needsMemory: selected.includes('memory'),
    needsRobotStatus: selected.includes('robotStatus'),
    needsEnvironment: selected.includes('environment'),
    needsVision: selected.includes('vision'),
    needsExecutionContext: selected.includes('executionContext'),
  };
}

/** Read a source already supplied on this attributed handoff, never an installation-wide cache. */
export function suppliedContextSource(packet: any, source: string, scope: Record<string, unknown>) {
  const selected = packet?.sources?.[source];
  if (!selected || !Object.prototype.hasOwnProperty.call(selected, 'value')) return undefined;
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize(selected.scope)) === JSON.stringify(normalize(scope)) ? selected.value : undefined;
}
