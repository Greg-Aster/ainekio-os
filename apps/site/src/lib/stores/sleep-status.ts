import { readable } from 'svelte/store'
import { apiFetch } from '../client/api-config'

type SleepState = 'awake' | 'sleeping' | 'dreaming'
type SleepPhase = 'awake' | 'sleeping' | 'waking'

export interface SleepStageStatus {
  id: string
  displayName: string
  handler: string
  state: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  taskId?: string
  startedAt?: string
  completedAt?: string
  error?: string
  queueState?: string
  attempt?: number
  maxAttempts?: number
}

export interface SleepSessionStatus {
  id: string
  parentTaskId: string
  username: string
  reason: string
  state: 'running' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: string
  completedAt?: string
  currentStageId?: string
  stages: SleepStageStatus[]
}

interface SleepStatus {
  status: SleepState
  phase: SleepPhase
  config: {
    enabled: boolean
    window: { start: string; end: string }
    minIdleMins: number
  }
  currentSession: SleepSessionStatus | null
  recentSessions: SleepSessionStatus[]
  configuredStages: Array<Pick<SleepStageStatus, 'id' | 'displayName' | 'handler'>>
  lastChecked: string
}

export interface SleepStatusSnapshot {
  data: SleepStatus | null
  error: string
}

export const sleepStatus = readable<SleepStatusSnapshot>({ data: null, error: '' }, (set, update) => {
  if (typeof window === 'undefined') return () => {}

  let disposed = false

  let requestId = 0
  let publishedRequest = 0
  const fetchStatus = async () => {
    const request = ++requestId
    let next: SleepStatusSnapshot | Pick<SleepStatusSnapshot, 'error'>
    try {
      const res = await apiFetch('/api/sleep-status', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Sleep status request failed: ${res.status}`)
      next = { data: data as SleepStatus, error: '' }
    } catch (error) {
      next = { error: (error as Error).message }
    }
    if (!disposed && request > publishedRequest) {
      publishedRequest = request
      update(state => ({ ...state, ...next }))
    }
  }

  void fetchStatus()
  const interval = window.setInterval(fetchStatus, 10_000)

  return () => {
    disposed = true
    window.clearInterval(interval)
    set({ data: null, error: '' })
  }
})
