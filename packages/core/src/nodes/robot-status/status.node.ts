import { readRobotStatusLive } from '../../robot-status-live.js'
import { loadRobotStatus, projectRobotStatusContext } from '../../robot-status.js'
import { defineNode } from '../types.js'

export const robotStatusNode = defineNode({
  id: 'robot_status',
  name: 'Robot Status',
  category: 'context',
  inputs: [],
  outputs: [
    { name: 'status', type: 'object', description: 'Current typed Robot Status snapshot' },
    { name: 'context', type: 'object', description: 'Bounded Robot Status context for downstream cognition' },
    { name: 'task', type: 'object', description: 'Current LLM-authored task and correlated action result' },
    { name: 'historyContext', type: 'object', description: 'Prior semantic situation and bounded history for status refresh' },
    { name: 'summary', type: 'string', description: 'Current situational summary' },
    { name: 'updatedAt', type: 'string', description: 'Snapshot update time' },
    { name: 'found', type: 'boolean', description: 'Whether a Robot Status snapshot exists' },
  ],
  properties: { historyLimit: 3 },
  propertySchemas: {
    historyLimit: {
      type: 'slider',
      default: 3,
      label: 'History Limit',
      description: 'Number of compact prior status summaries supplied to this graph',
      min: 0,
      max: 8,
      step: 1,
    },
  },
  description: 'Reads the current profile-resolved Robot Status snapshot without updating it.',
  async execute(_inputs, context, properties) {
    const username = typeof context.username === 'string' ? context.username.trim() : ''
    if (!username) return { status: null, context: null, task: null, historyContext: null, summary: '', updatedAt: '', found: false }
    const status = loadRobotStatus(username)
    const live = await readRobotStatusLive(username, context.environmentObservation?.sessionId ?? status?.body?.sessionId)
    if (!status) return { status: null, context: { live }, task: null, historyContext: null, summary: '', updatedAt: live.readAt, found: false }
    const configuredHistoryLimit = properties?.historyLimit
    const historyLimit = Number.isInteger(configuredHistoryLimit)
      ? Math.max(0, Math.min(8, Number(configuredHistoryLimit)))
      : 3
    const { history: _history, ...snapshot } = status
    const boundedContext = { ...projectRobotStatusContext(snapshot, false), live }
    return {
      status,
      context: boundedContext,
      task: status.task,
      historyContext: {
        updatedAt: status.updatedAt,
        task: status.task,
        situation: status.situation,
        history: historyLimit > 0 ? status.history.slice(-historyLimit) : [],
      },
      summary: status.situation.situationalSummary,
      updatedAt: status.updatedAt,
      found: true,
    }
  },
})
