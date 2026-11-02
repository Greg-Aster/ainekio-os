import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-connection-modes-'));
process.env.METAHUMAN_ROOT = fixture;
fs.mkdirSync(path.join(fixture, 'etc'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
const credentialFile = path.join(fixture, 'access.env');
fs.writeFileSync(credentialFile, 'TUNNEL_SERVICE_TOKEN_ID=fixture-id\nTUNNEL_SERVICE_TOKEN_SECRET=fixture-secret\n', { mode: 0o600 });
fs.writeFileSync(path.join(fixture, 'etc/services.json'), JSON.stringify({ services: {
  'environment-bridge': { adapterUrl: 'ws://127.0.0.1:8790/environment', remoteAdapterUrl: 'ws://127.0.0.1:18790/environment',
    cloudflareHostname: 'fixture.invalid', accessEnvFile: credentialFile },
} }));
fs.writeFileSync(path.join(fixture, 'bin/fixture.mjs'), `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(fixture, 'forwarder.json'))}, JSON.stringify({
  pid: process.pid, args: process.argv.slice(2),
  id: process.env.TUNNEL_SERVICE_TOKEN_ID, secret: process.env.TUNNEL_SERVICE_TOKEN_SECRET,
}));
setInterval(() => {}, 1000);
`);
fs.writeFileSync(path.join(fixture, 'bin/connect-environment'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(fixture, 'bin/fixture.mjs')}' "$@"\n`, { mode: 0o700 });
process.env.MH_ENVIRONMENT_ADAPTER_URL = 'ws://old-shared.invalid/environment';
process.env.MH_ENVIRONMENT_ADAPTER_TOKEN = 'fixture-adapter';
process.env.MH_ENVIRONMENT_BRIDGE_TOKEN = 'fixture-core';
const { readConfig } = await import('./core.js');
const { startRemoteForwarder } = await import('./forwarder.js');

async function runRemoteForwarder(url: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<void>) {
  const tunnel = startRemoteForwarder(url, signal);
  try {
    await work(tunnel.signal);
    if (tunnel.failure()) throw tunnel.failure();
  } finally { await tunnel.stop(); }
}

async function forwarder(): Promise<{ pid: number; args: string[]; id: string; secret: string }> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(fixture, 'forwarder.json'))) return JSON.parse(fs.readFileSync(path.join(fixture, 'forwarder.json'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Fixture forwarder did not start');
}

test('separate adapter settings ignore the obsolete shared endpoint override', () => {
  assert.equal(readConfig().adapterUrl, 'ws://127.0.0.1:8790/environment');
  assert.equal(readConfig().remoteAdapterUrl!, 'ws://127.0.0.1:18790/environment');
  assert.equal(readConfig().transport, 'local', 'Saving remote settings does not select a remote connection');
});

test('Remote owns the forwarder, supplies private machine auth, and stops it on agent stop', async () => {
  const controller = new AbortController();
  let pid = 0;
  await runRemoteForwarder(readConfig().remoteAdapterUrl!, controller.signal, async () => {
    const current = await forwarder();
    pid = current.pid;
    assert.deepEqual(current.args, ['fixture.invalid', '18790']);
    assert.equal(current.id, 'fixture-id');
    assert.equal(current.secret, 'fixture-secret');
    controller.abort();
  });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Remote reports forwarder failure rather than claiming a working agent', async () => {
  fs.unlinkSync(path.join(fixture, 'forwarder.json'));
  const controller = new AbortController();
  await assert.rejects(runRemoteForwarder(readConfig().remoteAdapterUrl!, controller.signal, async signal => {
    const current = await forwarder();
    process.kill(current.pid, 'SIGTERM');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }), /cloudflare forwarder exited/);
  assert.equal(controller.signal.aborted, false, 'Tunnel failure must not stop the agent reconnect owner');
  fs.unlinkSync(path.join(fixture, 'forwarder.json'));
  let replacementPid = 0;
  await runRemoteForwarder(readConfig().remoteAdapterUrl!, controller.signal, async signal => {
    replacementPid = (await forwarder()).pid;
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
  });
  assert.throws(() => process.kill(replacementPid, 0), { code: 'ESRCH' });
});

test('LAN/Wi-Fi SSH uses the configured machine and loopback gateway; owns cleanup', async () => {
  const configPath = path.join(fixture, 'etc/services.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.services['environment-bridge'].transport = 'ssh';
  config.services['environment-bridge'].sshTarget = 'operator@another-computer.invalid';
  config.services['environment-bridge'].sshGatewayPort = 9876;
  // A Cloudflare credential file must not be read for an SSH route.
  config.services['environment-bridge'].accessEnvFile = '/missing/cloudflare.env';
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.copyFileSync(path.join(fixture, 'bin/connect-environment'), path.join(fixture, 'bin/ssh'));
  fs.chmodSync(path.join(fixture, 'bin/ssh'), 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${path.join(fixture, 'bin')}:${originalPath}`;
  fs.unlinkSync(path.join(fixture, 'forwarder.json'));
  const controller = new AbortController();
  let pid = 0;
  try {
    await runRemoteForwarder(readConfig().remoteAdapterUrl!, controller.signal, async () => {
      const current = await forwarder();
      pid = current.pid;
      assert.deepEqual(current.args, ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-L', '127.0.0.1:18790:127.0.0.1:9876', '--', 'operator@another-computer.invalid']);
      assert.equal(current.id, undefined);
      assert.equal(current.secret, undefined);
      controller.abort();
    });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { process.env.PATH = originalPath; }
});

test('missing SSH destination reports configuration error without starting bridge', async () => {
  const configPath = path.join(fixture, 'etc/services.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.services['environment-bridge'].sshTarget = '';
  fs.writeFileSync(configPath, JSON.stringify(config));
  let started = false;
  await assert.rejects(runRemoteForwarder(readConfig().remoteAdapterUrl!,
    new AbortController().signal, async () => { started = true; }), /Configure.*SSH destination/);
  assert.equal(started, false);
});

test.after(() => { fs.rmSync(fixture, { recursive: true, force: true }); });
