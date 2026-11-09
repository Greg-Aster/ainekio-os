import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeEncryption, lockProfile } from '../../encryption.js';
import { systemPaths, registerProfileStorageConfigGetter } from '../../path-builder.js';
import { getProfileStorageConfig } from '../../users.js';
import { getDefaultPersonaCore, loadPersonaCore, savePersonaCore } from '../../identity.js';
import { handleGetPersonaCore, handleUpdatePersonaCore } from './persona.js';
import { withUserContext } from '../../context.js';
import { startSession, saveSession } from '../../persona/session-manager.js';
import { handlePersonaGeneratorLoad } from './persona-generator.js';
import { setAuditEnabled } from '../../audit.js';
import { eventBus } from '../../infrastructure/event-bus/client.js';
import type { UnifiedRequest } from '../types.js';

setAuditEnabled(false);
eventBus.disconnect();

// Exercise the real handler and canonical encrypted storage, as in storage-client.spec.ts.
test('persona-core edits use encrypted profile storage, preserve unedited entries and surface locked reads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-core-api-'));
  const username = 'persona-core-fixture';
  const usersDb = systemPaths.usersDb;
  systemPaths.usersDb = path.join(root, 'users.json');
  fs.writeFileSync(systemPaths.usersDb, JSON.stringify({ version: 1, users: [{ id: 'fixture-owner', username, role: 'owner',
    metadata: { profileStorage: { path: root, type: 'encrypted', encryption: { type: 'aes256' } } } }] }));
  registerProfileStorageConfigGetter(getProfileStorageConfig);
  initializeEncryption(root, 'fixture-only-password');
  t.after(() => { eventBus.disconnect(); lockProfile(root); systemPaths.usersDb = usersDb; fs.rmSync(root, { recursive: true, force: true }); });
  const request: UnifiedRequest = { path: '/api/persona-core', method: 'POST', user: {
    userId: 'fixture-owner', username, role: 'owner', isAuthenticated: true } };
  const initial = getDefaultPersonaCore();
  const retained = { goal: 'Existing long goal', status: 'planning', sourceDesireId: 'fixture-desire', description: 'Keep metadata' };
  initial.goals.longTerm = [retained];
  initial.personality.interests = ['Astronomy'];
  initial.personality.communicationStyle = { tone: ['clear'], verbosity: 'concise', emphasis: 'evidence', humor: 'dry' };
  initial.learningProvenance = [{ path: 'personality.interests', key: 'astronomy', evidenceIds: ['fixture-evidence'], reason: 'Fixture', updatedAt: '2026-01-01' }];
  savePersonaCore(initial, new Date('2026-01-01'), username);
  const read = await handleGetPersonaCore({ ...request, method: 'GET' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.data.persona.goals.longTerm, [retained]);
  const result = await handleUpdatePersonaCore({ ...request, body: { identity: { humanName: '  Fixture Person  ', avatar: '  fixture.svg  ' },
    personality: { communicationStyle: { humor: 'gentle' } }, goals: { shortTerm: ['New short goal'] } } });
  assert.equal(result.status, 200);
  assert.equal(result.data.persona.identity.humanName, 'Fixture Person');
  assert.equal(result.data.persona.identity.avatar, 'fixture.svg');
  assert.deepEqual(result.data.persona.personality.communicationStyle, { tone: ['clear'], verbosity: 'concise', emphasis: 'evidence', humor: 'gentle' });
  assert.deepEqual(result.data.persona.goals.shortTerm, [{ goal: 'New short goal', status: 'active' }]);
  assert.deepEqual(result.data.persona.goals.longTerm, [retained]);
  assert.deepEqual(result.data.persona.learningProvenance, initial.learningProvenance);
  assert.deepEqual(loadPersonaCore(username), result.data.persona);
  assert.equal(fs.existsSync(path.join(root, 'persona/core.json')), false, 'updates must not create a plaintext shadow');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'persona/core.json.enc'), 'utf8'), /New short goal|Fixture Person/);
  // Recover the canonical finalized session and its existing review artifact without inference.
  await withUserContext(request.user, async () => {
    const session = await startSession(request.user.userId, username);
    session.status = 'finalized';
    await saveSession(username, session);
    const summaryPath = path.join(root, 'persona/therapy', session.sessionId, 'summary.json');
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    const summary = { extracted: { confidence: { overall: 0.8 } }, diff: { changes: [], summary: { additions: 1, updates: 0 } }, diffText: 'Saved review' };
    fs.writeFileSync(summaryPath, JSON.stringify(summary));
    const load = { ...request, path: '/api/persona/generator/load', method: 'GET' as const, query: { sessionId: session.sessionId } };
    const restored = await handlePersonaGeneratorLoad(load);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.session.status, 'finalized');
    assert.deepEqual(restored.data.reviewData, { extracted: summary.extracted, confidence: summary.extracted.confidence,
      diff: { ...summary.diff, text: summary.diffText } });
    const denied = await handlePersonaGeneratorLoad({ ...load, user: { ...load.user, userId: 'another-owner' } });
    assert.equal(denied.status, 403, 'review data must remain behind existing session ownership');
    fs.unlinkSync(summaryPath);
    assert.equal((await handlePersonaGeneratorLoad(load)).status, 500, 'missing saved evidence must not become a fabricated review');
    session.status = 'applied'; await saveSession(username, session);
    const applied = await handlePersonaGeneratorLoad(load);
    assert.equal(applied.data.session.status, 'applied');
    assert.equal(applied.data.reviewData, undefined, 'an applied receipt does not need another review/apply');
  });
  // A stale plaintext copy cannot bypass a locked encrypted profile.
  fs.writeFileSync(path.join(root, 'persona/core.json'), JSON.stringify(initial));
  lockProfile(root);
  assert.equal((await handleGetPersonaCore({ ...request, method: 'GET' })).status, 500);
  assert.equal((await handleUpdatePersonaCore({ ...request, body: { goals: { shortTerm: ['Must not write'] } } })).status, 500);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'persona/core.json'), 'utf8')), initial);
  assert.equal((await handleGetPersonaCore({ ...request, user: { ...request.user, isAuthenticated: false } })).status, 401);
});
