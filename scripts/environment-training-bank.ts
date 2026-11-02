#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { validateSvelteFlowGraph } from '../packages/core/src/cognitive-graph-schema.js'
import { openExecutionStore } from '../packages/core/src/durable-execution/storage.js'
import {
  exportReviewedEnvironmentTraining, readEnvironmentTrainingBank, readEnvironmentTrainingReviews,
  refreshEnvironmentTrainingBank, reviewEnvironmentTrainingCandidate,
} from '../packages/core/src/environment-training-bank.js'
import { systemPaths } from '../packages/core/src/path-builder.js'

function option(name: string): string | undefined {
  const position = process.argv.indexOf(`--${name}`)
  return position < 0 ? undefined : process.argv[position + 1]
}

async function main() {
  const command = process.argv[2]
  const username = option('username')
  const bank = option('bank') || 'decision'
  if (!username || !['refresh', 'list', 'show', 'review', 'export'].includes(command)) {
    throw new Error('Usage: environment-training-bank.ts <refresh|list|show|review|export> --username PROFILE [--bank decision] [--id ID] [--decision accept|correct|reject|defer --reason TEXT --target-file FILE]')
  }
  if (bank !== 'decision') throw new Error('Unknown training bank')
  if (command === 'refresh') {
    const graphFile = path.join(systemPaths.etc, 'cognitive-graphs', 'environment-mode.json')
    const graph = validateSvelteFlowGraph(JSON.parse(fs.readFileSync(graphFile, 'utf8')))
    const store = openExecutionStore(username)
    try { console.log(JSON.stringify(await refreshEnvironmentTrainingBank(store, username, graph), null, 2)) }
    finally { store.close() }
  } else if (command === 'list') {
    const reviews = new Map(readEnvironmentTrainingReviews(username)
      .reviews.map(review => [review.candidateId, review]))
    const candidates = readEnvironmentTrainingBank(username).candidates
    console.log(JSON.stringify(candidates.map(candidate => ({
      id: candidate.id, specialist: candidate.specialist, recordedAt: candidate.recordedAt,
      executionId: candidate.executionId, review: reviews.get(candidate.id)?.decision ?? 'pending',
    })), null, 2))
  } else if (command === 'show') {
    const candidates = readEnvironmentTrainingBank(username).candidates
    const candidate = candidates.find(value => value.id === option('id'))
    if (!candidate) throw new Error('Training candidate does not exist')
    console.log(JSON.stringify(candidate, null, 2))
  } else if (command === 'review') {
    const candidateId = option('id')
    const decision = option('decision')
    const reason = option('reason')
    if (!candidateId || !reason || !['accept', 'correct', 'reject', 'defer'].includes(decision ?? '')) {
      throw new Error('Review requires --id, --decision accept|correct|reject|defer and --reason')
    }
    const targetFile = option('target-file')
    if (decision === 'correct' && !targetFile) throw new Error('Correction requires --target-file')
    const review = {
      candidateId, decision: decision as 'accept' | 'correct' | 'reject' | 'defer', reason,
      ...(targetFile ? { correctedOutput: fs.readFileSync(targetFile, 'utf8') } : {}),
    }
    reviewEnvironmentTrainingCandidate(username, review)
    console.log(JSON.stringify({ reviewed: candidateId, decision }))
  } else {
    console.log(JSON.stringify(exportReviewedEnvironmentTraining(username), null, 2))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
