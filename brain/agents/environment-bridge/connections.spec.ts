import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { runBodyConnection, type BodyConnection } from './connections.js';

async function host(robotId?: string) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let robot = robotId;
  const sockets = new Set<WebSocket>();
  const message = () => JSON.stringify({ type: 'bridge.availability', version: 1,
    sessionId: 'shared-session', gatewayInstance: String(server.address()), robotId: robot, connected: !!robot });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      assert.deepEqual(JSON.parse(raw.toString()), { type: 'bridge.watch', version: 1, token: 'fixture' });
      socket.send(message());
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/environment`,
    update(id?: string) { robot = id; sockets.forEach(socket => socket.send(message())); },
    async close() { sockets.forEach(socket => socket.terminate()); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function fixture(robotId?: string, availableRobot?: string) {
  const local = await host(availableRobot);
  const controller = new AbortController();
  let snapshot: BodyConnection[] = [];
  let observed: (() => void) | undefined;
  const active = new Set<string>(); const admitted: string[] = [];
  const run = runBodyConnection({ endpoints: [{ url: local.url }], token: 'fixture', robotId,
    async connect(url, signal, ready) {
      assert.equal(active.size, 0, 'Only one action stream may own the body session');
      active.add(url); admitted.push(url); ready();
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
      active.delete(url);
    },
    async changed(value) { snapshot = value; observed?.(); },
  }, controller.signal);
  return { local, active, admitted,
    async until(predicate: (value: BodyConnection[]) => boolean) {
      if (predicate(snapshot)) return;
      await new Promise<void>(resolve => { observed = () => { if (predicate(snapshot)) { observed = undefined; resolve(); } }; });
    },
    async close() { controller.abort(); await run; await local.close(); assert.equal(active.size, 0); },
  };
}

test('selected host follows robot availability and reconnects without duplicate streams', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.until(states => states.every(state => !!state.sessionId));
    assert.equal(f.admitted.length, 0, 'Listening gateways without robots must not be activated');
    f.local.update('robot-a');
    await f.until(states => states[0].active);
    f.local.update('robot-a');
    await f.until(states => states[0].connected);
    assert.equal(f.admitted.length, 1, 'An unchanged body must not replace its active connection');
    f.local.update();
    await f.until(states => states.every(state => !state.active));
    f.local.update('robot-a');
    await f.until(states => states[0].active);
    assert.deepEqual(f.admitted, [f.local.url, f.local.url]);
  } finally { await f.close(); }
});

test('explicit robot selection does not activate a different body on the selected host', { timeout: 10000 }, async () => {
  const selected = await fixture('robot-b', 'robot-a');
  try {
    await selected.until(states => states[0].connected && states[0].robotId === 'robot-a');
    assert.equal(selected.admitted.length, 0);
    selected.local.update('robot-b');
    await selected.until(states => states[0].active);
    selected.local.update();
    await selected.until(states => states.every(state => !state.active));
    assert.deepEqual(selected.admitted, [selected.local.url]);
  } finally { await selected.close(); }
});

test('stopping a connection releases its active control stream', { timeout: 10000 }, async () => {
  const f = await fixture(undefined, 'robot-a');
  try {
    await f.until(states => states[0].active);
    assert.deepEqual([...f.active], [f.local.url]);
  } finally { await f.close(); }
});

async function roamingFixture(localRobot?: string, remoteRobot?: string, robotId = 'robot-a') {
  const local = await host(localRobot);
  const remote = await host(remoteRobot);
  const controller = new AbortController();
  let snapshot: BodyConnection[] = [];
  let changed: (() => void) | undefined;
  const active = new Set<string>();
  const admissions: string[] = [];
  let controlError: string | undefined;
  const run = runBodyConnection({ endpoints: [{ url: local.url }, { url: remote.url }], robotId, token: 'fixture',
    async connect(url, signal, ready) {
      if (controlError) throw new Error(controlError);
      assert.equal(active.size, 0, 'The old stream must be released before the next host starts');
      active.add(url); admissions.push(url); ready();
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); });
      active.delete(url);
    },
    async changed(value) { snapshot = value; changed?.(); },
  }, controller.signal);
  return { local, remote, admissions,
    failControl(message: string) { controlError = message; },
    recoverControl() { controlError = undefined; },
    async until(predicate: (value: BodyConnection[]) => boolean) {
      if (predicate(snapshot)) return;
      await new Promise<void>(resolve => { changed = () => { if (predicate(snapshot)) { changed = undefined; resolve(); } }; });
    },
    async close() { controller.abort(); await run; await local.close(); await remote.close(); assert.equal(active.size, 0); },
  };
}

test('automatic following moves remote to local and back without restarting the bridge or duplicating control', { timeout: 10000 }, async () => {
  const f = await roamingFixture(undefined, 'robot-a');
  try {
    await f.until(states => states[1].ready);
    f.local.update('robot-a');
    await f.until(states => states[0].connected);
    assert.deepEqual(f.admissions, [f.remote.url], 'A returning host cannot seize a working connection');
    f.remote.update();
    await f.until(states => states[0].ready && !states[1].active);
    f.remote.update('robot-a');
    await f.until(states => states[1].connected);
    assert.deepEqual(f.admissions, [f.remote.url, f.local.url]);
    f.local.update();
    await f.until(states => states[1].ready && !states[0].active);
    assert.deepEqual(f.admissions, [f.remote.url, f.local.url, f.remote.url]);
  } finally { await f.close(); }
});

test('automatic following excludes a different robot and reports loss instead of changing bodies', { timeout: 10000 }, async () => {
  const f = await roamingFixture('robot-a', 'robot-b');
  try {
    await f.until(states => states[0].ready && states[1].connected);
    f.local.update();
    await f.until(states => states.every(state => !state.active && !state.ready));
    assert.deepEqual(f.admissions, [f.local.url]);
    f.remote.update('robot-a');
    await f.until(states => states[1].ready);
    assert.deepEqual(f.admissions, [f.local.url, f.remote.url]);
  } finally { await f.close(); }
});

test('a failed Core action stream stays visibly not ready while its gateway is available and recovers', { timeout: 10000 }, async () => {
  const f = await roamingFixture();
  try {
    f.failControl('Environment action stream failed (503)');
    f.local.update('robot-a');
    await f.until(states => states[0].connected && states[0].error?.includes('503') === true && !states[0].ready);
    f.recoverControl();
    await f.until(states => states[0].ready && !states[0].error);
    assert.deepEqual(f.admissions, [f.local.url]);
  } finally { await f.close(); }
});
