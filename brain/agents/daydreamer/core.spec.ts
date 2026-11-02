import assert from 'node:assert/strict';
import test from 'node:test';
import { setAuditEnabled } from '@metahuman/core';
import { evaluateDaydreamerGraph, normalizeTriggerProfile } from './core.js';
import agent, { meta, run } from './index.js';
import { graph, graphState, nodeIds } from './core.fixture.js';

setAuditEnabled(false);

test('system scheduler identity resolves through the active authenticated user', () => {
  assert.equal(normalizeTriggerProfile(undefined), null);
  assert.equal(normalizeTriggerProfile('system'), null);
  assert.equal(normalizeTriggerProfile('  system  '), null);
  assert.equal(normalizeTriggerProfile('SYSTEM'), null);
  assert.equal(normalizeTriggerProfile('Ainekio'), 'Ainekio');
});

test('Agent Runtime adapter is valid and rejects obsolete options', async () => {
  assert.equal(agent.meta, meta);
  assert.equal(agent.run, run);
  assert.equal(meta.id, 'daydreamer');
  const result = await run(
    { username: 'unused-test-user', dataDir: '/tmp' },
    { args: ['--force'] },
  );
  assert.equal(result.success, false);
  assert.match(result.error || '', /does not accept runtime options: --force/);
});

test('graph evaluation follows node types and requires both persistence owners', () => {
  assert.deepEqual(evaluateDaydreamerGraph(graph, graphState()), {
    daydreamsGenerated: 1,
    memoriesCurated: 5,
    avgAgeDays: 12,
  });

  assert.throws(
    () => evaluateDaydreamerGraph(graph, graphState({ dreamer_dream_saver: { saved: false, error: 'disk full' } })),
    /Episodic daydream persistence failed: disk full/,
  );
  assert.throws(
    () => evaluateDaydreamerGraph(graph, graphState({ inner_dialogue_buffer: { saved: false, error: 'buffer unavailable' } })),
    /Inner-dialogue persistence failed: buffer unavailable/,
  );
});

test('insufficient memory is an explicit successful skip, not a fabricated generation', () => {
  assert.deepEqual(
    evaluateDaydreamerGraph(graph, graphState({ dreamer_memory_curator: { count: 2, avgAgeDays: 3 } })),
    {
      daydreamsGenerated: 0,
      memoriesCurated: 2,
      avgAgeDays: 3,
      skippedReason: 'insufficient_memories',
    },
  );
});

test('failed graph execution is surfaced to the coordinator', () => {
  const failed = graphState({}, 'failed');
  failed.nodes.set(nodeIds.daydreamer_generator, {
    nodeId: nodeIds.daydreamer_generator,
    status: 'failed',
    startTime: 0,
    endTime: 1,
    inputs: {},
    error: new Error('model unavailable'),
  });

  assert.throws(
    () => evaluateDaydreamerGraph(graph, failed),
    /generator-arbitrary-id: model unavailable/,
  );
});

test('saved daydreams succeed while their asynchronous output delivery remains outstanding', () => {
  const waiting = graphState({}, 'waiting');
  assert.deepEqual(evaluateDaydreamerGraph(graph, waiting), {
    daydreamsGenerated: 1,
    memoriesCurated: 5,
    avgAgeDays: 12,
  });
  assert.equal(waiting.status, 'waiting', 'Evaluation must not settle the durable delivery');
  assert.throws(
    () => evaluateDaydreamerGraph(graph, graphState({ dreamer_dream_saver: { saved: false, error: 'disk full' } }, 'waiting')),
    /Episodic daydream persistence failed: disk full/,
  );
  assert.throws(
    () => evaluateDaydreamerGraph(graph, graphState({ inner_dialogue_buffer: { saved: false, error: 'buffer unavailable' } }, 'waiting')),
    /Inner-dialogue persistence failed: buffer unavailable/,
  );
});

test('an unfinished graph pass or event wait cannot be reported as a generated daydream', () => {
  const unfinished = graphState({}, 'waiting');
  delete unfinished.endTime;
  assert.throws(() => evaluateDaydreamerGraph(graph, unfinished), /graph did not complete/);
  const suspended = graphState({}, 'waiting');
  suspended.pending = [{ value: { reason: 'awaiting input' } }];
  assert.throws(() => evaluateDaydreamerGraph(graph, suspended), /graph did not complete/);
});
