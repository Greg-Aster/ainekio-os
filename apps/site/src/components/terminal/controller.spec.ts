import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalController } from './controller.js'

class Source extends EventTarget {
  static all: Source[] = []
  readyState = 1
  onopen?: () => void
  onerror?: () => void
  onmessage?: (event: { data: string }) => void
  constructor(readonly url: string) { super(); Source.all.push(this) }
  close() { this.readyState = 2 }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
const originalFetch = globalThis.fetch
const originalSource = globalThis.EventSource
globalThis.EventSource = Source as unknown as typeof EventSource
const state = { status: 'running', chatSessionId: 'one', sessions: [{ id: 'one', kind: 'provider', chat: { username: 'fixture' }, phase: 'running', title: 'Codex Terminal', cols: 80, rows: 24 }] }
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
test.after(() => { globalThis.fetch = originalFetch; globalThis.EventSource = originalSource })

test('late initial response after disposal cannot subscribe or create a session', async () => {
  let resolve!: (value: Response) => void
  const urls: string[] = []
  globalThis.fetch = async url => { urls.push(String(url)); return new Promise<Response>(r => { resolve = r }) }
  const events: unknown[] = []
  const controller = new TerminalController(event => events.push(event), () => {})
  const pending = controller.refresh()
  controller.dispose()
  resolve(reply(state))
  await assert.rejects(pending, /aborted/)
  assert.deepEqual(urls, ['/api/terminal/state'])
  assert.deepEqual(events, [])
  assert.equal(Source.all.filter(source => source.readyState !== 2).length, 0)
})

test('stopped status creates no subscription; hide closes one stream without closing its shell', async () => {
  const calls: string[] = []
  globalThis.fetch = async url => { calls.push(String(url)); return reply({ status: 'stopped', sessions: [] }) }
  const controller = new TerminalController(() => {}, () => {})
  await controller.refresh()
  assert.equal(Source.all.filter(source => source.readyState !== 2).length, 0)
  globalThis.fetch = async url => { calls.push(String(url)); return reply(state) }
  await controller.refresh()
  assert.equal(Source.all.filter(source => source.readyState !== 2).length, 1)
  controller.dispose()
  assert.equal(Source.all.filter(source => source.readyState !== 2).length, 0)
  assert.deepEqual(calls, ['/api/terminal/state', '/api/terminal/state'])
})

test('failed close preserves selection; reconnect replaces the stream and stale events are ignored', async () => {
  globalThis.fetch = async () => reply(state)
  const events: unknown[] = []
  const errors: string[] = []
  const controller = new TerminalController(event => events.push(event), error => errors.push(error))
  try {
    await controller.refresh()
    const first = Source.all.at(-1)!
    globalThis.fetch = async () => reply({ error: 'permission denied' }, 500)
    await assert.rejects(controller.close(), /permission denied/)
    assert.equal(controller.selected, 'one')
    assert.equal(first.readyState, 2, 'failed control request replaces its released viewer')
    assert.equal(Source.all.at(-1)!.readyState, 1)
    Source.all.at(-1)!.onerror!()
    assert.equal(Source.all.filter(source => source.readyState !== 2).length, 1, 'native EventSource retains reconnect ownership')
    globalThis.fetch = async () => reply(state)
    await controller.refresh()
    const count = events.length
    first.send({ type: 'error', error: 'stale callback' })
    assert.equal(events.length, count)
    assert.equal(Source.all.filter(source => source.readyState !== 2).length, 1)
    assert.equal(errors.length, 1)
  } finally { controller.dispose() }
})

test('messages use shared admission and reattach to the same session without shell input', async () => {
  const writes: unknown[] = []
  globalThis.fetch = async (url, init) => {
    writes.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return reply({ sessionId: 'one', submissionId: 'receipt', status: 'submitted' })
  }
  const controller = new TerminalController(() => {}, () => {})
  try {
    await controller.send('first\nmessage')
    const first = Source.all.at(-1)!
    await controller.send('follow-up')
    assert.equal(first.readyState, 2)
    assert.equal(controller.selected, 'one')
    assert.equal(Source.all.at(-1)!.url, '/api/terminal/events?id=one')
    assert.deepEqual(writes, [
      { url: '/api/terminal/message', body: { message: 'first\nmessage' } },
      { url: '/api/terminal/message', body: { message: 'follow-up' } },
    ])
    globalThis.fetch = async () => reply({ error: 'provider unavailable' }, 500)
    await assert.rejects(controller.send('third'), /provider unavailable/)
    assert.equal(controller.selected, 'one')
  } finally { controller.dispose() }
})

test('terminal opens alongside existing streams and disposal closes only its own stream', async () => {
  globalThis.fetch = async () => reply(state)
  const background = Array.from({ length: 12 }, (_, i) => new Source(`/fixture-${i}`))
  const controller = new TerminalController(() => {}, () => {})
  try {
    await controller.refresh()
    const terminal = Source.all.at(-1)!
    assert.equal(terminal.url, '/api/terminal/events?id=one')
    assert.equal(terminal.readyState, 1)
    assert.ok(background.every(source => source.readyState === 1))
    controller.dispose()
    assert.equal(terminal.readyState, 2)
    assert.ok(background.every(source => source.readyState === 1))
  } finally { controller.dispose(); background.forEach(source => source.close()) }
})

test('a delayed initial state cannot detach a newly submitted terminal session', async () => {
  let release!: (response: Response) => void
  globalThis.fetch = async url => String(url).endsWith('/state')
    ? new Promise<Response>(resolve => { release = resolve })
    : reply({ sessionId: 'new-chat', submissionId: 'first', status: 'submitted' })
  const controller = new TerminalController(() => {}, () => {})
  try {
    const initial = controller.refresh()
    await controller.send('first message')
    release(reply({ status: 'stopped', sessions: [] }))
    await initial
    assert.equal(controller.selected, 'new-chat')
    assert.equal(Source.all.at(-1)!.url, '/api/terminal/events?id=new-chat')
    assert.equal(Source.all.at(-1)!.readyState, 1)
  } finally { controller.dispose() }
})

test('every terminal browser request has an Astro transport route into the shared API router', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  for (const [name, method] of [['state', 'GET'], ['sessions', 'POST'], ['message', 'POST'], ['events', 'GET']]) {
    const file = new URL(`../../pages/api/terminal/${name}.ts`, import.meta.url)
    assert.equal(existsSync(file), true, `${method} /api/terminal/${name} must not fall through to an HTML 404`)
    const source = readFileSync(file, 'utf8')
    assert.match(source, /@metahuman\/core\/api\/adapters\/astro/)
    assert.ok(source.includes(`export const ${method} = astroHandler`))
  }
})

test('follow-up admission, reconnect and close release their own stream before competing for an HTTP connection', async () => {
  const background = Array.from({ length: 5 }, (_, i) => new Source(`/occupied-${i}`))
  const requests: string[] = []
  globalThis.fetch = async (url, init) => {
    assert.ok(Source.all.filter(source => source.readyState !== 2).length < 6,
      'the terminal must release its viewer before a finite HTTP request can obtain a connection')
    requests.push(String(url))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (String(url).endsWith('/message')) return reply({ sessionId: 'one', submissionId: body.message, status: 'submitted' })
    return reply(state)
  }
  const controller = new TerminalController(() => {}, () => {})
  try {
    await controller.refresh()
    for (const message of ['first follow-up', 'second follow-up']) {
      const previous = Source.all.at(-1)!
      assert.equal(Source.all.filter(source => source.readyState !== 2).length, 6)
      await controller.send(message)
      assert.equal(previous.readyState, 2)
      assert.equal(controller.selected, 'one')
    }
    await controller.refresh()
    await controller.close()
    assert.ok(requests.filter(url => url.endsWith('/message')).length === 2)
    assert.ok(background.every(source => source.readyState === 1), 'only this view releases its own stream')
  } finally { controller.dispose(); background.forEach(source => source.close()) }
})
