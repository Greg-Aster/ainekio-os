import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-stream-freshness-'));
process.env.METAHUMAN_ROOT = root;
process.env.MH_ENVIRONMENT_BRIDGE_TOKEN = 'fixture-token';
const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { setAuditEnabled } = await import('../audit.js');
setAuditEnabled(false);
const bridge = await import('./index.js');
let dispatch: (() => void) | undefined;
let reads: object[] = [];
let dispatchError: Error | undefined;
let releases = 0;
mock.module('./index.js', { namedExports: { ...bridge,
  subscribeEnvironmentActions: (_session: string, callback: () => void) => {
    dispatch = callback;
    return () => { dispatch = undefined; };
  },
  dispatchEnvironmentVisualReads: () => { if (dispatchError) throw dispatchError; return reads.splice(0); },
  dispatchEnvironmentActions: () => [],
  pendingEnvironmentCancellations: () => [],
  releaseEnvironmentStreamWork: () => { releases += 1; },
} });
const { handleEnvironmentBridgeStream } = await import('../api/handlers/environment-bridge.js');

test('continuous camera reads retain connection freshness until stream disconnects', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T00:00:00Z') });
  const sessionId = 'fixture-body';
  bridge.writeEnvironmentBridgeState({ enabled: true, updatedAt: new Date().toISOString(), feedback: [], sessions: {
    [sessionId]: { sessionId, environmentId: 'fixture', adapter: 'fixture', status: 'connected',
      connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() },
  } } as never);
  const abort = new AbortController();
  const response = await handleEnvironmentBridgeStream({ method: 'GET', path: '/api/environment-bridge/stream',
    headers: { Authorization: 'Bearer fixture-token' }, query: { sessionId }, signal: abort.signal,
    user: { isAuthenticated: false } } as never);
  const stream = response.stream![Symbol.asyncIterator]();
  try {
    assert.match((await stream.next()).value, /event: connected/);
    for (let i = 1; i <= 8; i++) {
      mock.timers.tick(10_000);
      reads.push({ requestId: `read-${i}`, sessionId });
      dispatch!();
      assert.match((await stream.next()).value, /event: visual-reads/);
      const session = bridge.summarizeEnvironmentBridgeState().sessions.find(item => item.sessionId === sessionId)!;
      assert.equal(session.status, 'connected', `Camera read ${i} must refresh the live session`);
      assert.equal(session.lastSeenAt, new Date().toISOString());
    }
  } finally {
    abort.abort();
    await stream.return?.();
  }
  assert.equal(dispatch, undefined);
  mock.timers.tick(46_000);
  assert.equal(bridge.summarizeEnvironmentBridgeState().sessions[0].status, 'stale');
});

test.after(() => { mock.timers.reset(); mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

test('stream setup failure releases its subscription and owned reads', async () => {
  const before = releases;
  dispatchError = new Error('fixture dispatch failure');
  const response = await handleEnvironmentBridgeStream({ method: 'GET', path: '/api/environment-bridge/stream',
    headers: { Authorization: 'Bearer fixture-token' }, query: { sessionId: 'fixture-body' },
    user: { isAuthenticated: false } } as never);
  try {
    await assert.rejects(response.stream![Symbol.asyncIterator]().next(), /fixture dispatch failure/);
    assert.equal(dispatch, undefined);
    assert.equal(releases, before + 1);
  } finally { dispatchError = undefined; }
});

test('disconnect releases work while the consumer is paused at a yielded event', async () => {
  const before = releases;
  const abort = new AbortController();
  const response = await handleEnvironmentBridgeStream({ method: 'GET', path: '/api/environment-bridge/stream',
    headers: { Authorization: 'Bearer fixture-token' }, query: { sessionId: 'fixture-body' }, signal: abort.signal,
    user: { isAuthenticated: false } } as never);
  const stream = response.stream![Symbol.asyncIterator]();
  assert.match((await stream.next()).value, /event: connected/);
  abort.abort();
  assert.equal(dispatch, undefined, 'Disconnected transport cannot retain a live subscriber');
  assert.equal(releases, before + 1, 'Read cleanup must not wait for another consumer pull');
  await stream.return?.();
  assert.equal(releases, before + 1, 'Cleanup is performed once');
});

test('another process sees a complete connected Bridge snapshot throughout repeated publication', () => {
  const stateFile = bridge.getEnvironmentBridgeStatePath();
  const originalWrite = fs.writeFileSync;
  const timestamp = new Date().toISOString();
  let previous = bridge.writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    'publication-body': { sessionId: 'publication-body', environmentId: 'fixture', adapter: 'fixture', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp, connectionRevision: 1,
      latestBodyEvent: { identity: 'reported-tip', observedAt: timestamp, robotId: 'fixture', epoch: 1 } },
  } });
  const reader = `const { eventBus } = await import(${JSON.stringify(new URL('../infrastructure/event-bus/client.ts', import.meta.url).href)});
    eventBus.disconnect();
    const { readEnvironmentBridgeState } = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
    console.log(JSON.stringify(readEnvironmentBridgeState()));`;
  let readsDuringWrite = 0;
  const write = mock.method(fs, 'writeFileSync', ((file, data, options) => {
    if (typeof file !== 'string' || !file.startsWith(stateFile)) return originalWrite(file, data, options);
    const text = String(data), midpoint = Math.floor(text.length / 2);
    originalWrite(file, text.slice(0, midpoint), options);
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', reader], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(observed, previous, 'An unfinished write must not erase the committed connection or its retained wake evidence');
    readsDuringWrite++;
    originalWrite(file, text.slice(midpoint), { flag: 'a' });
  }) as typeof fs.writeFileSync);
  try {
    for (let revision = 2; revision <= 4; revision++) {
      const next = structuredClone(previous);
      next.sessions['publication-body'].connectionRevision = revision;
      previous = bridge.writeEnvironmentBridgeState(next);
      assert.deepEqual(bridge.readEnvironmentBridgeState(), previous);
    }
    assert.equal(readsDuringWrite, 3);
  } finally { write.mock.restore(); }
});

test('an interrupted Bridge write retains the committed state and publishes no state-change notification', async () => {
  const timestamp = new Date().toISOString();
  const previous = bridge.writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    'interrupted-body': { sessionId: 'interrupted-body', environmentId: 'fixture', adapter: 'fixture', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp, connectionRevision: 3 },
  } });
  await Promise.resolve();
  const stateFile = bridge.getEnvironmentBridgeStatePath();
  const originalWrite = fs.writeFileSync;
  const failure = new Error('fixture interrupted write');
  let notifications = 0;
  const unsubscribe = bridge.subscribeEnvironmentBridgeState(() => { notifications++; });
  const write = mock.method(fs, 'writeFileSync', ((file, data, options) => {
    if (typeof file !== 'string' || !file.startsWith(stateFile)) return originalWrite(file, data, options);
    originalWrite(file, String(data).slice(0, 20), options);
    throw failure;
  }) as typeof fs.writeFileSync);
  try {
    assert.throws(() => bridge.writeEnvironmentBridgeState({ ...previous, enabled: false }), error => error === failure);
    assert.deepEqual(bridge.readEnvironmentBridgeState(), previous);
    await Promise.resolve();
    assert.equal(notifications, 0);
    assert.equal(fs.readdirSync(path.dirname(stateFile)).filter(file => file.startsWith(`${path.basename(stateFile)}.`)).length, 0);
  } finally { write.mock.restore(); unsubscribe(); }
});


test('stream traffic and disconnect release each displaced heartbeat timer', async () => {
  const timestamp = new Date().toISOString();
  bridge.writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    'fixture-body': { sessionId: 'fixture-body', environmentId: 'fixture', adapter: 'fixture', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp },
  } });
  await Promise.resolve();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const schedule = mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 15_000) timers.add(timer);
    return timer;
  }) as typeof setTimeout);
  const cancel = mock.method(globalThis, 'clearTimeout', ((timer: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(timer as ReturnType<typeof setTimeout>);
    originalClearTimeout(timer);
  }) as typeof clearTimeout);
  const abort = new AbortController();
  const response = await handleEnvironmentBridgeStream({ method: 'GET', path: '/api/environment-bridge/stream',
    headers: { Authorization: 'Bearer fixture-token' }, query: { sessionId: 'fixture-body' }, signal: abort.signal,
    user: { isAuthenticated: false } } as never);
  const stream = response.stream![Symbol.asyncIterator]();
  try {
    assert.match((await stream.next()).value, /event: connected/);
    for (let index = 0; index < 3; ++index) {
      const pending = stream.next();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(timers.size, 1, 'An idle stream owns exactly one heartbeat timer');
      reads.push({ requestId: `timer-read-${index}` });
      dispatch!();
      assert.match((await pending).value, /event: visual-reads/);
      assert.equal(timers.size, 0, 'Traffic must cancel the displaced heartbeat timer');
    }
    const pending = stream.next();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(timers.size, 1);
    abort.abort();
    assert.equal((await pending).done, true);
    assert.equal(timers.size, 0, 'Disconnect must release the idle heartbeat timer');
  } finally {
    abort.abort();
    await stream.return?.();
    for (const timer of timers) originalClearTimeout(timer);
    schedule.mock.restore();
    cancel.mock.restore();
  }
});
