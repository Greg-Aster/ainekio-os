import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as childProcess from 'node:child_process';
import { after, beforeEach, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-stt-'));
process.env.METAHUMAN_ROOT = root;
const { setAuditEnabled } = await import('./audit.js');
setAuditEnabled(false);
const { eventBus } = await import('./infrastructure/event-bus/client.js');
eventBus.disconnect();
const sessions = await import('./sessions.js');
let activeUser: { username: string } | null = { username: 'robot' };
mock.module('./sessions.js', { namedExports: { ...sessions, getCurrentlyActiveUser: () => activeUser } });
const { withUserContext } = await import('./context.js');
const { getProfilePaths } = await import('./path-builder.js');
let spawnFixture = (..._args: any[]): any => { throw new Error('Unexpected subprocess in STT fixture'); };
mock.module('node:child_process', { namedExports: {
  ...childProcess, spawn: (...args: any[]) => spawnFixture(...args),
} });
const voiceServices = await import('./voice-service-manager.js');
let ensureFixture = async (..._args: any[]): Promise<any> => { throw new Error('Unexpected service startup in STT fixture'); };
mock.module('./voice-service-manager.js', { namedExports: {
  ...voiceServices,
  ensureVoiceServiceRunning: (...args: any[]) => ensureFixture(...args),
  getVoiceServiceStatus: async () => { throw new Error('Unexpected duplicate readiness polling'); },
} });
const { transcribeAudio } = await import('./stt.js');
const { WhisperService } = await import('./stt/providers/whisper-service.js');
const { MicInputNode } = await import('./nodes/input/mic-input.node.js');
const { SpeechToTextNode } = await import('./nodes/input/speech-to-text.node.js');
const originalFetch = globalThis.fetch;
const requests: FormData[] = [];
fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
fs.writeFileSync(path.join(root, 'etc', 'voice.json'), JSON.stringify({ stt: { provider: 'whisper', whisper: {
  model: 'base.en', device: 'cpu', computeType: 'int8', language: 'en',
  server: { useServer: true, autoStart: false },
} } }));

function name(username: string, value: string) {
  const file = getProfilePaths(username).personaCore;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ identity: { name: value } }));
}

beforeEach(() => {
  activeUser = { username: 'robot' };
  name('robot', 'Ainekio');
  requests.length = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return Response.json({ status: 'ready' });
    assert.equal(new URL(String(url)).pathname, '/transcribe');
    requests.push(init!.body as FormData);
    return Response.json({ text: 'And next year.', language: 'en', language_probability: 1 });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  eventBus.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});

test('robot microphone STT supplies the active persona name without rewriting recognized words', async () => {
  const audio = Buffer.from('fixture audio bytes');
  assert.equal(await transcribeAudio(audio), 'And next year.');
  assert.equal(requests[0].get('hotwords'), 'Ainekio');
  assert.deepEqual(Buffer.from(await (requests[0].get('file') as File).arrayBuffer()), audio);
});

test('authenticated profile wins over the background profile and name edits apply on the next request', async () => {
  name('other', 'Other Robot');
  await withUserContext({ userId: 'other', username: 'other', role: 'owner' }, async () => {
    await transcribeAudio(Buffer.from('audio'));
    name('other', 'Renamed Robot');
    await transcribeAudio(Buffer.from('audio'));
  });
  await transcribeAudio(Buffer.from('audio'));
  assert.deepEqual(requests.map(request => request.get('hotwords')), ['Other Robot', 'Renamed Robot', 'Ainekio']);
});

test('transcription without an active identity supplies no invented name', async () => {
  activeUser = null;
  assert.equal(await transcribeAudio(Buffer.from('audio')), 'And next year.');
  assert.equal(requests[0].has('hotwords'), false);
});

test('speech node transcribes wired microphone bytes before context audio', async () => {
  const audio = Buffer.from('current wired microphone');
  const microphone = await MicInputNode.execute({}, { audioBuffer: audio }, {});
  for (const context of [{}, { audioBuffer: Buffer.from('stale context audio') }]) {
    const result = await SpeechToTextNode.execute({ audioBuffer: microphone.audioBuffer }, context, { audioFormat: 'webm' });
    assert.equal(result.transcribed, true);
    assert.equal(result.text, 'And next year.');
    assert.equal(result.audioFormat, 'webm');
    const file = requests.at(-1)!.get('file') as File;
    assert.equal(file.name, 'audio.webm');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
  }
});

test('speech node retains context input and reports missing audio and provider failures', async () => {
  const audio = Buffer.from('context microphone');
  assert.equal((await SpeechToTextNode.execute({}, { audioBuffer: audio, audioFormat: 'mp3' }, {})).transcribed, true);
  assert.equal((requests.at(-1)!.get('file') as File).name, 'audio.mp3');
  const count = requests.length;
  assert.equal((await SpeechToTextNode.execute({}, {}, {})).transcribed, false);
  assert.equal(requests.length, count);
  globalThis.fetch = async url => String(url).endsWith('/health')
    ? Response.json({ status: 'ready' }) : new Response('Recognizer unavailable', { status: 500 });
  const failed = await SpeechToTextNode.execute({ audioBuffer: audio }, {}, {});
  assert.equal(failed.transcribed, false);
  assert.match(failed.error, /Recognizer unavailable/);
});

function cliService() {
  const python = path.join(root, 'venv', 'bin', 'python3');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  // Exists for production configuration checks, but cannot execute a model.
  fs.writeFileSync(python, 'non-executable CLI fixture', { mode: 0o600 });
  return new WhisperService({ model: 'fixture', device: 'cpu', computeType: 'int8', language: 'en',
    server: { useServer: false, autoStart: false, url: 'http://fixture.invalid', port: 0 } });
}

function cliChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

test('concurrent CLI requests transcribe their own audio and remove only their temporary files', async context => {
  const service = cliService();
  context.mock.method(Date, 'now', () => 123456);
  const jobs: { file: string; child: ReturnType<typeof cliChild> }[] = [];
  spawnFixture = (_python, args) => {
    const file = args[5];
    assert.ok(file);
    const child = cliChild(); jobs.push({ file, child }); return child;
  };
  try {
    const first = service.transcribe(Buffer.from('first utterance'), 'wav');
    const second = service.transcribe(Buffer.from('second utterance'), 'wav');
    assert.equal(jobs.length, 2);
    const contents = jobs.map(job => fs.readFileSync(job.file, 'utf8'));
    jobs.forEach((job, index) => {
      job.child.stdout.emit('data', Buffer.from(JSON.stringify({ text: contents[index], language: 'en', language_probability: 1 })));
      job.child.emit('close', 0);
    });
    assert.deepEqual(await Promise.all([first, second]), ['first utterance', 'second utterance']);
    assert.ok(jobs.every(job => !fs.existsSync(job.file)), 'Each request cleans its own file after child completion');
  } finally {
    spawnFixture = () => { throw new Error('Unexpected subprocess in STT fixture'); };
  }
});

test('CLI failures retain Unicode diagnostics split across pipe chunks', async () => {
  const service = cliService();
  const diagnostic = 'Unable to read /audio/你好-café-🤖.wav';
  spawnFixture = () => {
    const child = cliChild();
    queueMicrotask(() => {
      for (const byte of Buffer.from(diagnostic)) child.stderr.write(Buffer.from([byte]));
      child.stderr.end();
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  };
  try {
    await assert.rejects(service.transcribe(Buffer.from('audio')), {
      message: `Whisper process exited with code 1: ${diagnostic}`,
    });
  } finally {
    spawnFixture = () => { throw new Error('Unexpected subprocess in STT fixture'); };
  }
});

test('CLI write failure removes its partial audio without launching transcription', async context => {
  const service = cliService();
  const write = fs.writeFileSync;
  const failure = new Error('Fixture storage write failed');
  let partial = '';
  context.mock.method(fs, 'writeFileSync', (file: any, data: any, options: any) => {
    if (String(file).includes('/voice-cache/stt_')) {
      partial = String(file); write(file, Buffer.from('partial')); throw failure;
    }
    return write(file, data, options);
  });
  let spawned = false;
  spawnFixture = () => { spawned = true; throw new Error('A failed write cannot start a child'); };
  try {
    await assert.rejects(service.transcribe(Buffer.from('private utterance'), 'wav'), error => error === failure);
    assert.ok(partial);
    assert.equal(spawned, false);
    assert.equal(fs.existsSync(partial), false, 'A failed write must not retain partial private audio');
  } finally {
    if (partial && fs.existsSync(partial)) fs.unlinkSync(partial);
    spawnFixture = () => { throw new Error('Unexpected subprocess in STT fixture'); };
  }
});


test('CLI configuration remains data when model paths and language contain Python syntax', async () => {
  cliService();
  const model = "models/robot's \\voice\nbase";
  const language = "en'); raise RuntimeError('config must remain data";
  const hotwords = "Ainekio's name\nquoted \"speech\"";
  const service = new WhisperService({ model, device: 'cuda', computeType: 'int8', language,
    server: { useServer: false, autoStart: false, url: 'http://fixture.invalid', port: 0 } });
  let file = '';
  spawnFixture = (_python, args) => {
    assert.equal(args[0], '-c');
    assert.equal(args[1].includes(model), false, 'Model configuration must not become executable source');
    assert.equal(args[1].includes(language), false, 'Language configuration must not become executable source');
    assert.deepEqual(args.slice(2, 5), [model, 'cuda', 'float16']);
    file = args[5];
    assert.equal(fs.readFileSync(file, 'utf8'), 'own audio');
    assert.deepEqual(args.slice(6), [language, hotwords]);
    const child = cliChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'complete transcript', language: 'en', language_probability: 1 })));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    assert.equal(await service.transcribe(Buffer.from('own audio'), 'wav', hotwords), 'complete transcript');
    assert.equal(fs.existsSync(file), false);
  } finally {
    spawnFixture = () => { throw new Error('Unexpected subprocess in STT fixture'); };
  }
});


test('health deadline covers the response body and releases a stalled probe', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      release = () => reject(new Error('Fixture cleanup'));
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }) } as Response;
  };
  const service = new WhisperService({ model: 'fixture', device: 'cpu', computeType: 'int8', language: 'en',
    server: { useServer: true, autoStart: false, url: 'http://fixture.invalid', port: 0 } });
  const status = service.getStatus();
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    context.mock.timers.tick(2000);
    assert.equal(signal!.aborted, true, 'The existing health deadline must remain active until JSON completes');
    assert.equal((await status).serverAvailable, false);
  } finally {
    release?.();
    await status;
  }
});


test('failed health probes release their deadline timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal;
    throw new Error('Fixture connection refused');
  };
  const service = new WhisperService({ model: 'fixture', device: 'cpu', computeType: 'int8', language: 'en',
    server: { useServer: true, autoStart: false, url: 'http://fixture.invalid', port: 0 } });
  assert.equal((await service.getStatus()).serverAvailable, false);
  context.mock.timers.tick(2000);
  assert.equal(signal!.aborted, false, 'A completed failed probe must not retain a timer');
});


test('auto-start uses the readiness result from the service owner without a second polling loop', async () => {
  let healthChecks = 0;
  let starts = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/health')) {
      healthChecks++;
      return Response.json({ status: 'loading' });
    }
    assert.equal(new URL(String(url)).pathname, '/transcribe');
    return Response.json({ text: 'Ready through the service owner.', language: 'en', language_probability: 1 });
  };
  ensureFixture = async id => {
    assert.equal(id, 'whisper'); starts++;
    return { healthy: true, readiness: 'ready', health: { status: 'ready' } };
  };
  try {
    const service = new WhisperService({ model: 'fixture', device: 'cpu', computeType: 'int8', language: 'en',
      server: { useServer: true, autoStart: true, url: 'http://fixture.invalid', port: 0 } });
    assert.equal(await service.transcribe(Buffer.from('fixture')), 'Ready through the service owner.');
    assert.equal(starts, 1);
    assert.equal(healthChecks, 1);
  } finally {
    ensureFixture = async () => { throw new Error('Unexpected service startup in STT fixture'); };
  }
});
