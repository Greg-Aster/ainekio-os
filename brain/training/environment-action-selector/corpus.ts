import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ACTION_SELECTOR_DIRECTORY = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(ACTION_SELECTOR_DIRECTORY, '../../..')
const PRIOR_HELD_OUT_LOCK_PATH = resolve(
  REPOSITORY_ROOT,
  'brain/training/environment-action-selector/prior-context-router-held-out.lock.json',
)
const PRIOR_ONE_SHOT_RECEIPT_PATH = resolve(
  REPOSITORY_ROOT,
  'out/environment-classifier/training/qwen3.5-0.8b-final-001/final/locked-evaluation-receipt.json',
)

export interface PriorHeldOutLock {
  version: number
  caseIds: string[]
  digest: string
}

export interface PriorOneShotReceipt {
  status: 'completed'
  heldOutDigest: string
  heldOutCaseCount: number
  completedAt: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

const MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  'brain/training/environment-action-selector/development-training.manifest.json',
)

export async function loadPriorEvaluationEvidence(): Promise<{
  lock: PriorHeldOutLock
  receipt: PriorOneShotReceipt
}> {
  const lockText = await readFile(PRIOR_HELD_OUT_LOCK_PATH, 'utf8')
  const lock = JSON.parse(lockText) as PriorHeldOutLock
  let receipt: PriorOneShotReceipt
  try {
    receipt = JSON.parse(await readFile(PRIOR_ONE_SHOT_RECEIPT_PATH, 'utf8')) as PriorOneShotReceipt
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
      priorLockedDigest?: string
      priorLockedCaseCount?: number
      priorOneShotCompletedAt?: string
      priorLockedCasesUsed?: boolean
    }
    if (manifest.priorLockedCasesUsed !== false || !manifest.priorOneShotCompletedAt) {
      throw error
    }
    receipt = {
      status: 'completed',
      heldOutDigest: manifest.priorLockedDigest ?? '',
      heldOutCaseCount: manifest.priorLockedCaseCount ?? -1,
      completedAt: manifest.priorOneShotCompletedAt,
    }
  }
  if (
    receipt.status !== 'completed'
    || receipt.heldOutDigest !== lock.digest
    || receipt.heldOutCaseCount !== lock.caseIds.length
  ) {
    throw new Error('The retired classifier one-shot evaluation receipt does not match its lock')
  }
  return { lock, receipt }
}
