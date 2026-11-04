import { defineNode, NodeInputValidationError } from '../types.js'
import { selectActivatedOperations, type ActivationAssessment, type ActivationUpdate, type AutonomyTarget, type AutonomyMemoryRequest } from '../../active-operator/activation.js'
import type { AutonomyMode } from '../../queue/types.js'
import { ENVIRONMENT_REQUEST_INTENT_JSON_SCHEMA, parseEnvironmentIntentRouting } from '../llm/orchestrator-llm.node.js'

const targetSchema = { anyOf: [
  { type: 'null' },
  { type: 'object', additionalProperties: false, required: ['kind', 'executionId'],
    properties: { kind: { const: 'execution' }, executionId: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'desireId', 'operation'],
    properties: { kind: { const: 'desire' }, desireId: { type: 'string' },
      operation: { type: 'string', enum: ['plan', 'execute', 'review', 'checkin'] } } },
] }
const memoryFields = ['memoryQuery', 'memoryOrder', 'memoryTypes', 'memoryTimeRange', 'memorySleepCycle'] as const

export function buildRobotAutonomyControllerJsonSchema(tasks: Array<{ id: string }>, mode: AutonomyMode = 'semi',
  previous: ActivationAssessment['levels'] = {}) {
  const full = mode === 'full'
  const updateProperties = {
    operationId: { type: 'string', enum: tasks.map(task => task.id) },
    ...(full ? { activation: { type: 'number', minimum: 0, maximum: 100 } }
      : { delta: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'number', exclusiveMaximum: 0 }] } }),
    reason: { type: 'string' }, instruction: { type: 'string' },
  }
  const update = (target?: object, operationId?: string) => ({
    type: 'object', additionalProperties: false,
    required: ['operationId', full ? 'activation' : 'delta', 'reason', 'instruction', ...(full ? ['target'] : [])],
    properties: { ...updateProperties, ...(operationId ? { operationId: { const: operationId } } : {}),
      ...(!full && operationId && (previous[operationId]?.activation ?? 0) === 0
        ? { delta: { type: 'number', exclusiveMinimum: 0 } } : {}),
      ...(target ? { target } : {}) },
  })
  const fullUpdates = [update({ type: 'null' })]
  if (tasks.some(task => task.id === 'robot-autonomy-executor')) fullUpdates.push(update(targetSchema.anyOf[1], 'robot-autonomy-executor'))
  if (tasks.some(task => task.id === 'desire-agent')) fullUpdates.push(update(targetSchema.anyOf[2], 'desire-agent'))
  return {
    type: 'object', additionalProperties: false,
    required: full ? ['updates', 'assessmentReason', 'memoryRequest'] : ['updates'],
    properties: {
      updates: { type: 'array', minItems: 1, items: { anyOf: full ? fullUpdates : tasks.map(task => update(undefined, task.id)) },
        ...(full ? { contains: { type: 'object', required: ['activation'],
          properties: { activation: { type: 'number', exclusiveMinimum: 0 } } } } : {}) },
      ...(full ? {
        assessmentReason: { type: 'string', minLength: 1 },
        memoryRequest: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
          properties: Object.fromEntries(memoryFields.map(field =>
            [field, ENVIRONMENT_REQUEST_INTENT_JSON_SCHEMA.properties[field]])) }] },
      } : {}),
    },
  }
}

function fail(message: string): never {
  throw new NodeInputValidationError('response', message)
}
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactFields(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}
function parseTarget(value: unknown): AutonomyTarget | null {
  if (value === null) return null
  if (isRecord(value) && value.kind === 'execution' && exactFields(value, ['kind', 'executionId'])
    && typeof value.executionId === 'string' && value.executionId.trim()) return value as AutonomyTarget
  if (isRecord(value) && value.kind === 'desire' && exactFields(value, ['kind', 'desireId', 'operation'])
    && typeof value.desireId === 'string' && value.desireId.trim()
    && ['plan', 'execute', 'review', 'checkin'].includes(value.operation)) return value as AutonomyTarget
  return fail('Activation target must identify an execution, a Desire operation, or null')
}

function parseAssessment(value: unknown, operations: Array<{ id: string }>, mode: AutonomyMode,
  previous: ActivationAssessment['levels'] = {}) {
  const raw = typeof value === 'string' ? value : (value as { content?: string })?.content
  let parsed: any
  try { parsed = JSON.parse(raw ?? '') } catch { return fail('Activation assessment is not JSON') }
  const full = mode === 'full'
  if (!isRecord(parsed) || !exactFields(parsed, full ? ['updates', 'assessmentReason', 'memoryRequest'] : ['updates'])
    || !Array.isArray(parsed.updates)) return fail('Activation assessment does not match its mode contract')
  if (full && (typeof parsed.assessmentReason !== 'string' || !parsed.assessmentReason.trim())) {
    return fail('Full activation assessment requires a nonempty assessment reason')
  }
  if (!full && parsed.updates.length === 0) return fail('Semi activation assessment requires at least one nonzero adjustment')
  const currentLevels = new Map(Object.entries(previous).map(([id, entry]) => [id, entry.activation]))
  const updates: ActivationUpdate[] = parsed.updates.map((update: any) => {
    const field = full ? 'activation' : 'delta'
    if (!isRecord(update) || !exactFields(update, [field, 'instruction', 'operationId', 'reason', ...(full ? ['target'] : [])])
      || !operations.some(operation => operation.id === update.operationId)
      || typeof update[field] !== 'number' || !Number.isFinite(update[field])
      || (full ? update.activation < 0 || update.activation > 100 : update.delta === 0)
      || typeof update.reason !== 'string' || typeof update.instruction !== 'string') {
      return fail('Activation update does not match the supplied operation contract')
    }
    const target = full ? parseTarget(update.target) : undefined
    if (target?.kind === 'execution' && update.operationId !== 'robot-autonomy-executor'
      || target?.kind === 'desire' && update.operationId !== 'desire-agent') {
      return fail('Activation target does not match its selected operation')
    }
    const current = currentLevels.get(update.operationId) ?? 0
    const activation = full ? update.activation
      : Math.max(0, Math.min(100, current + update.delta))
    if (!full && activation === current && activation !== 100) {
      return fail('Semi activation adjustment must change a level or trigger its function at 100')
    }
    currentLevels.set(update.operationId, activation)
    return { ...update, activation, ...(full ? { target } : {}) } as ActivationUpdate
  })
  if (!full) return { updates }
  if (!updates.some(update => update.activation > 0)) return fail('Full activation assessment requires a positive activity selection')
  const request = parsed.memoryRequest
  if (request !== null) {
    if (!isRecord(request) || Object.keys(request).some(field => !memoryFields.includes(field as typeof memoryFields[number]))) {
      return fail('Memory request must use the existing memory selection fields or null')
    }
    // Reuse the Memory Router's existing selection validator; the unrelated route
    // fields only supply its required envelope and are not model instructions.
    try { parseEnvironmentIntentRouting(JSON.stringify({ needsResponse: false, needsAction: false,
      needsGoalReview: false, needsToolUse: false, taskPlanner: 'specialist', taskContext: [], conversationContext: [], ...request })) }
    catch (error) { return fail((error as Error).message) }
  }
  return { updates, assessmentReason: parsed.assessmentReason as string, memoryRequest: request as AutonomyMemoryRequest | null }
}

export function parseRobotAutonomyChoice(value: unknown, operations: Array<{ id: string }>, mode: AutonomyMode = 'semi',
  previous: ActivationAssessment['levels'] = {}): ActivationUpdate[] {
  return parseAssessment(value, operations, mode, previous).updates
}

export const robotAutonomyControllerParserNode = defineNode({
  id: 'robot_autonomy_controller_parser', name: 'Read Activation Assessment', category: 'operator',
  inputs: [
    { name: 'response', type: 'any' },
    { name: 'availableTasks', type: 'array' },
    { name: 'activationState', type: 'object' },
  ],
  outputs: [
    { name: 'assessment', type: 'object' },
  ],
  properties: {}, propertySchemas: {},
  description: 'Records model-selected activation levels and applies the configured Semi or Full selection rule.',
  async execute(inputs, context) {
    const state = inputs.activationState as { mode: AutonomyMode; previous: ActivationAssessment | null; assessedAt: string }
    const parsed = parseAssessment(inputs.response, inputs.availableTasks, state.mode, state.previous?.levels)
    const { updates } = parsed
    const assessedAt = new Date().toISOString()
    const levels = { ...state.previous?.levels }
    for (const update of updates) levels[update.operationId] = { ...update, assessedAt, mode: state.mode }
    const assessment: ActivationAssessment = {
      executionId: context.graphExecution!.executionId, assessedAt,
      mode: state.mode, ...parsed, levels, selected: selectActivatedOperations(updates, state.mode),
    }
    return { assessment }
  },
})
