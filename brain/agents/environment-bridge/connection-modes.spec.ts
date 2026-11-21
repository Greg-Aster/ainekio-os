import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import type { BodyConnection } from './connections.js';

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
const { runBodyConnection } = await import('./connections.js');

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

test('SSH forwarder captures stderr into failure diagnostics without leaking raw ssh lines to parent stderr', async () => {
  const configPath = path.join(fixture, 'etc/services.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.services['environment-bridge'].transport = 'ssh';
  config.services['environment-bridge'].sshTarget = 'greggles@10.77.42.2';
  config.services['environment-bridge'].sshGatewayPort = 8790;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const originalPath = process.env.PATH;
  fs.writeFileSync(path.join(fixture, 'bin/ssh'), `#!/bin/sh
echo "ssh: connect to host 10.77.42.2 port 22: No route to host" >&2
exit 255
`, { mode: 0o700 });
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { startRemoteForwarder } from ${JSON.stringify(path.resolve('brain/agents/environment-bridge/forwarder.ts'))};
    const c = new AbortController();
    const t = startRemoteForwarder('ws://127.0.0.1:18790/environment', c.signal);
    await new Promise(resolve => t.signal.addEventListener('abort', resolve, { once: true }));
    process.stdout.write(JSON.stringify({ message: t.failure()?.message, detail: t.detail() }));
    await t.stop();
  `], {
    env: { ...process.env, METAHUMAN_ROOT: fixture, PATH: `${path.join(fixture, 'bin')}:${originalPath}` },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '', 'SSH stderr must not leak into parent stderr');
  const lastLine = child.stdout.trim().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(lastLine) as { message?: string; detail?: string };
  assert.match(parsed.message ?? '', /ssh forwarder exited \(255\): ssh: connect to host 10\.77\.42\.2 port 22: No route to host/);
  assert.equal(parsed.detail, 'ssh: connect to host 10.77.42.2 port 22: No route to host');
});

test('followRobot backs off unreachable SSH retries without interrupting active local robot and wakes immediately on failover', { timeout: 10000 }, async () => {
  const localServer = new WebSocketServer({ port: 0 });
  const remoteServer = new WebSocketServer({ port: 0 });
  await Promise.all([
    new Promise<void>(resolve => localServer.once('listening', resolve)),
    new Promise<void>(resolve => remoteServer.once('listening', resolve)),
  ]);
  const localPort = (localServer.address() as { port: number }).port;
  const remotePort = (remoteServer.address() as { port: number }).port;
  let localRobot: string | undefined = 'ainekio-p4-e6ebe5';
  const localSockets = new Set<any>();
  localServer.on('connection', socket => {
    localSockets.add(socket);
    socket.on('close', () => localSockets.delete(socket));
    socket.on('message', () => socket.send(JSON.stringify({
      type: 'bridge.availability', version: 1, sessionId: 'local-session',
      gatewayInstance: `local:${localPort}`, robotId: localRobot, connected: !!localRobot,
    })));
  });
  let sshMode: 'fail' | 'ok' = 'fail';
  remoteServer.on('connection', socket => {
    if (sshMode === 'fail') { socket.terminate(); return; }
    socket.on('message', () => socket.send(JSON.stringify({
      type: 'bridge.availability', version: 1, sessionId: 'remote-session',
      gatewayInstance: `remote:${remotePort}`, robotId: 'ainekio-p4-e6ebe5', connected: true,
    })));
  });

  const configPath = path.join(fixture, 'etc/services.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.services['environment-bridge'].transport = 'ssh';
  config.services['environment-bridge'].sshTarget = 'greggles@10.77.42.2';
  config.services['environment-bridge'].sshGatewayPort = 8790;
  fs.writeFileSync(configPath, JSON.stringify(config));

  const attemptsFile = path.join(fixture, 'ssh-attempts.log');
  const modeFile = path.join(fixture, 'ssh-mode');
  fs.writeFileSync(modeFile, 'fail');
  fs.writeFileSync(path.join(fixture, 'bin/ssh'), `#!/bin/sh
echo "$(date +%s%3N)" >> '${attemptsFile}'
if [ "$(cat '${modeFile}')" = "fail" ]; then
  echo "ssh: connect to host 10.77.42.2 port 22: No route to host" >&2
  exit 255
fi
exec '${process.execPath}' -e 'setInterval(() => {}, 1000)'
`, { mode: 0o700 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${path.join(fixture, 'bin')}:${originalPath}`;
  const controller = new AbortController();
  let snapshot: BodyConnection[] = [];
  let changed: (() => void) | undefined;
  const until = (predicate: (value: BodyConnection[]) => boolean) => {
    if (predicate(snapshot)) return Promise.resolve();
    return new Promise<void>(resolve => {
      changed = () => { if (predicate(snapshot)) { changed = undefined; resolve(); } };
    });
  };
  const admitted: string[] = [];
  const run = runBodyConnection({
    endpoints: [
      { url: `ws://127.0.0.1:${localPort}/environment` },
      { url: `ws://127.0.0.1:${remotePort}/environment`, remote: true },
    ],
    token: 'fixture',
    reconnectBaseMs: 40,
    reconnectMaxMs: 320,
    async connect(url, connSignal, ready) {
      admitted.push(url);
      ready();
      await new Promise<void>(resolve => {
        if (connSignal.aborted) resolve();
        else connSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async changed(connections) { snapshot = connections; changed?.(); },
  }, controller.signal);

  try {
    await until(states => states[0]?.ready && states[0]?.connected && (states[1]?.error ?? '').includes('No route to host'));
    await new Promise(resolve => setTimeout(resolve, 450));
    const timestamps = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(Number);
    assert.ok(timestamps.length >= 3 && timestamps.length <= 5, `Expected backed-off SSH retries (3..5), got ${timestamps.length}`);
    assert.ok(timestamps.at(-1)! - timestamps.at(-2)! > timestamps[1] - timestamps[0], 'Retry interval must grow under backoff');
    assert.equal(snapshot[0].ready, true);
    assert.deepEqual(admitted, [`ws://127.0.0.1:${localPort}/environment`]);

    // Now make SSH succeed and drop the robot from Local: failover must wake immediately.
    sshMode = 'ok';
    fs.writeFileSync(modeFile, 'ok');
    localRobot = undefined;
    for (const socket of localSockets) {
      socket.send(JSON.stringify({
        type: 'bridge.availability', version: 1, sessionId: 'local-session',
        gatewayInstance: `local:${localPort}`, connected: false,
      }));
    }
    await until(states => states[1]?.ready && states[1]?.connected && !states[0]?.active);
    assert.equal(admitted.at(-1), `ws://127.0.0.1:${remotePort}/environment`);
  } finally {
    controller.abort();
    await run;
    process.env.PATH = originalPath;
    await Promise.all([
      new Promise<void>(resolve => localServer.close(() => resolve())),
      new Promise<void>(resolve => remoteServer.close(() => resolve())),
    ]);
  }
});

test.after(() => { fs.rmSync(fixture, { recursive: true, force: true }); });
