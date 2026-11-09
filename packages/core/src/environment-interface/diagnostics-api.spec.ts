import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-diagnostics-api-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => { throw new Error('No network in diagnostics API tests'); };
const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { setAuditEnabled } = await import('../audit.js');
setAuditEnabled(false);
const {
  handleEnvironmentBridgeDiagnosticAudio,
  handleEnvironmentBridgeDiagnosticMedia,
  handleEnvironmentBridgeTelemetry,
} = await import('../api/handlers/environment-bridge.js');
import type { UnifiedRequest } from '../api/types.js';
import { getEnvironmentBridgeDiagnosticsSnapshot, resetEnvironmentBridgeDiagnosticsForTests } from './diagnostics.js';

const originalToken = process.env.MH_ENVIRONMENT_BRIDGE_TOKEN;
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

function request(overrides: Partial<UnifiedRequest> = {}): UnifiedRequest {
  return {
    path: '/api/environment-bridge/telemetry',
    method: 'POST',
    headers: {},
    user: {
      userId: 'diagnostics-spec',
      username: 'diagnostics-spec',
      role: 'owner',
      isAuthenticated: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.MH_ENVIRONMENT_BRIDGE_TOKEN = 'diagnostic-secret';
  resetEnvironmentBridgeDiagnosticsForTests();
});

afterEach(() => {
  resetEnvironmentBridgeDiagnosticsForTests();
  if (originalToken === undefined) delete process.env.MH_ENVIRONMENT_BRIDGE_TOKEN;
  else process.env.MH_ENVIRONMENT_BRIDGE_TOKEN = originalToken;
});

test('service-token telemetry is aggregated and robot status is allowlisted', async () => {
  assert.equal((await handleEnvironmentBridgeTelemetry(request())).status, 401);
  const response = await handleEnvironmentBridgeTelemetry(request({
    headers: { Authorization: 'Bearer diagnostic-secret' },
    body: {
      sessionId: 'robot-session',
      intervalMs: 1000,
      inboundBytes: 640,
      microphoneLevel: 0.25,
      robotStatus: { vbat: 7.2, rssi: -48, secret: 'discard-me' },
      freestyleMovement: { supported: true, enabled: true, available: true },
      movementPlan: {
        actionId: 'plan-1',
        sequence: 12,
        status: 'active',
        frameCount: 3,
        durationMs: 1200,
        activeFrame: 2,
        updatedAt: '2026-07-17T21:00:00.000Z',
      },
    },
  }));

  assert.equal(response.status, 200);
  const snapshot = getEnvironmentBridgeDiagnosticsSnapshot();
  const session = snapshot.sessions[0];
  assert.ok(session.robotStatus);
  assert.ok(session.freestyleMovement);
  assert.ok(session.movementPlan);
  assert.equal(session.transport.inboundBytes, 640);
  assert.equal(session.microphoneLevel, 0.25);
  assert.equal(session.robotStatus.vbat, 7.2);
  assert.equal('secret' in session.robotStatus, false);
  assert.equal(session.freestyleMovement.available, true);
  assert.equal(session.movementPlan.actionId, 'plan-1');
  assert.equal(session.movementPlan.activeFrame, 2);
});

test('latest bounded diagnostic WAV can be read from the owner media handler', async () => {
  const sessionId = 'session-' + 's'.repeat(200);
  const utteranceId = 'utterance-' + 'u'.repeat(200);
  await handleEnvironmentBridgeTelemetry(request({ headers: { Authorization: 'Bearer diagnostic-secret' }, body: { sessionId } }));
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVE', 8, 'ascii');

  const stored = await handleEnvironmentBridgeDiagnosticAudio(request({
    path: '/api/environment-bridge/diagnostics/audio',
    headers: {
      Authorization: 'Bearer diagnostic-secret',
      'X-Environment-Session-Id': sessionId,
      'X-Environment-Utterance-Id': utteranceId,
      'X-Environment-Duration-Ms': '20',
    },
    rawBody: wav,
  }));
  assert.equal(stored.status, 200);
  const snapshot = getEnvironmentBridgeDiagnosticsSnapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].sessionId, sessionId);
  assert.ok(snapshot.sessions[0].latestAudio);
  assert.equal(snapshot.sessions[0].latestAudio.utteranceId, utteranceId);

  const media = await handleEnvironmentBridgeDiagnosticMedia(request({
    path: '/api/environment-bridge/diagnostics/media',
    method: 'GET',
    query: { sessionId, kind: 'audio' },
  }));
  assert.equal(media.status, 200);
  assert.equal(media.contentType, 'audio/wav');
  assert.deepEqual(media.binary, wav);
  assert.equal(media.headers?.['Cache-Control'], 'private, no-store');
});
