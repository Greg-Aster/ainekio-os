import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const previousRoot = process.env.METAHUMAN_ROOT
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-graph-traces-'))
process.env.METAHUMAN_ROOT = root
const { handleGetGraphTraces } = await import('./graph-traces.js')
after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (previousRoot === undefined) delete process.env.METAHUMAN_ROOT
  else process.env.METAHUMAN_ROOT = previousRoot
})

test('trace history distinguishes an absent file from an unreadable store and retains valid historical records', async () => {
  const request = { path: '/api/graph-traces', method: 'GET' as const, query: { limit: '12' },
    user: { username: 'fixture', userId: 'fixture', role: 'owner' as const, isAuthenticated: true } }
  const missing = await handleGetGraphTraces(request)
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.data.traces, [])
  const file = path.join(root, 'logs', 'graph-traces.ndjson')
  fs.mkdirSync(file, { recursive: true })
  const unreadable = await handleGetGraphTraces(request)
  assert.equal(unreadable.status, 500, 'a real EISDIR read failure must not appear as empty successful history')
  fs.rmdirSync(file)
  const trace = { timestamp: '2026-11-05T00:00:00Z', graph: 'Fixture graph', status: 'failed', error: 'Recorded failure' }
  fs.writeFileSync(file, JSON.stringify(trace) + '\nmalformed historical line\n')
  const restored = await handleGetGraphTraces(request)
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.data.traces, [trace])
})
