import { apiEventSource, apiFetch } from '../../lib/client/api-config'
import type { DiagnosticReceipt, TerminalEvent, TerminalState } from '@metahuman/core/terminal/types'

/** Mounted chat transport only. Big Brother's Terminal service owns the session and thread. */
export class TerminalController {
  private abort = new AbortController()
  private stream?: EventSource
  private generation = 0
  private requestVersion = 0
  selected = ''
  constructor(private event: (event: TerminalEvent) => void, private error: (message: string) => void) {}
  private disconnect(): void {
    this.generation++
    this.stream?.close(); this.stream = undefined
  }
  private async request<T>(path: string, data?: unknown): Promise<T> {
    const selected = this.selected
    // A local HTTP/1 browser may have all connections occupied by SSE readers.
    // Release this view's reader before control traffic; sessions stay in the service.
    this.disconnect()
    const generation = this.generation
    try {
      const res = await apiFetch(`/api/terminal/${path}`, { signal: this.abort.signal,
        ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) })
      const result = await res.json()
      this.abort.signal.throwIfAborted()
      if (!res.ok) throw new Error(result.error || `Terminal request failed (${res.status})`)
      return result
    } catch (error) {
      if (selected && generation === this.generation && !this.abort.signal.aborted) this.select(selected)
      throw error
    }
  }
  async refresh(): Promise<void> {
    const version = ++this.requestVersion
    const state = await this.request<TerminalState>('state')
    if (version !== this.requestVersion) return
    this.event({ type: 'state', state })
    this.select(state.status === 'running' ? state.chatSessionId || '' : '')
  }
  async send(message: string): Promise<void> {
    this.requestVersion++
    const receipt = await this.request<DiagnosticReceipt>('message', { message })
    // Reattach for a current snapshot, including output produced before admission returned.
    this.select(receipt.sessionId)
  }
  async close(): Promise<void> {
    if (!this.selected) return
    this.requestVersion++
    await this.request('sessions', { action: 'close', id: this.selected })
    await this.refresh()
  }
  private select(id: string): void {
    if (this.abort.signal.aborted) return
    this.selected = id
    this.disconnect()
    const generation = this.generation
    if (!id) return
    this.stream = apiEventSource(`/api/terminal/events?id=${encodeURIComponent(id)}`)
    this.stream.onmessage = message => {
      if (generation !== this.generation || this.abort.signal.aborted) return
      try {
        const event: TerminalEvent = JSON.parse(message.data)
        this.event(event)
        if (event.type === 'error' || (event.type === 'state' && (event.state.status !== 'running' || !event.state.sessions.some(session => session.id === id)))) {
          this.select('')
        }
      } catch (error) { this.error((error as Error).message) }
    }
    // EventSource reconnects to the retained session and receives a fresh snapshot.
    this.stream.onerror = () => {
      if (generation === this.generation && !this.abort.signal.aborted) this.error('Terminal connection interrupted. Reconnecting…')
    }
  }
  dispose(): void {
    this.abort.abort()
    this.disconnect()
  }
}
