/** Browser-safe terminal contracts. No runtime imports or startup side effects. */
export type TerminalProvider = 'claude-code' | 'codex' | 'gemini'
export interface TerminalSession {
  id: string
  kind: 'provider'
  title: string
  chat?: { username: string }
  provider?: TerminalProvider
  phase: 'running' | 'completed' | 'failed' | 'stopping'
  cols: number
  rows: number
  error?: string
  diagnostic?: { pending: number; submissionId?: string; threadId?: string; repairLog: string }
}
export interface DiagnosticRequest {
  chat?: boolean
  prompt: string
  data: unknown
  model?: string
  reasoning: boolean
  username?: string
  source?: Record<string, unknown>
  toolTaskId?: string
  codeReview?: { executionId: string; issueIds: string[] }
}
export interface DiagnosticReceipt {
  sessionId: string
  submissionId: string
  status: 'submitted'
}
export interface TerminalState {
  chatSessionId?: string
  status: 'running' | 'stopping' | 'stopped'
  sessions: TerminalSession[]
}
export type TerminalEvent =
  | { type: 'state'; state: TerminalState }
  | { type: 'screen'; id: string; data: string; text: string; cols: number; rows: number }
  | { type: 'output'; id: string; data: string; text?: string }
  | { type: 'error'; error: string }

export class TerminalError extends Error {
  constructor(message: string, public readonly status = 500) { super(message) }
}
