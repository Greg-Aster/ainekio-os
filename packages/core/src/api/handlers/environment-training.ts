import type { UnifiedRequest, UnifiedResponse } from '../types.js'
import { errorResponse, forbiddenResponse, successResponse, unauthorizedResponse } from '../types.js'
import { getSecurityPolicy } from '../../security-policy.js'
import { openExecutionStore } from '../../durable-execution/storage.js'
import {
  readEnvironmentTrainingBank, readEnvironmentTrainingReviews,
  readEnvironmentTrainingEvidence, readEnvironmentTrainingProposal,
  reviewEnvironmentTrainingCandidate,
} from '../../environment-training-bank.js'

function reviewInventory(username: string) {
  const decisions = readEnvironmentTrainingBank(username).candidates
  const decisionReviews = new Map(readEnvironmentTrainingReviews(username).reviews.map(review => [review.candidateId, review]))
  return { decisions, decisionReviews }
}

export async function handleGetEnvironmentTraining(req: UnifiedRequest): Promise<UnifiedResponse> {
  if (!req.user.isAuthenticated) return unauthorizedResponse('Authentication required')
  if (!getSecurityPolicy({ username: req.user.username }).canReadMemory) return forbiddenResponse('Memory reading is unavailable')
  try {
    const inventory = reviewInventory(req.user.username)
    const id = req.query?.id
    if (id) {
      const candidate = inventory.decisions.find(value => value.id === id)
      if (!candidate) return errorResponse('Training record not found', 404)
      const review = inventory.decisionReviews.get(id)
      const store = openExecutionStore(req.user.username)
      try {
        return successResponse({ candidate, review: review ?? null,
          proposal: readEnvironmentTrainingProposal(req.user.username, 'decision', id),
          executionEvidence: readEnvironmentTrainingEvidence(store, candidate.executionId,
            inventory.decisions) })
      } finally { store.close() }
    }
    const items = [
      ...inventory.decisions.map(candidate => ({ id: candidate.id, bank: 'decision' as const,
        specialist: candidate.specialist, recordedAt: candidate.recordedAt,
        executionId: candidate.executionId, preview: candidate.observedOutput.slice(0, 180),
        review: inventory.decisionReviews.get(candidate.id)?.decision ?? 'pending' })),
    ].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
    return successResponse({ items })
  } catch (error) { return errorResponse((error as Error).message, 500) }
}

export async function handleReviewEnvironmentTraining(req: UnifiedRequest): Promise<UnifiedResponse> {
  if (!req.user.isAuthenticated) return unauthorizedResponse('Authentication required')
  if (!getSecurityPolicy({ username: req.user.username }).canWriteMemory) return forbiddenResponse('Memory writing is unavailable')
  const body = req.body
  if (!body || body.bank !== 'decision'
    || typeof body.id !== 'string' || !['accept', 'correct', 'reject', 'defer'].includes(body.decision)
    || typeof body.reason !== 'string' || !body.reason.trim()
    || body.decision === 'correct' && typeof body.correctedOutput !== 'string') {
    return errorResponse('Review requires a bank, record ID, decision, reason and corrected output when correcting', 400)
  }
  try {
    const review = { candidateId: body.id, decision: body.decision, reason: body.reason,
      correctedOutput: body.correctedOutput }
    reviewEnvironmentTrainingCandidate(req.user.username, review)
    return successResponse({ reviewed: body.id, decision: body.decision })
  } catch (error) { return errorResponse((error as Error).message, 400) }
}
