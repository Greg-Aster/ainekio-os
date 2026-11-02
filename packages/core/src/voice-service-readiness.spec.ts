import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-voice-ready-'));
process.env.METAHUMAN_ROOT = root;
const { ensureVoiceServiceRunning, stopVoiceService } = await import('./voice-service-manager.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });

test('Kokoro startup waits for the existing loading process to become ready', async () => {
  const run = path.join(root, 'logs/run'); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'kokoro-server.pid'), String(process.pid));
  let calls = 0;
  globalThis.fetch = async () => Response.json({ status: ++calls < 4 ? 'loading' : 'ready' });
  const status = await ensureVoiceServiceRunning('kokoro');
  assert.equal(status.healthy, true);
  assert.equal(status.readiness, 'ready');
  assert.equal(calls, 4);
  assert.equal(status.pid, process.pid, 'Loading must reuse the running service');
  globalThis.fetch = async () => Response.json({ status: 'error' });
  await assert.rejects(ensureVoiceServiceRunning('kokoro'), /failed while waiting for readiness/);
  fs.rmSync(path.join(run, 'kokoro-server.pid'));
});

test('voice stop waits for its child and preserves a replacement PID receipt', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const replacementExited = once(replacement, 'exit');
  const pidFile = path.join(root, 'logs/run/kokoro-server.pid');
  try {
    await once(child.stdout!, 'data');
    fs.writeFileSync(pidFile, String(child.pid));
    const stopping = stopVoiceService('kokoro');
    fs.writeFileSync(pidFile, String(replacement.pid));
    const result = await stopping;
    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(replacement.pid));
    await exited;
    assert.equal((await stopVoiceService('kokoro')).success, true);
    assert.equal(fs.existsSync(pidFile), false);
    globalThis.fetch = async () => { throw new Error('No fixture server'); };
    assert.equal((await stopVoiceService('kokoro')).success, true);
  } finally {
    child.kill('SIGKILL'); replacement.kill('SIGKILL');
    await Promise.all([exited, replacementExited]);
    fs.rmSync(pidFile, { force: true });
    globalThis.fetch = originalFetch;
  }
});

test('voice stop retains ownership on a signal error and confirms forced termination', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const pidFile = path.join(root, 'logs/run/kokoro-server.pid');
  const kill = process.kill;
  try {
    await once(child.stdout!, 'data');
    fs.writeFileSync(pidFile, String(child.pid));
    process.kill = (pid, signal) => {
      if (Math.abs(pid) === child.pid && signal !== 0) throw Object.assign(new Error('Fixture signal denied'), { code: 'EPERM' });
      return kill(pid, signal);
    };
    await assert.rejects(stopVoiceService('kokoro'), /Fixture signal denied/);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(child.pid));
    process.kill = kill;
    const result = await stopVoiceService('kokoro');
    assert.equal(result.success, true, result.message);
    if (fs.existsSync(`/proc/${child.pid}/stat`)) assert.match(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'), /\) Z /);
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(fs.existsSync(pidFile), false);
  } finally {
    process.kill = kill;
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(pidFile, { force: true });
  }
});
