import { loadGraphForMode, loadedGraphSource } from '../graph-streaming.js'
import { executionDefinition } from '../durable-execution/graph-contract.js'
import { openExecutionStore } from '../durable-execution/storage.js'
import { relayExecutionOutbox } from '../durable-execution/coordinator-outbox.js'
import type { BigBrotherSessionResult } from './providers/cli.js'

/** Persist the completed turn before handing independent response work to the existing Coordinator. */
export async function admitTerminalResponse(turn: {
  username: string; sessionId: string; submissionId: string; threadId?: string;
  message: string; receivedAt: string; result: BigBrotherSessionResult;
}): Promise<string> {
  const loaded = await loadGraphForMode('big-brother-response', turn.username)
  const store = openExecutionStore(turn.username)
  try {
    const metadata = { source: 'big-brother', speaker: 'Big Brother',
      terminalSessionId: turn.sessionId, submissionId: turn.submissionId, threadId: turn.threadId,
      success: turn.result.success, error: turn.result.error }
    const record = store.enter(turn.username, executionDefinition(loaded.graph), `terminal-response:${turn.submissionId}`, {
      graph: loaded.graph, graphSource: loadedGraphSource(loaded.graph), context: {
        username: turn.username, sessionId: turn.sessionId, userMessage: turn.message,
        userMessageEntry: { role: 'user', content: turn.message, timestamp: Date.parse(turn.receivedAt),
          meta: { ...metadata, speaker: turn.username, idempotencyKey: `${turn.submissionId}:user` } },
        environmentConversationResponse: turn.result.output || turn.result.error || '',
        environmentConversationMetadata: { ...metadata, idempotencyKey: `${turn.submissionId}:assistant` },
      },
    })
    store.requestRecovery(record.executionId)
    await relayExecutionOutbox(store, record.executionId)
    return record.executionId
  } finally { store.close() }
}
