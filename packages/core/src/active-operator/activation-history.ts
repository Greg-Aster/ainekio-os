import { openExecutionStore } from '../durable-execution/storage.js'
import type { ExecutionStore } from '../durable-execution/store.js'
import { ExecutionCheckpointer } from '../durable-execution/checkpointer.js'
import type { ExecutionRecord } from '../durable-execution/types.js'
import type { NodeExecutionState } from '../graph-executor.js'
import type { ActivationAssessment } from './activation.js'

const TERMINAL_STATUSES = new Set<ExecutionRecord['status']>(['completed', 'failed', 'cancelled'])
const FALLBACK_TO_TUPLE = Symbol('fallback-to-tuple')
const DEFAULT_GET_TUPLE = ExecutionCheckpointer.prototype.getTuple
const ASSESSMENT_CACHE_LIMIT = 512
const ENTRY_CACHE_LIMIT = 1024

let nextMemoryDbId = 0
const memoryDbIds = new WeakMap<object, number>()
const checkpointAssessmentCache = new Map<string, ActivationAssessment | null>()
const terminalAssessmentCache = new Map<string, ActivationAssessment | null>()
const requestedByCache = new Map<string, string | null>()

export function storeCacheIdentity(store: ExecutionStore): string {
  const name = store.db.name
  if (name && name !== ':memory:') return `file:${name}`
  let id = memoryDbIds.get(store.db)
  if (id === undefined) {
    id = ++nextMemoryDbId
    memoryDbIds.set(store.db, id)
  }
  return `mem:${id}`
}

function setBounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  if (map.has(key)) map.delete(key)
  else if (map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function cloneAssessment(value: ActivationAssessment | null): ActivationAssessment | null {
  return value ? structuredClone(value) : null
}

function reviveAssessmentValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const revived = reviveAssessmentValue(value[i])
      if (revived === FALLBACK_TO_TUPLE) return FALLBACK_TO_TUPLE
      out[i] = revived
    }
    return out
  }
  const record = value as Record<string, unknown>
  if (record.lc === 2) {
    if (record.type === 'undefined') return undefined
    return FALLBACK_TO_TUPLE
  }
  if (record.lc === 1 && record.type === 'constructor') return FALLBACK_TO_TUPLE
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    const revived = reviveAssessmentValue(record[key])
    if (revived === FALLBACK_TO_TUPLE) return FALLBACK_TO_TUPLE
    if (key === '__proto__') {
      Object.defineProperty(out, key, { value: revived, enumerable: true, configurable: true, writable: true })
    } else {
      out[key] = revived
    }
  }
  return out
}

async function readActivationAssessmentViaTuple(reader: ExecutionCheckpointer, executionId: string): Promise<ActivationAssessment | null> {
  const saved = await reader.getTuple({ configurable: { thread_id: executionId } })
  const nodes = (saved?.checkpoint.channel_values.nodeEntries ?? []) as Array<[string, NodeExecutionState]>
  return nodes.find(([, node]) => node.definition?.type === 'robot_autonomy_controller_parser'
    && node.status === 'completed')?.[1].outputs?.assessment as ActivationAssessment | undefined ?? null
}

function readRequestedBy(store: ExecutionStore, storeId: string, record: Pick<ExecutionRecord, 'executionId' | 'createdAt'>): string | null {
  const key = `${storeId}:${record.executionId}:${record.createdAt}`
  if (requestedByCache.has(key)) return requestedByCache.get(key) ?? null
  const raw = store.entryOrNull(record.executionId, ['context', 'robotOperatorContext', 'robotObserver', 'requestedBy'])
  const requestedBy = typeof raw === 'string' ? raw : null
  setBounded(requestedByCache, key, requestedBy, ENTRY_CACHE_LIMIT)
  return requestedBy
}

/** The checkpoint remains the decision owner; readers share its current output contract. */
export async function readActivationAssessment(
  reader: ExecutionCheckpointer,
  executionId: string,
  record?: Pick<ExecutionRecord, 'status' | 'createdAt' | 'updatedAt' | 'checkpointVersion'>,
): Promise<ActivationAssessment | null> {
  if ((reader as unknown as { namespaceRoot?: string }).namespaceRoot || reader.getTuple !== DEFAULT_GET_TUPLE) {
    return readActivationAssessmentViaTuple(reader, executionId)
  }
  const store = reader.store
  if (!store.hasCheckpointSchema) {
    return readActivationAssessmentViaTuple(reader, executionId)
  }
  const storeId = storeCacheIdentity(store)
  const isTerminal = Boolean(record && TERMINAL_STATUSES.has(record.status))
  const terminalKey = isTerminal && record
    ? `${storeId}:${executionId}:${record.status}:${record.createdAt}:${record.updatedAt}:${record.checkpointVersion}`
    : null
  if (terminalKey && terminalAssessmentCache.has(terminalKey)) {
    return cloneAssessment(terminalAssessmentCache.get(terminalKey) ?? null)
  }

  const head = store.stmt(
    "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1",
  ).get(executionId) as { checkpoint_id: string } | undefined
  if (!head) {
    if (terminalKey) setBounded(terminalAssessmentCache, terminalKey, null, ASSESSMENT_CACHE_LIMIT)
    return null
  }

  const checkpointKey = `${storeId}:${executionId}:${head.checkpoint_id}`
  if (checkpointAssessmentCache.has(checkpointKey)) {
    const cached = checkpointAssessmentCache.get(checkpointKey) ?? null
    if (terminalKey) setBounded(terminalAssessmentCache, terminalKey, cached, ASSESSMENT_CACHE_LIMIT)
    return cloneAssessment(cached)
  }

  const row = store.stmt(
    "SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
  ).get(executionId, head.checkpoint_id) as { type: string; checkpoint: Uint8Array } | undefined
  if (!row) return null

  let decoded: ActivationAssessment | null | typeof FALLBACK_TO_TUPLE = FALLBACK_TO_TUPLE
  if (row.type === 'metahuman-v1') {
    decoded = store.withDocumentReadScope(() => {
      const encoded = Buffer.from(row.checkpoint).toString('utf8')
      if (store.decodeDocument(encoded, ['type']) !== 'json') return FALLBACK_TO_TUPLE
      const entries = ['json', 'channel_values', 'nodeEntries'] as const
      const count = store.decodeDocument(encoded, [...entries, 'length']) ?? 0
      for (let index = 0; index < count; index++) {
        const nodePath = [...entries, index, 1]
        if (store.decodeDocument(encoded, [...nodePath, 'definition', 'type']) !== 'robot_autonomy_controller_parser') continue
        if (store.decodeDocument(encoded, [...nodePath, 'status']) !== 'completed') continue
        const rawAssessment = store.decodeDocument(encoded, [...nodePath, 'outputs', 'assessment'])
        if (!rawAssessment) return null
        const revived = reviveAssessmentValue(rawAssessment)
        return revived === FALLBACK_TO_TUPLE ? FALLBACK_TO_TUPLE : (revived as ActivationAssessment)
      }
      return null
    })
  }

  const assessment = decoded === FALLBACK_TO_TUPLE
    ? await readActivationAssessmentViaTuple(reader, executionId)
    : decoded
  setBounded(checkpointAssessmentCache, checkpointKey, assessment, ASSESSMENT_CACHE_LIMIT)
  if (terminalKey) setBounded(terminalAssessmentCache, terminalKey, assessment, ASSESSMENT_CACHE_LIMIT)
  return cloneAssessment(assessment)
}

export async function readActivationAssessmentsFromStore(
  store: ExecutionStore,
  username: string,
  count: number,
): Promise<ActivationAssessment[]> {
  if (count <= 0) return []
  const assessments: ActivationAssessment[] = []
  const storeId = storeCacheIdentity(store)
  const reader = new ExecutionCheckpointer(store, { executionId: '', generation: 0, owner: 'read-only' })
  const records = store.iterateNodeExecutions(username, 'active_operator_dispatch', true)
  for (const record of records) {
    if (readRequestedBy(store, storeId, record) !== 'robot-autonomy-controller') continue
    const assessment = await readActivationAssessment(reader, record.executionId, record)
    if (!assessment) continue
    assessments.push(assessment)
    if (assessments.length >= count) break
  }
  return assessments
}

/** Read committed assessments from the existing execution owner; no second history store. */
export async function readActivationAssessments(username: string, count: number): Promise<ActivationAssessment[]> {
  const store = openExecutionStore(username)
  try {
    return await readActivationAssessmentsFromStore(store, username, count)
  } finally { store.close() }
}
