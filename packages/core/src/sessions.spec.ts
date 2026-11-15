import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-sessions-spec-'))
process.env.METAHUMAN_ROOT = isolatedRoot
const { ROOT } = await import('./path-builder.js')
assert.equal(ROOT, isolatedRoot)
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('./audit.js')
setAuditEnabled(false)
const {
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
  createSession,
  deleteSession,
  deleteUserSessions,
  getSession,
  shouldPersistSessionActivity,
  updateSession,
  validateSession,
} = await import('./sessions.js')

test.after(() => {
  fs.rmSync(isolatedRoot, { recursive: true, force: true })
})

test('session activity persistence coalesces writes within the activity interval', () => {
  const now = Date.parse('2026-07-17T12:00:00.000Z')
  assert.equal(
    shouldPersistSessionActivity(
      { lastActivity: new Date(now - SESSION_ACTIVITY_WRITE_INTERVAL_MS + 1).toISOString() },
      now
    ),
    false
  )
  assert.equal(
    shouldPersistSessionActivity(
      { lastActivity: new Date(now - SESSION_ACTIVITY_WRITE_INTERVAL_MS).toISOString() },
      now
    ),
    true
  )
  assert.equal(shouldPersistSessionActivity({ lastActivity: 'invalid' }, now), true)
})

test('owner and standard sessions persist without time expiry while guest sessions expire', () => {
  const owner = createSession('owner-user', 'owner')
  const standard = createSession('standard-user', 'standard')
  const guest = createSession('guest-user', 'guest')

  assert.equal(owner.expiresAt, undefined)
  assert.equal(standard.expiresAt, undefined)
  assert.ok(guest.expiresAt)

  const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
  const past = new Date(Date.now() - 1_000).toISOString()
  updateSession({ ...owner, createdAt: longAgo, expiresAt: past })
  updateSession({ ...standard, createdAt: longAgo, expiresAt: past })
  updateSession({ ...guest, expiresAt: past })

  assert.equal(validateSession(owner.id)?.id, owner.id)
  assert.equal(validateSession(standard.id)?.id, standard.id)
  assert.equal(validateSession(guest.id), null)
  assert.equal(getSession(guest.id), null)

  assert.equal(deleteSession(owner.id), true)
  assert.equal(validateSession(owner.id), null)
  assert.equal(deleteUserSessions('standard-user'), 1)
  assert.equal(validateSession(standard.id), null)
})
