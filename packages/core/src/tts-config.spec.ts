import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-tts-config-'));
process.env.METAHUMAN_ROOT = root;
const { setAuditEnabled } = await import('./audit.js');
setAuditEnabled(false);
const { eventBus } = await import('./infrastructure/event-bus/client.js');
eventBus.disconnect();
const { getProfilePaths } = await import('./path-builder.js');
const { withUserContext } = await import('./context.js');
const { createKokoroTTSService, generateSpeech } = await import('./tts.js');
const { handleTtsStream } = await import('./api/handlers/tts-stream.js');
const originalFetch = globalThis.fetch;
const globalFile = path.join(root, 'etc', 'voice.json');
const requests: Array<Record<string, unknown>> = [];

function voiceConfig(voice = 'af_heart', speed = 1) {
  return {
    tts: { provider: 'kokoro', kokoro: {
      langCode: 'a', voice, speed, useCustomVoicepack: false,
      customVoicepackPath: '{PROFILE_DIR}/out/voices/custom.pt',
      autoFallbackToPiper: false, outputFormat: 'wav',
    } },
    cache: { enabled: false, directory: '{PROFILE_DIR}/out/voice-cache', maxSizeMB: 10 },
  };
}

function writeProfile(username: string, config: unknown) {
  const file = getProfilePaths(username).voiceConfig;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

beforeEach(() => {
  fs.rmSync(path.join(root, 'profiles'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.rmSync(globalFile, { force: true });
  requests.length = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return Response.json({ status: 'ok' });
    if (String(url).endsWith('/synthesize')) {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(Buffer.from('synthetic-audio'));
    }
    throw new Error(`Unexpected request: ${url}`);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('batch and streaming use profile settings without a global voice file', async () => {
  const file = writeProfile('fixture', voiceConfig('am_adam', 0.9));
  const before = fs.readFileSync(file, 'utf8');
  const audio = await generateSpeech('Synthetic greeting.', { username: 'fixture' });
  assert.equal(audio.toString(), 'synthetic-audio');
  const chunks = [];
  for await (const chunk of createKokoroTTSService('fixture').synthesizeStream('Synthetic stream.')) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert(requests.every(request => request.voice === 'am_adam' && request.speed === 0.9));
  assert.equal(fs.existsSync(globalFile), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('existing global defaults merge with profile overrides and are reread after edits', async () => {
  fs.writeFileSync(globalFile, JSON.stringify(voiceConfig('af_heart', 1)));
  writeProfile('fixture', { tts: { kokoro: { voice: 'am_adam' } } });
  await generateSpeech('First read.', { username: 'fixture' });
  assert.equal(requests[0].voice, 'am_adam');
  assert.equal(requests[0].speed, 1);
  fs.writeFileSync(globalFile, JSON.stringify(voiceConfig('af_heart', 0.8)));
  writeProfile('fixture', { tts: { kokoro: { voice: 'bf_emma' } } });
  await generateSpeech('Second read.', { username: 'fixture' });
  assert.equal(requests[1].voice, 'bf_emma');
  assert.equal(requests[1].speed, 0.8);
});

test('concurrent profile contexts retain their own voice and cache paths', async () => {
  for (const [username, voice] of [['first', 'am_adam'], ['second', 'bf_emma']]) {
    const config = voiceConfig(voice);
    config.cache.enabled = true;
    writeProfile(username, config);
  }
  await Promise.all(['first', 'second'].map(username => withUserContext(
    { userId: username, username, role: 'owner' },
    () => generateSpeech('Same synthetic text.'),
  )));
  assert.deepEqual(new Set(requests.map(request => request.voice)), new Set(['am_adam', 'bf_emma']));
  for (const username of ['first', 'second']) {
    const cache = path.join(getProfilePaths(username).root, 'out', 'voice-cache');
    assert.equal(fs.readdirSync(cache).filter(file => file.endsWith('.wav')).length, 1);
  }
});

test('malformed profile settings fail visibly instead of using another voice', async () => {
  fs.writeFileSync(globalFile, JSON.stringify(voiceConfig()));
  const file = writeProfile('broken', voiceConfig());
  fs.writeFileSync(file, '{invalid');
  await assert.rejects(generateSpeech('Must not synthesize.', { username: 'broken' }), /voice configuration|JSON/i);
  const response = await handleTtsStream({ method: 'POST', body: { text: 'Must not synthesize.' },
    user: { username: 'broken', isAuthenticated: true, role: 'owner' } } as any);
  assert.equal(response.status, 500);
  assert.match(String(response.error), /voice configuration|JSON/i);
  assert.equal(requests.length, 0);
});

test('absent or incomplete settings report a configuration error before inference', async () => {
  await assert.rejects(generateSpeech('Missing.', { username: 'missing' }), /[Vv]oice configuration/);
  writeProfile('incomplete', { tts: { provider: 'kokoro' } });
  await assert.rejects(generateSpeech('Incomplete.', { username: 'incomplete' }), /[Vv]oice configuration/);
  assert.equal(requests.length, 0);
});

test('voice recording upload feeds the shared sample list and RVC export without a reference server', async () => {
  const { handleVoiceProfileUpload } = await import('./api/handlers/audio-uploads.js');
  const { handleGetVoiceTraining, handlePostRvcTraining, handleGetRvcTraining } = await import('./api/handlers/voice-training-routes.js');
  const username = 'recording-owner';
  writeProfile(username, voiceConfig());
  await withUserContext({ userId: username, username, role: 'owner' }, async () => {
    const audio = Buffer.from('RIFF synthetic WAV fixture');
    const request = { method: 'POST', user: { username, role: 'owner', isAuthenticated: true }, body: {
      audio: { name: 'recording.wav', type: 'audio/wav', size: audio.length, buffer: audio },
      transcript: 'Synthetic recording for the training handoff.', duration: '10', quality: '1.0',
    } } as any;
    const upload = await handleVoiceProfileUpload(request);
    assert.equal(upload.status, 200);
    const saved = upload.data as { sampleId: string; audioPath: string };
    assert.deepEqual(fs.readFileSync(saved.audioPath), audio);
    const available = await handleGetVoiceTraining({ ...request, method: 'GET', query: { action: 'samples', limit: '1000' } });
    assert.deepEqual((available.data as { samples: Array<{ id: string }> }).samples.map(s => s.id), [saved.sampleId]);
    for (let pass = 0; pass < 2; pass++) {
      const copied = await handlePostRvcTraining({ ...request, body: { action: 'copy-samples', speakerId: 'default', sampleIds: [saved.sampleId] } });
      assert.equal(copied.status, 200);
      const exported = await handleGetRvcTraining({ ...request, method: 'GET', query: { action: 'list-samples', speakerId: 'default' } });
      assert.equal((exported.data as { samples: unknown[] }).samples.length, 1);
      assert.deepEqual(fs.readFileSync(saved.audioPath), audio, 'export preserves the original recording');
    }
  });
});

for (const provider of ['kitten', 'gpt-sovits']) {
  test(`retired ${provider} selections report unsupported instead of synthesizing another voice`, async () => {
    writeProfile('retired-provider', voiceConfig());
    await assert.rejects(generateSpeech('Do not substitute this voice.', {
      username: 'retired-provider', provider: provider as any,
    }), new RegExp(`Unsupported TTS provider: ${provider}`));
    assert.equal(requests.length, 0);
  });
}
