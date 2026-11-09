import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const root = mkdtempSync(path.join(tmpdir(), 'metahuman-event-owner-'));
process.env.METAHUMAN_ROOT = root;
const repo = new URL('../../../../../', import.meta.url).pathname;
const { EventBusServer, startEventBusProcess, stopEventBusProcess } = await import('./server.js');
const { handlePostEventBusStatus } = await import('../../api/handlers/event-bus-status.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('owns one server lifecycle and persists startup and shutdown events', async t => {
  const logsDir = mkdtempSync(path.join(tmpdir(), 'metahuman-event-bus-'));
  t.after(() => rmSync(logsDir, { recursive: true, force: true }));

  const server = new EventBusServer({ port: 0, logsDir });
  await server.start();

  await assert.rejects(server.start(), /already started/);
  assert.equal(server.getStats().eventCount, 1);

  await server.stop();
  await server.stop();

  const logFile = path.join(logsDir, `${new Date().toISOString().slice(0, 10)}.ndjson`);
  const events = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['core.started', 'core.shutdown']);
});

test('delivers audit events live without persisting a second audit copy', async t => {
  const logsDir = mkdtempSync(path.join(tmpdir(), 'ainekio-audit-delivery-'));
  t.after(() => rmSync(logsDir, { recursive: true, force: true }));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const server = new EventBusServer({ port, logsDir });
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await once(socket, 'open');
    for (const event of [
      { source: 'audit', event: 'audit.security', data: { event: 'fixture-login' } },
      { source: 'core', event: 'fixture-non-audit', data: {} },
    ]) {
      const received = once(socket, 'message');
      socket.send(JSON.stringify(event));
      assert.deepEqual(JSON.parse(String((await received)[0])), event);
    }
  } finally { socket.terminate(); await server.stop(); }
  const filename = path.join(logsDir, `${new Date().toISOString().slice(0, 10)}.ndjson`);
  const stored = readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(stored.some(event => event.source === 'audit'), false);
  assert.equal(stored.some(event => event.event === 'fixture-non-audit'), true);
});

test('process ownership survives caller changes and preserves event delivery through restart', async () => {
  const core = path.join(root, 'packages/core/src');
  const folder = path.join(core, 'infrastructure/event-bus');
  mkdirSync(folder, { recursive: true });
  copyFileSync(new URL('./server.ts', import.meta.url), path.join(folder, 'server.ts'));
  for (const file of ['path-builder.ts', 'locks.ts']) symlinkSync(path.join(repo, 'packages/core/src', file), path.join(core, file));
  symlinkSync(new URL('./schema.ts', import.meta.url).pathname, path.join(folder, 'schema.ts'));
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const pidFile = path.join(root, 'logs/run/event-bus.pid');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await startEventBusProcess(port);
      assert.equal(status.healthy, true);
      const pid = readFileSync(pidFile, 'utf8');
      assert.equal((await startEventBusProcess(port)).pid, Number(pid));
      const listener = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(listener, 'open');
      const received = once(listener, 'message');
      const event = { timestamp: new Date().toISOString(), source: 'core', event: 'fixture.delivery', data: { attempt } };
      listener.send(JSON.stringify(event));
      assert.deepEqual(JSON.parse(String((await received)[0])), event);
      const closed = once(listener, 'close');
      if (attempt === 0) {
        const stopped = await handlePostEventBusStatus({ body: { action: 'stop' } } as any);
        assert.equal(stopped.status, 200, JSON.stringify(stopped));
      } else {
        await promisify(execFile)(path.join(repo, 'bin/stop-event-bus'), [], { env: { ...process.env, METAHUMAN_ROOT: root } });
      }
      await closed;
      assert.equal(existsSync(pidFile), false);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
      await stopEventBusProcess(port);
    }
  } finally { await stopEventBusProcess(port); }
});
