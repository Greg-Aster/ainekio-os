import { openExecutionStore } from '../durable-execution/storage.js'
import { ExecutionCheckpointer } from '../durable-execution/checkpointer.js'
import type { NodeExecutionState } from '../graph-executor.js'
import type { ActivationAssessment } from './activation.js'

/** The checkpoint remains the decision owner; readers share its current output contract. */
export async function readActivationAssessment(reader: ExecutionCheckpointer, executionId: string): Promise<ActivationAssessment | null> {
  const saved = await reader.getTuple({ configurable: { thread_id: executionId } })
  const nodes = (saved?.checkpoint.channel_values.nodeEntries ?? []) as Array<[string, NodeExecutionState]>
  return nodes.find(([, node]) => node.definition?.type === 'robot_autonomy_controller_parser'
    && node.status === 'completed')?.[1].outputs?.assessment as ActivationAssessment | undefined ?? null
}

/** Read committed assessments from the existing execution owner; no second history store. */
export async function readActivationAssessments(username: string, count: number): Promise<ActivationAssessment[]> {
  const store = openExecutionStore(username)
  try {
    const assessments: ActivationAssessment[] = []
    const reader = new ExecutionCheckpointer(store, { executionId: '', generation: 0, owner: 'read-only' })
    const records = store.iterateNodeExecutions(username, 'active_operator_dispatch', true)
    for (const record of records) {
      const entry = store.entryOrNull(record.executionId)
      if (entry?.context?.robotOperatorContext?.robotObserver?.requestedBy !== 'robot-autonomy-controller') continue
      const assessment = await readActivationAssessment(reader, record.executionId)
      if (!assessment) continue
      assessments.push(assessment)
      if (assessments.length >= count) break
    }
    return assessments
  } finally { store.close() }
}
