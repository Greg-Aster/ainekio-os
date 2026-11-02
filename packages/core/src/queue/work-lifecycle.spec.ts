import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-work-lifecycle-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => { throw new Error('Network is forbidden in work lifecycle tests'); };
const { setAuditEnabled } = await import('../audit.js');
setAuditEnabled(false);
const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { UnifiedQueueManager } = await import('./unified-queue-manager.js');
const { ExecutionEngine } = await import('./execution-engine.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const input = { type: 'generic' as const, source: 'system' as const, username: 'fixture', input: {} };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected work transition did not occur');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('priority, independent execution and completion advance without another admission', async () => {
  const manager = new UnifiedQueueManager();
  const engine = new ExecutionEngine({}, manager);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const seen: string[] = [];
  engine.registerHandler('fixture.work', async task => {
    seen.push(task.input.name);
    if (task.input.name === 'urgent') await held;
    return {};
  });
  const ordinary = manager.enqueue({ ...input, handler: 'fixture.work', resource: 'shared', priority: 'normal', input: { name: 'ordinary' } });
  manager.enqueue({ ...input, handler: 'fixture.work', resource: 'shared', priority: 'critical', input: { name: 'urgent' } });
  const parallel = manager.enqueue({ ...input, handler: 'fixture.work', resource: 'separate', priority: 'low', input: { name: 'parallel' } });
  engine.start();
  try {
    await until(() => manager.getTask(parallel.id)?.state === 'completed');
    assert.deepEqual(seen, ['urgent', 'parallel']);
    assert.equal(manager.getTask(ordinary.id)?.state, 'queued');
    finish();
    await until(() => manager.getTask(ordinary.id)?.state === 'completed');
    assert.deepEqual(seen, ['urgent', 'parallel', 'ordinary']);
  } finally { finish(); await engine.stop(); }
});

test('an unavailable executor fails once; Bridge work retains its real external owner', async () => {
  const manager = new UnifiedQueueManager();
  const engine = new ExecutionEngine({}, manager);
  const missing = manager.enqueue({ ...input, handler: 'fixture.missing', resource: 'missing', maxAttempts: 3 });
  const bridge = manager.enqueue({ ...input, handler: 'environment.visual-read', resource: 'camera', input: { sessionId: 'fixture' } });
  engine.start();
  try {
    await until(() => manager.getTask(missing.id)?.state === 'failed');
    assert.equal(manager.getTask(missing.id)?.error?.code, 'missing_work_handler');
    assert.equal(manager.getTask(missing.id)?.attempt, 0);
    assert.equal(manager.getTask(bridge.id)?.state, 'queued');
  } finally { await engine.stop(); }
});

test('cancellation remains attached to finite work until its result and releases the next job', async () => {
  const manager = new UnifiedQueueManager();
  const engine = new ExecutionEngine({}, manager);
  engine.registerHandler('fixture.cancel', async (_task, context) => {
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { lateSuccess: true };
  });
  engine.registerHandler('fixture.next', async () => ({ done: true }));
  const first = manager.enqueue({ ...input, handler: 'fixture.cancel', resource: 'shared' });
  const next = manager.enqueue({ ...input, handler: 'fixture.next', resource: 'shared' });
  engine.start();
  try {
    await until(() => manager.getTask(first.id)?.state === 'leased');
    manager.cancel(first.id, 'Cancelled by fixture');
    await until(() => manager.getTask(next.id)?.state === 'completed');
    assert.equal(manager.getTask(first.id)?.state, 'cancelled');
    assert.equal(manager.getTask(first.id)?.result, undefined);
  } finally { await engine.stop(); }
});
