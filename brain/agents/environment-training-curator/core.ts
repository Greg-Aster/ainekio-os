import {
  getTargetUser, withUserContext, loadGraphForMode, runGraph, requireGraphNodeOutput,
  readEnvironmentTrainingBank, readEnvironmentTrainingReviews,
  readEnvironmentTrainingProposal,
} from '@metahuman/core'

export async function run(options: { username?: string; bank?: string; limit?: number; force?: boolean } = {}) {
  const username = options.username || process.env.MH_TRIGGER_USERNAME
  const user = getTargetUser(username ? { username } : undefined)
  if (!user) throw new Error('An authenticated profile is required')
  const bank = options.bank || 'decision'
  if (bank !== 'decision') throw new Error('--bank must be decision')
  const limit = options.limit ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1..100')
  const force = options.force ?? false
  await withUserContext(user, async () => {
    const { graph } = await loadGraphForMode('environment-training-curator', user.username)
    const candidates = readEnvironmentTrainingBank(user.username).candidates
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    const reviewed = new Set([
      ...readEnvironmentTrainingReviews(user.username).reviews.map(review => review.candidateId),
    ])
    let attempted = 0, saved = 0
    for (const candidate of candidates) {
      if (attempted >= limit) break
      if (reviewed.has(candidate.id) || !force && readEnvironmentTrainingProposal(user.username, bank, candidate.id)) continue
      attempted++
      const state = await runGraph({ graph, context: {
        username: user.username, userId: user.userId, cognitiveMode: 'environment',
        environmentTrainingReview: { bank, candidateId: candidate.id },
      } })
      if (state.status !== 'completed') {
        throw state.error ?? new Error(`Training curator graph failed for ${candidate.id}`)
      }
      const result = requireGraphNodeOutput(state, 'environment_training_review_save')
      if (result.saved !== true) {
        throw new Error(`Training curator graph did not save its proposal for ${candidate.id}`)
      }
      saved++
    }
    console.log(JSON.stringify({ username: user.username, attempted, proposalsSaved: saved }))
  })
}
