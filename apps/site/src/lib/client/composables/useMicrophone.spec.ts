import assert from 'node:assert/strict';
import { get } from 'svelte/store';

// Actual microphone lifecycle, controlled browser event delivery and transport.
// No microphone, audio playback, transcription service or model is invoked.
let now = 1_000;
let volume = 255;
let playing = false;
const animationFrames: FrameRequestCallback[] = [];
const stoppedRecorders: Recorder[] = [];
const requests: { url: URL; bytes: Uint8Array }[] = [];
const recorders: Recorder[] = [];
const originalGlobals = new Map(['window', 'navigator', 'MediaRecorder', 'AudioContext', 'requestAnimationFrame', 'fetch']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalNow = Date.now;
class Recorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  data = new Uint8Array([1, 2, 3]);
  constructor(_stream: unknown, _options: unknown) { recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; stoppedRecorders.push(this); }
  finish() {
    this.ondataavailable?.({ data: new Blob([this.data]) });
    this.onstop?.();
  }
}
class Context {
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return { fftSize: 256, frequencyBinCount: 128,
    getByteFrequencyData(data: Uint8Array) { data.fill(volume); } }; }
  async close() {}
}
function setGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
async function settle(condition: () => boolean) {
  for (let turn = 0; turn < 50; turn++) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Expected browser lifecycle handoff did not arrive');
}
function tick() { const callbacks = animationFrames.splice(0); callbacks.forEach(callback => callback(now)); }
setGlobal('window', { isSecureContext: true, setTimeout, clearTimeout, dispatchEvent: () => true });
setGlobal('navigator', { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } });
setGlobal('MediaRecorder', Recorder);
setGlobal('AudioContext', Context);
setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { animationFrames.push(callback); return animationFrames.length; });
setGlobal('fetch', async (url: string, options?: RequestInit) => {
  if (url === '/api/activity-ping') return Response.json({});
  const target = new URL(url, 'http://fixture.invalid');
  assert.equal(target.pathname, '/api/stt');
  assert.equal(target.searchParams.has('collect'), false);
  requests.push({ url: target, bytes: new Uint8Array(options!.body as ArrayBuffer) });
  return Response.json({ transcript: '' });
});
Date.now = () => now;
const { useMicrophone } = await import('./useMicrophone.js');
const mic = useMicrophone({ getTTSPlaying: () => playing, onTranscript() {}, onSystemMessage() {}, isComponentMounted: () => true });

try {
  // RFT020: stop changes state synchronously; final data and stop arrive later.
  mic.toggleContinuousMode();
  await settle(() => recorders.length === 1);
  tick();
  assert.equal(get(mic.isRecording), true);
  const continuous = recorders.at(-1)!;
  now += 13_634;
  mic.toggleContinuousMode();
  assert.equal(get(mic.isContinuousMode), false);
  assert.equal(get(mic.isRecording), false);
  assert.ok(stoppedRecorders.includes(continuous));
  continuous.finish();
  await settle(() => requests.length === 1);
  assert.deepEqual(requests[0]!.bytes, continuous.data);
  await settle(() => !get(mic.isRecording));

  // Existing single-stop case keeps the final audio bytes.
  await mic.startMic();
  const single = recorders.at(-1)!;
  now += 2_000;
  mic.stopMic();
  single.finish();
  await settle(() => requests.length === 2);
  assert.deepEqual(requests[1]!.bytes, single.data);

  // TTS-driven stop still finalizes the original recording.
  await mic.startMic();
  const tts = recorders.at(-1)!;
  now += 1_500;
  playing = true;
  tick();
  assert.equal(tts.state, 'inactive');
  playing = false;
  tts.finish();
  await settle(() => requests.length === 3);

  // The existing short/empty checks remain; no clamp or lowered threshold.
  await mic.startMic();
  const short = recorders.at(-1)!;
  now += 100;
  mic.stopMic();
  short.finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  await mic.startMic();
  const empty = recorders.at(-1)!;
  empty.data = new Uint8Array();
  now += 1_500;
  mic.stopMic();
  empty.finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);

  // A late finalizer cannot clear a newer recorder's timing, chunks or UI state.
  mic.toggleContinuousMode();
  const beforeContinuous = recorders.length;
  await settle(() => recorders.length > beforeContinuous);
  tick();
  const older = recorders.at(-1)!;
  now += 1_500;
  mic.toggleContinuousMode();
  await mic.startMic();
  const newer = recorders.at(-1)!;
  newer.data = new Uint8Array([8, 9]);
  older.finish();
  await settle(() => requests.length === 4);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(get(mic.isRecording), true, 'old finalization leaves the newer recorder active');
  now += 2_000;
  mic.stopMic();
  newer.finish();
  await settle(() => requests.length === 5);
  assert.deepEqual(requests[3]!.bytes, older.data);
  assert.deepEqual(requests[4]!.bytes, newer.data);

  // Explicit TTS suspension still discards an interrupted continuous capture.
  mic.toggleContinuousMode();
  const beforeSuspension = recorders.length;
  await settle(() => recorders.length > beforeSuspension);
  tick();
  const suspended = recorders.at(-1)!;
  now += 1_500;
  mic.suspendContinuousForTTS();
  suspended.finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 5);
  mic.toggleContinuousMode();
  console.log('useMicrophone.spec.ts: manual continuous-stop, single/TTS stop and unchanged short/empty handling passed');
} finally {
  mic.cleanup();
  Date.now = originalNow;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
