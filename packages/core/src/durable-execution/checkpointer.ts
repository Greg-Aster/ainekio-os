import { setImmediate as yieldToIO } from 'node:timers/promises'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { DeltaSnapshot, TASKS, WRITES_IDX_MAP, type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite, type SerializerProtocol } from '@langchain/langgraph-checkpoint'
import type { CheckpointTransition, ExecutionLease } from './types.js'
import { ExecutionConflictError } from './types.js'
import { canonicalJSON, ExecutionStore } from './store.js'
import type { QueuedTask } from '../queue/types.js'

export type CheckpointConfig = Parameters<SqliteSaver['put']>[0]

function checkpointSelectSql(byId: boolean): string {
  return `
  SELECT
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    parent_checkpoint_id,
    type,
    checkpoint,
    metadata,
    (
      SELECT
        json_group_array(
          json_object(
            'task_id', pw.task_id,
            'channel', pw.channel,
            'type', pw.type,
            'value', CAST(pw.value AS TEXT)
          )
        )
      FROM writes as pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) as pending_writes,
    (
      SELECT
        json_group_array(
          json_object(
            'type', ps.type,
            'value', CAST(ps.value AS TEXT)
          )
        )
      FROM writes as ps
      WHERE ps.thread_id = checkpoints.thread_id
        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
        AND ps.channel = '${TASKS}'
      ORDER BY ps.idx
    ) as pending_sends
  FROM checkpoints
  WHERE thread_id = ? AND checkpoint_ns = ? ${byId ? 'AND checkpoint_id = ?' : 'ORDER BY checkpoint_id DESC LIMIT 1'}`
}

function encodeJsonPlusValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === undefined) return { lc: 2, type: 'undefined' }
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'function' || kind === 'symbol') return undefined
  if (kind === 'bigint') throw new TypeError('Do not know how to serialize a BigInt')
  const obj = value as Record<string, unknown>
  if (ancestors.has(obj)) return '[Circular]'
  ancestors.add(obj)
  try {
    if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
      return encodeJsonPlusValue((obj as { toJSON: () => unknown }).toJSON(), ancestors)
    }
    if (obj instanceof DeltaSnapshot) {
      return { lc: 2, type: 'delta_snapshot', value: encodeJsonPlusValue(obj.value, ancestors) }
    }
    if (obj instanceof Set || obj instanceof Map) {
      return {
        lc: 2,
        type: 'constructor',
        id: [obj.constructor.name],
        method: null,
        args: [encodeJsonPlusValue(Array.from(obj), ancestors)],
        kwargs: {},
      }
    }
    if (obj instanceof RegExp) {
      return { lc: 2, type: 'constructor', id: ['RegExp'], method: null, args: [obj.source, obj.flags], kwargs: {} }
    }
    if (obj instanceof Error) {
      return { lc: 2, type: 'constructor', id: ['Error'], method: null, args: [obj.message], kwargs: {} }
    }
    if ((obj as { lg_name?: unknown }).lg_name === 'Send') {
      const send = obj as { node: unknown; args: unknown; timeout?: unknown }
      const out: Record<string, unknown> = {
        node: encodeJsonPlusValue(send.node, ancestors),
        args: encodeJsonPlusValue(send.args, ancestors),
      }
      if (send.timeout !== undefined) out.timeout = encodeJsonPlusValue(send.timeout, ancestors)
      return out
    }
    if (obj instanceof Uint8Array) {
      return { lc: 2, type: 'constructor', id: ['Uint8Array'], method: 'from', args: [Array.from(obj)], kwargs: {} }
    }
    if (Array.isArray(obj)) {
      const len = obj.length
      let copy: unknown[] | null = null
      for (let i = 0; i < len; i++) {
        const raw = obj[i]
        const encoded = encodeJsonPlusValue(raw, ancestors)
        const slot = encoded === undefined && raw !== undefined ? null : encoded
        if (copy) {
          copy.push(slot)
        } else if (slot !== raw) {
          copy = obj.slice(0, i)
          copy.push(slot)
        }
      }
      return copy ?? obj
    }
    const keys = Object.keys(obj)
    let copy: Record<string, unknown> | null = null
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const raw = obj[key]
      const omitted = typeof raw === 'function' || typeof raw === 'symbol'
      const encoded = omitted ? undefined : encodeJsonPlusValue(raw, ancestors)
      const skip = omitted || (encoded === undefined && raw !== undefined)
      if (!copy) {
        if (!skip && encoded === raw) continue
        copy = {}
        for (let j = 0; j < i; j++) {
          const prevKey = keys[j]
          if (prevKey === '__proto__') {
            Object.defineProperty(copy, prevKey, { value: obj[prevKey], enumerable: true, configurable: true, writable: true })
          } else {
            copy[prevKey] = obj[prevKey]
          }
        }
      }
      if (skip) continue
      if (key === '__proto__') {
        Object.defineProperty(copy, key, { value: encoded, enumerable: true, configurable: true, writable: true })
      } else {
        copy[key] = encoded
      }
    }
    return copy ?? obj
  } finally {
    ancestors.delete(obj)
  }
}

function toJsonPlusDocument(value: unknown): { type: 'bytes'; bytes: string } | { type: 'json'; json: unknown } {
  if (value instanceof Uint8Array) {
    return { type: 'bytes', bytes: Buffer.from(value).toString('base64') }
  }
  return { type: 'json', json: encodeJsonPlusValue(value, new Set()) }
}

function reviveConstructorRecord(record: Record<string, any>): unknown {
  const id = record.id
  const hasId = Array.isArray(id) && id.length === 1
  const noMethod = record.method === undefined || record.method === null
  const singleArrayArg = Array.isArray(record.args) && record.args.length === 1 && Array.isArray(record.args[0])
  if (hasId && id[0] === 'Set' && noMethod) {
    return singleArrayArg ? new Set(record.args[0]) : undefined
  }
  if (hasId && id[0] === 'Map' && noMethod) {
    if (!singleArrayArg || !record.args[0].every((entry: unknown) => Array.isArray(entry) && entry.length === 2)) return undefined
    return new Map(record.args[0])
  }
  if (hasId && id[0] === 'RegExp' && noMethod) {
    if (!Array.isArray(record.args) || record.args.length !== 2 || typeof record.args[0] !== 'string' || typeof record.args[1] !== 'string') return undefined
    try {
      return new RegExp(record.args[0], record.args[1])
    } catch {
      return undefined
    }
  }
  if (hasId && id[0] === 'Error' && noMethod) {
    if (!Array.isArray(record.args) || record.args.length !== 1 || typeof record.args[0] !== 'string') return undefined
    return new Error(record.args[0])
  }
  if (hasId && id[0] === 'Uint8Array' && (noMethod || record.method === 'from')) {
    if (!singleArrayArg || !record.args[0].every((item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) return undefined
    return new Uint8Array(record.args[0])
  }
  return undefined
}

function reviveJsonPlus(value: unknown, baseLoadsTyped: SerializerProtocol['loadsTyped']): any {
  let asyncLoads: Array<() => Promise<void>> | undefined
  const addAsyncLoad = (fn: () => Promise<void>): void => {
    (asyncLoads ??= []).push(fn)
  }
  const revive = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      const len = node.length
      const out = new Array(len)
      for (let i = 0; i < len; i++) {
        const idx = i
        const revived = revive(node[idx])
        if (revived && typeof revived === 'object' && (revived as Record<string, unknown>).__lc1Pending) {
          const pending = revived as { __lc1Pending: Record<string, unknown> }
          addAsyncLoad(async () => {
            out[idx] = await baseLoadsTyped('json', Buffer.from(JSON.stringify(pending.__lc1Pending)))
          })
        } else {
          out[idx] = revived
        }
      }
      return out
    }
    const obj = node as Record<string, unknown>
    const keys = Object.keys(obj)
    const revivedObj: Record<string, unknown> = {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const revived = revive(obj[key])
      if (revived && typeof revived === 'object' && (revived as Record<string, unknown>).__lc1Pending) {
        const pending = revived as { __lc1Pending: Record<string, unknown> }
        addAsyncLoad(async () => {
          const loaded = await baseLoadsTyped('json', Buffer.from(JSON.stringify(pending.__lc1Pending)))
          if (key === '__proto__') {
            Object.defineProperty(revivedObj, key, { value: loaded, enumerable: true, configurable: true, writable: true })
          } else {
            revivedObj[key] = loaded
          }
        })
      } else if (key === '__proto__') {
        Object.defineProperty(revivedObj, key, { value: revived, enumerable: true, configurable: true, writable: true })
      } else {
        revivedObj[key] = revived
      }
    }
    if (revivedObj.lc === 2) {
      if (revivedObj.type === 'undefined') return undefined
      if (revivedObj.type === 'delta_snapshot' && Object.prototype.hasOwnProperty.call(revivedObj, 'value')) {
        return new DeltaSnapshot(revivedObj.value)
      }
      if (revivedObj.type === 'constructor') return reviveConstructorRecord(revivedObj) ?? revivedObj
    } else if (revivedObj.lc === 1 && revivedObj.type === 'constructor' && Array.isArray(revivedObj.id)) {
      return { __lc1Pending: revivedObj }
    }
    return revivedObj
  }
  const root = revive(value)
  if (root && typeof root === 'object' && (root as Record<string, unknown>).__lc1Pending) {
    return baseLoadsTyped('json', Buffer.from(JSON.stringify((root as { __lc1Pending: Record<string, unknown> }).__lc1Pending)))
  }
  if (asyncLoads) return Promise.all(asyncLoads.map(fn => fn())).then(() => root)
  return root
}

/**
 * Uses LangGraph's SQLite format and read/replay implementation. The write
 * boundary adds serialized ownership, immutable checkpoint heads, and an atomic
 * event/outbox commit. It never commits to the Coordinator's separate ledger.
 */
export class ExecutionCheckpointer extends SqliteSaver {
  private readonly documents = new WeakMap<Uint8Array, { blobs: Map<string, string> }>()
  private readonly checkpointSerde: SqliteSaver['serde']
  constructor(readonly store: ExecutionStore, readonly lease: ExecutionLease, private readonly afterCommit?: () => Promise<void>, private readonly namespaceRoot = '') {
    super(store.db)
    const base = this.serde
    this.checkpointSerde = base
    this.serde = {
      dumpsTyped: async (value) => {
        const document = toJsonPlusDocument(value)
        const staged = store.stageDocument(document)
        const encoded = Buffer.from(staged.encoded)
        this.documents.set(encoded, staged)
        return ['metahuman-v1', encoded]
      },
      loadsTyped: async (type, bytes) => {
        if (type !== 'metahuman-v1') throw new ExecutionConflictError('Unknown checkpoint encoding')
        const document = store.decodeDocument(Buffer.from(bytes).toString('utf8'))
        if (document.type === 'bytes') return base.loadsTyped('bytes', Buffer.from(document.bytes, 'base64'))
        if (document.type === 'json') return reviveJsonPlus(document.json, base.loadsTyped.bind(base))
        throw new Error(`Unknown serialization type: ${document.type}`)
      },
    }
    this.setup()
  }

  protected override setup(): void {
    if (this.isSetup) return
    if (this.store.hasCheckpointSchema) {
      this.withoutCheckpoint = this.store.stmt(checkpointSelectSql(false))
      this.withCheckpoint = this.store.stmt(checkpointSelectSql(true))
      this.isSetup = true
      return
    }
    super.setup()
  }

  // LangGraph owns checkpoint_ns and resets it for a top-level invocation. A
  // Coordinator child re-enters from another process, so its stable work identity
  // scopes storage here while its native subgraph namespaces remain unchanged.
  private storageConfig(config: CheckpointConfig): CheckpointConfig {
    if (!this.namespaceRoot) return config
    return { ...config, configurable: { ...config.configurable,
      checkpoint_ns: `${this.namespaceRoot}|${config.configurable?.checkpoint_ns ?? ''}` } }
  }

  private logicalConfig(config: CheckpointConfig): CheckpointConfig {
    if (!this.namespaceRoot) return config
    const prefix = `${this.namespaceRoot}|`
    const namespace = config.configurable?.checkpoint_ns
    if (typeof namespace !== 'string' || !namespace.startsWith(prefix)) {
      throw new ExecutionConflictError('Checkpoint belongs to a different child invocation')
    }
    return { ...config, configurable: { ...config.configurable, checkpoint_ns: namespace.slice(prefix.length) } }
  }

  private logicalTuple(tuple: CheckpointTuple): CheckpointTuple {
    return { ...tuple, config: this.logicalConfig(tuple.config),
      parentConfig: tuple.parentConfig ? this.logicalConfig(tuple.parentConfig) : undefined }
  }

  override async getTuple(config: CheckpointConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(this.storageConfig(config))
    return tuple ? this.logicalTuple(tuple) : undefined
  }

  /** Read-only view of the existing active behavior checkpoint; never resumes it. */
  async activeBehaviorSnapshot(sessionId: string) {
    if (!['running', 'waiting'].includes(this.store.get(this.lease.executionId).status)) return null
    const heads = this.store.stmt(`SELECT c.checkpoint FROM execution_heads h
      JOIN checkpoints c ON c.thread_id = h.execution_id AND c.checkpoint_ns = h.namespace AND c.checkpoint_id = h.checkpoint_id
      WHERE h.execution_id = ?`).all(this.lease.executionId) as Array<{ checkpoint: Uint8Array }>
    const candidates: Array<{ at: number; state: import('../environment-interface/active-task.js').ActiveTaskState;
      program: import('../environment-interface/active-task.js').EnvironmentTaskProgram }> = []
    const baseLoads = this.checkpointSerde.loadsTyped.bind(this.checkpointSerde)
    const rawHeads = this.store.withDocumentReadScope(() => {
      const collected: Array<{ program: unknown; nodeEntries: unknown }> = []
      for (const head of heads) {
        const encoded = Buffer.from(head.checkpoint).toString('utf8')
        const channels = ['json', 'channel_values']
        if (this.store.decodeDocument(encoded, [...channels, 'contextSnapshot', 'activeTaskSessionId']) !== sessionId) continue
        const program = this.store.decodeDocument(encoded, [...channels, 'contextSnapshot', 'activeProgram'])
        if (!program) continue
        collected.push({
          program,
          nodeEntries: this.store.decodeDocument(encoded, [...channels, 'nodeEntries']),
        })
      }
      return collected
    })
    for (const raw of rawHeads) {
      const values = await reviveJsonPlus(raw, baseLoads)
      for (const [, node] of (values.nodeEntries ?? []) as Array<[string, import('../graph-executor.js').NodeExecutionState]>) {
        if (!['environment_active_task_step', 'environment_active_task_wait'].includes(node.definition?.type ?? '') || !node.outputs?.state) continue
        candidates.push({ at: node.endTime ?? node.startTime ?? 0, state: node.outputs.state, program: values.program })
      }
    }
    return candidates.sort((a, b) => b.at - a.at)[0] ?? null
  }

  /** Read selected completed node outputs without loading unrelated channels or pending writes. */
  async completedNodeOccurrences(outputFields: Record<string, readonly string[]>) {
    const rows = this.store.stmt(`SELECT checkpoint_ns, checkpoint_id, checkpoint FROM checkpoints
      WHERE thread_id = ? ORDER BY checkpoint_id DESC`).all(this.lease.executionId) as Array<{
        checkpoint_ns: string; checkpoint_id: string; checkpoint: Uint8Array;
      }>
    const baseLoads = this.checkpointSerde.loadsTyped.bind(this.checkpointSerde)
    const rawSnapshots = this.store.withDocumentReadScope(() => {
      const occurrences = new Set<string>()
      const collected: Array<{ namespace: string; checkpointId: string; nodes: Array<[string, {
        definition: { type: string }; status: string; startTime?: number; endTime?: number; rawOutputs: Record<string, unknown>
      }]> }> = []
      for (const row of rows) {
        const encoded = Buffer.from(row.checkpoint).toString('utf8')
        const entries = ['json', 'channel_values', 'nodeEntries']
        const count = this.store.decodeDocument(encoded, [...entries, 'length']) ?? 0
        const nodes: Array<[string, { definition: { type: string }; status: string; startTime?: number;
          endTime?: number; rawOutputs: Record<string, unknown> }]> = []
        for (let index = 0; index < count; index++) {
          const nodePath = [...entries, index, 1]
          const read = (...path: (string | number)[]) => this.store.decodeDocument(encoded, [...nodePath, ...path])
          const type = read('definition', 'type')
          if (!Object.hasOwn(outputFields, type) || read('status') !== 'completed') continue
          const nodeId = this.store.decodeDocument(encoded, [...entries, index, 0])
          const startTime = read('startTime')
          const identity = JSON.stringify([row.checkpoint_ns, nodeId, startTime])
          if (occurrences.has(identity)) continue
          occurrences.add(identity)
          const rawOutputs = Object.fromEntries(outputFields[type].map(field => [field, read('outputs', field)]))
          nodes.push([nodeId, { definition: { type }, status: 'completed', startTime, endTime: read('endTime'), rawOutputs }])
        }
        if (nodes.length) collected.push({ namespace: row.checkpoint_ns, checkpointId: row.checkpoint_id, nodes })
      }
      return collected
    })
    const snapshots = []
    for (const snapshot of rawSnapshots) {
      const nodes: Array<[string, { definition: { type: string }; status: string; startTime?: number;
        endTime?: number; outputs: Record<string, any> }]> = []
      for (const [nodeId, entry] of snapshot.nodes) {
        const values = await reviveJsonPlus(entry.rawOutputs, baseLoads)
        nodes.push([nodeId, {
          definition: entry.definition,
          status: entry.status,
          startTime: entry.startTime,
          endTime: entry.endTime,
          outputs: values,
        }])
      }
      snapshots.push({ namespace: snapshot.namespace, checkpointId: snapshot.checkpointId, nodes })
    }
    return snapshots
  }

  /** Read the saved returns of finite child graphs belonging to one dispatch. */
  async workGraphResults(effectId: string, receipt: Pick<QueuedTask, 'state' | 'error'>) {
    const effect = this.store.dispatch(effectId)
    if (effect.executionId !== this.lease.executionId) throw new ExecutionConflictError('Work belongs to a different execution')
    const prefix = `work:${effectId}:graph:`
    const rows = this.store.db.prepare('SELECT invocation_id, definition FROM execution_graphs WHERE execution_id = ?')
      .all(effect.executionId) as Array<{ invocation_id: string; definition: string }>
    const results = []
    const { getGraphOutput } = await import('../graph-executor.js')
    for (const row of rows) {
      if (!row.invocation_id.startsWith(prefix) || !/^\d+$/.test(row.invocation_id.slice(prefix.length))) continue
      const reader = new ExecutionCheckpointer(this.store, this.lease, undefined, row.invocation_id)
      const saved = await reader.getTuple({ configurable: { thread_id: effect.executionId } })
      if (!saved) continue // The process can fail before its first graph checkpoint.
      const values = saved.checkpoint.channel_values
      const nodes = new Map((values.nodeEntries ?? []) as Array<[string, import('../graph-executor.js').NodeExecutionState]>)
      const failed = [...nodes.values()].find(node => node.status === 'failed')
      const unfinished = !Array.isArray(values.queue) || values.queue.length > 0
      const status = failed ? 'failed' : unfinished
        ? ['failed', 'cancelled', 'expired'].includes(receipt.state) ? receipt.state : 'waiting'
        : 'completed'
      const error = failed?.error ?? (unfinished ? receipt.error : undefined)
      results.push({ invocationId: row.invocation_id, graph: this.store.codec.decode(row.definition).graphId,
        status, output: status === 'completed'
          ? getGraphOutput({ nodes, status: 'completed', startTime: Number(values.startedAt) }) : null,
        ...(error ? { error } : {}) })
    }
    return results
  }

  override async *list(config: CheckpointConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    // Metadata uses our reference-aware serializer, so filtering must operate on
    // decoded metadata rather than SQLite JSON paths into the encoded envelope.
    let remaining = options?.limit
    const { filter, limit: _limit, ...query } = options ?? {}
    for await (const tuple of super.list(this.storageConfig(config), query)) {
      if (filter && !Object.entries(filter).every(([key, value]) => {
        const actual = (tuple.metadata as Record<string, unknown> | undefined)?.[key]
        return value === undefined || actual !== undefined && canonicalJSON(actual) === canonicalJSON(value)
      })) continue
      if (remaining !== undefined && remaining <= 0) break
      yield this.logicalTuple(tuple)
      if (remaining !== undefined) remaining--
    }
  }

  private sameDocument(left: Uint8Array, right: Uint8Array): boolean {
    return canonicalJSON(this.store.decodeDocument(Buffer.from(left).toString('utf8')))
      === canonicalJSON(this.store.decodeDocument(Buffer.from(right).toString('utf8')))
  }

  private checkConfig(config: CheckpointConfig): { executionId: string; namespace: string; parentId: string | null } {
    const executionId = config.configurable?.thread_id
    if (executionId !== this.lease.executionId) throw new ExecutionConflictError('Checkpoint belongs to a different execution')
    return {
      executionId,
      namespace: this.storageConfig(config).configurable?.checkpoint_ns ?? '',
      parentId: config.configurable?.checkpoint_id ?? null,
    }
  }

  override async put(config: CheckpointConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<CheckpointConfig> {
    const { executionId, namespace, parentId } = this.checkConfig(config)
    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint), this.serde.dumpsTyped(metadata),
    ])
    if (type !== metadataType) throw new Error('Checkpoint and metadata serialization types differ')
    this.store.db.transaction(() => {
      this.store.assertLease(this.lease)
      const head = this.store.stmt(`SELECT checkpoint_id FROM execution_heads WHERE execution_id = ? AND namespace = ?`)
        .get(executionId, namespace) as any
      const existing = this.store.stmt(`SELECT checkpoint, metadata, parent_checkpoint_id FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`).get(executionId, namespace, checkpoint.id) as any
      if (!existing && (head?.checkpoint_id ?? null) !== parentId) throw new ExecutionConflictError('Stale checkpoint parent')
      this.store.commitDocument(executionId, this.documents.get(serializedCheckpoint)!)
      this.store.commitDocument(executionId, this.documents.get(serializedMetadata)!)
      if (existing) {
        if (!this.sameDocument(existing.checkpoint, serializedCheckpoint)
          || !this.sameDocument(existing.metadata, serializedMetadata)
          || existing.parent_checkpoint_id !== parentId) {
          throw new ExecutionConflictError('Checkpoint ID reused with different state')
        }
        return
      }
      this.store.stmt(`INSERT INTO checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(executionId, namespace, checkpoint.id, parentId, type, serializedCheckpoint, serializedMetadata)
      this.store.stmt(`INSERT INTO execution_heads VALUES (?, ?, ?)
        ON CONFLICT(execution_id, namespace) DO UPDATE SET checkpoint_id = excluded.checkpoint_id`)
        .run(executionId, namespace, checkpoint.id)
      const transition = checkpoint.channel_values.executionTransition as CheckpointTransition | undefined
      if (transition) this.store.commitTransition(executionId, checkpoint.id, transition)
      this.store.stmt(`UPDATE executions SET checkpoint_version = checkpoint_version + 1, updated_at = ?
        WHERE execution_id = ?`).run(Date.now(), executionId)
    }).immediate()
    await this.afterCommit?.()
    // Resolved promises alone keep successive graph writes in the microtask
    // queue. Let ready feedback, receipts and cancellation run between commits;
    // never yield inside the ownership/intent transaction.
    await yieldToIO()
    return { configurable: { ...config.configurable, thread_id: executionId, checkpoint_ns: config.configurable?.checkpoint_ns ?? '', checkpoint_id: checkpoint.id } }
  }

  override async putWrites(config: CheckpointConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { executionId, namespace, parentId } = this.checkConfig(config)
    if (!parentId) throw new Error('Pending writes require a checkpoint')
    const rows = await Promise.all(writes.map(async ([channel, value], index) => {
      const [type, serialized] = await this.serde.dumpsTyped(value)
      return { channel, index: WRITES_IDX_MAP[channel] ?? index, type, serialized }
    }))
    this.store.db.transaction(() => {
      this.store.assertLease(this.lease)
      const head = this.store.stmt('SELECT checkpoint_id FROM execution_heads WHERE execution_id = ? AND namespace = ?')
        .get(executionId, namespace) as any
      if (head?.checkpoint_id !== parentId) throw new ExecutionConflictError('Pending writes target a stale checkpoint')
      const selectExisting = this.store.stmt(`SELECT channel, type, value FROM writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND task_id = ? AND idx = ?`)
      const updateWrite = this.store.stmt(`UPDATE writes SET channel = ?, type = ?, value = ?
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND task_id = ? AND idx = ?`)
      const insertWrite = this.store.stmt(`INSERT INTO writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const row of rows) {
        this.store.commitDocument(executionId, this.documents.get(row.serialized)!)
        const existing = selectExisting.get(executionId, namespace, parentId, taskId, row.index) as any
        if (existing) {
          if (existing.channel === row.channel && existing.type === row.type && this.sameDocument(existing.value, row.serialized)) continue
          // LangGraph revises diagnostic/error/interrupt slots when a task resumes.
          // Successful ordinary task output is immutable, never INSERT OR IGNORE.
          if (!(row.channel in WRITES_IDX_MAP)) throw new ExecutionConflictError('Task output conflicts with a committed result')
          updateWrite.run(row.channel, row.type, row.serialized, executionId, namespace, parentId, taskId, row.index)
        } else {
          insertWrite.run(executionId, namespace, parentId, taskId, row.index, row.channel, row.type, row.serialized)
        }
      }
    }).immediate()
    await yieldToIO()
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.deleteTerminalThread(threadId)
  }

  private deleteTerminalThread(threadId: string, allowIdle = false): void {
    this.store.db.transaction(() => {
      const state = this.store.get(threadId)
      const allowedStatuses = allowIdle
        ? ['completed', 'failed', 'cancelled', 'idle']
        : ['completed', 'failed', 'cancelled']
      // An abandoned owner ID is not a live writer after assertLease rejects it.
      if (!allowedStatuses.includes(state.status)
        || this.store.hasLiveWriter(state.executionId)) {
        throw new ExecutionConflictError('Cannot prune an active execution')
      }
      if (this.store.db.prepare(`SELECT 1 FROM execution_outbox WHERE execution_id = ?
        AND status IN ('pending', 'admitted', 'accepted', 'outcome_unknown') LIMIT 1`).get(threadId)) {
        throw new ExecutionConflictError('Cannot prune an unresolved dispatch')
      }
      const observationIds = (this.store.db.prepare('SELECT observation_id FROM execution_observation_refs WHERE execution_id = ?')
        .all(threadId) as { observation_id: string }[]).map(row => row.observation_id)
      const blobHashes = (this.store.db.prepare('SELECT hash FROM execution_blob_refs WHERE execution_id = ?')
        .all(threadId) as { hash: string }[]).map(row => row.hash)
      this.store.db.prepare('DELETE FROM writes WHERE thread_id = ?').run(threadId)
      this.store.db.prepare('INSERT OR REPLACE INTO execution_retirements VALUES (?, ?)').run(threadId, Date.now())
      this.store.db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId)
      this.store.db.prepare('DELETE FROM executions WHERE execution_id = ?').run(threadId)
      if (observationIds.length) {
        const deleteObservation = this.store.db.prepare(
          'DELETE FROM execution_observations WHERE observation_id = ? AND NOT EXISTS (SELECT 1 FROM execution_observation_refs WHERE observation_id = ?)'
        )
        for (const id of observationIds) deleteObservation.run(id, id)
      }
      if (blobHashes.length) {
        const deleteBlob = this.store.db.prepare(
          'DELETE FROM execution_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM execution_blob_refs WHERE hash = ?)'
        )
        for (const hash of blobHashes) deleteBlob.run(hash, hash)
      }
    }).immediate()
  }

  /** Reset may end inactive workflows; a live writer or unresolved effect must finish first. */
  assertProfileHistoryCanBeReset(username: string): void {
    for (const state of this.store.list()) {
      if (state.username !== username) throw new ExecutionConflictError('Execution storage contains another profile')
      if (this.store.hasLiveWriter(state.executionId)) {
        throw new ExecutionConflictError(`${state.definition.graphId} has an active worker. Finish or cancel it in Queue before resetting memory`)
      }
      if (this.store.dispatches(state.executionId).some(effect =>
        ['pending', 'admitted', 'accepted', 'outcome_unknown'].includes(effect.status))) {
        throw new ExecutionConflictError(`${state.definition.graphId} has pending execution results. Resolve them in Queue before resetting memory`)
      }
    }
  }

  resetProfileHistory(username: string): number {
    return this.store.db.transaction(() => {
      this.assertProfileHistoryCanBeReset(username)
      const records = this.store.list()
      let count = 0
      for (const record of records) {
        if (!this.store.db.prepare('SELECT 1 FROM executions WHERE execution_id = ?').get(record.executionId)) continue
        this.deleteTerminalThread(record.executionId, true)
        count++
      }
      return count
    }).immediate()
  }

  async pruneTerminal(before: number, unfinishedWork = new Set<string>()): Promise<number> {
    const candidates = this.store.db.prepare(`SELECT execution_id FROM executions e
      WHERE e.status IN ('completed', 'failed', 'cancelled', 'idle') AND e.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM execution_outbox o WHERE o.execution_id=e.execution_id
          AND o.status IN ('pending', 'admitted', 'accepted', 'outcome_unknown'))`)
      .all(before) as { execution_id: string }[]
    let count = 0
    for (const { execution_id: id } of candidates) {
      if (!this.store.db.prepare('SELECT 1 FROM executions WHERE execution_id = ?').get(id)) continue
      if (unfinishedWork.has(id) || this.store.hasLiveWriter(id)) continue
      this.deleteTerminalThread(id, true)
      count++
    }
    return count
  }
}
