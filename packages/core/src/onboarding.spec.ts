import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { UnifiedRequest } from './api/types.js';

// Exercise the current HTTP/storage owners against an isolated users database.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-onboarding-'));
process.env.METAHUMAN_ROOT = root;
const { setAuditEnabled } = await import('./audit.js');
const { createUser, getUser, updateUserMetadata } = await import('./users.js');
const { DEFAULT_ONBOARDING_STATE, getOnboardingState } = await import('./onboarding.js');
const { handleGetOnboardingState, handleUpdateOnboardingState, handleCompleteOnboarding, handleSkipOnboarding } = await import('./api/handlers/onboarding.js');
setAuditEnabled(false);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('partial survey/task updates preserve other persisted counters, historical identity and step flags', async () => {
  const user = createUser('onboarding-fixture', 'fixture-password', 'standard');
  const initial = structuredClone(DEFAULT_ONBOARDING_STATE);
  initial.stepsCompleted.identity = true;
  initial.dataCollected = { identityQuestions: 3, personalityQuestions: 0, filesIngested: 5, tasksCreated: 0, memoriesCreated: 4 };
  updateUserMetadata(user.id, { onboardingState: initial });
  const request = (updates: unknown): UnifiedRequest => ({ method: 'POST', path: '/api/onboarding/state',
    user: { userId: user.id, username: user.username, role: 'standard', isAuthenticated: true }, body: { updates } }) as UnifiedRequest;
  for (const updates of [{ dataCollected: { personalityQuestions: 7 } }, { dataCollected: { tasksCreated: 2 } },
    { currentStep: 5, stepsCompleted: { goals: true } }]) {
    assert.equal((await handleUpdateOnboardingState(request(updates))).status, 200);
  }
  const stored = getUser(user.id)!.metadata!.onboardingState!;
  assert.deepEqual(stored.dataCollected, { identityQuestions: 3, personalityQuestions: 7, filesIngested: 5, tasksCreated: 2, memoriesCreated: 4 });
  assert.equal(stored.stepsCompleted.identity, true);
  assert.equal(stored.stepsCompleted.goals, true);
  assert.equal(stored.stepsCompleted.welcome, false);
  assert.equal(stored.currentStep, 5);
  const restored = await handleGetOnboardingState(request({}));
  assert.deepEqual(restored.data.state, stored, 'a fresh user read restores the committed metadata');
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await handleCompleteOnboarding(request({}))).status, 200);
    assert.equal(getOnboardingState(user.id)!.completed, true);
    assert.deepEqual(getOnboardingState(user.id)!.dataCollected, stored.dataCollected);
  }
});

test('explicit skip persists its reason without discarding collected information', async () => {
  const user = createUser('onboarding-skip', 'fixture-password', 'standard');
  const initial = structuredClone(DEFAULT_ONBOARDING_STATE);
  initial.dataCollected.filesIngested = 2;
  updateUserMetadata(user.id, { onboardingState: initial });
  const result = await handleSkipOnboarding({ method: 'POST', path: '/api/onboarding/skip', body: { reason: 'user_declined' },
    user: { userId: user.id, username: user.username, role: 'standard', isAuthenticated: true } } as UnifiedRequest);
  assert.equal(result.status, 200);
  assert.equal(getOnboardingState(user.id)!.skipped, true);
  assert.equal(getOnboardingState(user.id)!.skipReason, 'user_declined');
  assert.deepEqual(getOnboardingState(user.id)!.dataCollected, initial.dataCollected);
});
