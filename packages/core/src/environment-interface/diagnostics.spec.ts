import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  getEnvironmentBridgeDiagnosticMedia,
  getEnvironmentBridgeDiagnosticsSnapshot,
  recordEnvironmentBridgeDiagnosticObservation,
  recordEnvironmentBridgeTelemetry,
  resetEnvironmentBridgeDiagnosticsForTests,
  storeEnvironmentBridgeDiagnosticAudio,
} from './diagnostics.js';

afterEach(() => resetEnvironmentBridgeDiagnosticsForTests());

test('aggregates bounded transport rates, media counts, robot state, and events', () => {
  recordEnvironmentBridgeTelemetry({
    sessionId: 'robot-session',
    timestamp: '2026-07-17T21:00:00.000Z',
    intervalMs: 1000,
    inboundBytes: 3200,
    outboundBytes: 400,
    inboundMessages: 5,
    outboundMessages: 2,
    audioUtterances: 1,
    audioBytes: 2400,
    microphoneLevel: 0.5,
    pendingAudioUtterances: 1,
    transcriptionStatus: 'transcribing',
    robotStatus: { vbat: 7.4, mic_drops: 2 },
    freestyleMovement: { supported: true, enabled: true, available: true },
    movementPlan: {
      actionId: 'plan-1',
      sequence: 17,
      status: 'active',
      frameCount: 4,
      durationMs: 1800,
      activeFrame: 2,
      updatedAt: '2026-07-17T21:00:00.000Z',
    },
    events: [{
      timestamp: '2026-07-17T21:00:00.000Z',
      kind: 'audio.utterance',
      bytes: 2400,
    }],
  });
  recordEnvironmentBridgeTelemetry({
    sessionId: 'robot-session',
    timestamp: '2026-07-17T21:00:01.000Z',
    intervalMs: 500,
    inboundBytes: 1000,
    inboundMessages: 1,
    transcriptionStatus: 'completed',
    transcript: 'walk forward',
  });

  const session = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
  assert.equal(session.transport.inboundBytes, 4200);
  assert.equal(session.transport.inboundBytesPerSecond, 2000);
  assert.equal(session.transport.outboundBytes, 400);
  assert.equal(session.media.audioUtterances, 1);
  assert.equal(session.microphoneLevel, 0.5);
  assert.equal(session.pendingAudioUtterances, 1);
  assert.equal(session.lastTranscriptionStatus, 'completed');
  assert.equal(session.lastTranscript, 'walk forward');
  assert.equal(session.robotStatus?.mic_drops, 2);
  assert.equal(session.freestyleMovement?.available, true);
  assert.equal(session.movementPlan?.actionId, 'plan-1');
  assert.equal(session.movementPlan?.activeFrame, 2);
  assert.equal(session.recentEvents[0]?.kind, 'audio.utterance');
});

test('keeps only the latest bounded image and WAV in memory', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  recordEnvironmentBridgeDiagnosticObservation({
    environmentId: 'ainekio',
    adapter: 'ainekio-gateway',
    sessionId: 'robot-session',
    timestamp: '2026-07-17T21:00:00.000Z',
    capabilities: { actions: ['robotCommand'] },
    visual: {
      id: 'frame-1',
      timestamp: '2026-07-17T21:00:00.000Z',
      mimeType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
    },
  });
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVE', 8, 'ascii');
  storeEnvironmentBridgeDiagnosticAudio('robot-session', 'utterance-1', wav, {
    durationMs: 20,
    wakeTriggered: true,
  });

  const session = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
  assert.equal(session.latestImage?.id, 'frame-1');
  assert.equal(session.latestAudio?.utteranceId, 'utterance-1');
  assert.deepEqual(
    getEnvironmentBridgeDiagnosticMedia('robot-session', 'image')?.data,
    image,
  );
  assert.deepEqual(
    getEnvironmentBridgeDiagnosticMedia('robot-session', 'audio')?.data,
    wav,
  );
  assert.throws(
    () => storeEnvironmentBridgeDiagnosticAudio(
      'robot-session',
      'too-large',
      Buffer.alloc((512 * 1024) + 1),
    ),
    /bounded WAV/,
  );
});


test('preserves complete diagnostic text and identifiers without merging sessions', () => {
  const prefix = 'same-session-prefix-' + 'x'.repeat(200);
  const transcript = '完整 transcription.\n' + 't'.repeat(5000) + '\nFinal requested detail.';
  const message = 'Original cause.\n' + 'diagnostic '.repeat(300) + '🤖 final evidence.';
  const actionId = 'action-' + 'a'.repeat(200);
  const robotId = 'robot-' + 'r'.repeat(200);
  const kind = 'event-' + 'k'.repeat(100);
  const status = 'status-' + 's'.repeat(100);
  for (const suffix of ['A', 'B']) {
    recordEnvironmentBridgeTelemetry({ sessionId: prefix + suffix, robotId,
      transcript, transcriptionStatus: status,
      movementPlan: { actionId, status, message, updatedAt: '2026-10-30T00:00:00Z' },
      events: [{ timestamp: '2026-10-30T00:00:00Z', kind, status, message }],
    });
  }
  const sessions = getEnvironmentBridgeDiagnosticsSnapshot().sessions;
  assert.equal(sessions.length, 2);
  for (const suffix of ['A', 'B']) {
    const session = sessions.find(item => item.sessionId === prefix + suffix)!;
    assert.ok(session);
    assert.equal(session.robotId, robotId);
    assert.equal(session.lastTranscript, transcript);
    assert.equal(session.lastTranscriptionStatus, status);
    assert.equal(session.movementPlan?.actionId, actionId);
    assert.equal(session.movementPlan?.status, status);
    assert.equal(session.movementPlan?.message, message);
    assert.deepEqual(session.recentEvents, [{ timestamp: '2026-10-30T00:00:00Z', kind, status, message, bytes: undefined }]);
  }
});

test('reports observed counts and intervals without applying execution limits to diagnostics', () => {
  recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', intervalMs: 120_000,
    inboundBytes: 120_000, outboundBytes: 240_000, pendingAudioUtterances: 7,
    movementPlan: { status: 'rejected', frameCount: 96, durationMs: 60_000, activeFrame: 65,
      message: 'Reported plan values remain visible when the body rejects a request.', updatedAt: '2026-10-30T00:00:00Z' },
  });
  const session = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
  assert.equal(session.transport.inboundBytesPerSecond, 1000);
  assert.equal(session.transport.outboundBytesPerSecond, 2000);
  assert.equal(session.pendingAudioUtterances, 7);
  assert.equal(session.movementPlan?.frameCount, 96);
  assert.equal(session.movementPlan?.durationMs, 60_000);
  assert.equal(session.movementPlan?.activeFrame, 65);
});

test('retains utterance identity and duration for byte-bounded WAV evidence', () => {
  const durationMs = 16_000;
  const payloadBytes = durationMs * 32;
  const wav = Buffer.alloc(44 + payloadBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(payloadBytes, 40);
  const utteranceId = 'utterance-' + 'u'.repeat(200);
  const stored = storeEnvironmentBridgeDiagnosticAudio('robot-session', utteranceId, wav, { durationMs });
  assert.equal(stored.utteranceId, utteranceId);
  assert.equal(stored.durationMs, durationMs);
  assert.deepEqual(getEnvironmentBridgeDiagnosticMedia('robot-session', 'audio')?.data, wav);
});

test('keeps bounded event history while preserving complete retained entries', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({
    timestamp: '2026-10-30T00:00:00Z', kind: `event-${i}`, message: `${i}:` + 'e'.repeat(1000),
  }));
  recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', events });
  const retained = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!.recentEvents;
  assert.equal(retained.length, 40);
  assert.deepEqual(retained.map(item => ({ kind: item.kind, message: item.message })),
    events.slice(5).map(item => ({ kind: item.kind, message: item.message })));
});


test('partial sensing updates do not erase measured transport rates', () => {
  recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', intervalMs: 1000,
    inboundBytes: 3200, outboundBytes: 640 });
  for (const update of [
    { transcriptionStatus: 'completed', transcript: 'Full observation remains available.' },
    { robotStatus: { output_armed: true } },
    { events: [{ timestamp: '2026-10-30T00:00:00Z', kind: 'recognition', message: 'New frame.' }] },
  ]) {
    recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', ...update });
    const session = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
    assert.equal(session.transport.inboundBytesPerSecond, 3200);
    assert.equal(session.transport.outboundBytesPerSecond, 640);
    assert.equal(session.transport.inboundBytes, 3200);
  }
  recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', intervalMs: 500, outboundBytes: 100 });
  const session = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
  assert.equal(session.transport.inboundBytesPerSecond, 3200);
  assert.equal(session.transport.outboundBytesPerSecond, 200);
  recordEnvironmentBridgeTelemetry({ sessionId: 'robot-session', intervalMs: 1000,
    inboundBytes: 0, outboundBytes: 0 });
  const idle = getEnvironmentBridgeDiagnosticsSnapshot().sessions[0]!;
  assert.equal(idle.transport.inboundBytesPerSecond, 0);
  assert.equal(idle.transport.outboundBytesPerSecond, 0);
});
