import readline from 'node:readline'
import { audit } from '@metahuman/core/audit'
import { terminalRequest, terminalCall } from '@metahuman/core/terminal'
import type { TerminalEvent, DiagnosticReceipt } from '@metahuman/core/terminal/types'

/** Native terminal display/input only. The Terminal service owns all Codex work. */
export async function terminalView(id: string): Promise<void> {
  const response = await terminalRequest(`/events?id=${encodeURIComponent(id)}`)
  if (response.statusCode !== 200) {
    let body = ''
    for await (const chunk of response) body += chunk
    throw new Error(`Cannot attach diagnostic terminal: ${body}`)
  }
  response.setEncoding('utf8')
  const color = (code: string, text: string) => process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: color('1;32', 'You › ') })
  const write = (text: string) => {
    if (process.stdout.isTTY) { readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0) }
    process.stdout.write(text)
    input.prompt(true)
  }
  let closedByOwner = false
  let closure: { cause: string; signal?: string; error?: string; errorCode?: string } | undefined
  const close = (cause: string, signal?: string) => {
    closure ??= { cause, signal }
    response.destroy()
  }
  const inputClosed = () => close('input_closed')
  const terminated = () => close('signal', 'SIGTERM')
  const hungUp = () => close('signal', 'SIGHUP')
  input.on('line', line => {
    if (!line.trim()) { input.prompt(); return }
    void terminalCall<DiagnosticReceipt>('/diagnostic-input', { id, message: line }).then(receipt => {
      write(`\n${color('1;32', 'Follow-up queued')} ${color('2', receipt.submissionId)}\n`)
    }, error => { write(`\n${color('1;31', error.message)}\n`) })
  })
  input.once('close', inputClosed)
  process.once('SIGTERM', terminated)
  process.once('SIGHUP', hungUp)
  let buffered = ''
  let lastStatus = ''
  try {
    write(`${color('1;36', 'Big Brother · Codex')}\n${color('2', 'Type a follow-up and press Enter. Follow-ups run after the current turn. Closing this window stops this session.')}\n\n`)
    for await (const chunk of response) {
      buffered += chunk
      let end: number
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2)
        if (!frame.startsWith('data: ')) continue
        const event: TerminalEvent = JSON.parse(frame.slice(6))
        if (event.type === 'error') throw new Error(event.error)
        if (event.type === 'state' && !event.state.sessions.some(session => session.id === id)) {
          closedByOwner = true
          closure ??= { cause: 'owner_closed' }
          return
        }
        if (event.type === 'state') {
          const session = event.state.sessions.find(session => session.id === id)!
          const pending = session.diagnostic?.pending ?? 0
          const status = `${session.phase === 'completed' ? 'Idle · ready for another message' : session.phase} · ${pending} queued`
          if (status !== lastStatus) {
            lastStatus = status
            write(`\n${color(session.phase === 'failed' ? '1;31' : '2', status)}\n`)
          }
        }
        if ((event.type === 'screen' || event.type === 'output') && event.id === id) {
          write(event.data)
        }
      }
    }
  } catch (error) {
    closure ??= { cause: 'viewer_error' }
    closure.error = error instanceof Error ? error.message : String(error)
    closure.errorCode = (error as NodeJS.ErrnoException)?.code
    throw error
  } finally {
    audit({ level: closure?.error || !closure ? 'warn' : 'info', category: 'system',
      event: 'big_brother_terminal_view_closed', actor: 'terminal',
      details: { sessionId: id, viewerPid: process.pid, closedByOwner,
        ...(closure ?? { cause: 'stream_ended' }) } })
    input.off('close', inputClosed)
    input.close()
    response.destroy()
    process.off('SIGTERM', terminated)
    process.off('SIGHUP', hungUp)
    if (!closedByOwner) await terminalCall('/close', { id })
  }
}
