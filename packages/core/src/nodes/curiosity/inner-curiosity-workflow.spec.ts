import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { RouterCallOptions, RouterMessage } from '../../model-router.js';
import { registerProfileStorageConfigGetter } from '../../path-builder.js';

import {
  executeInnerCuriosityAnswerGenerator,
} from './inner-curiosity-answer-generator.node.js';
import {
  executeInnerCuriosityComplete,
  executeInnerCuriosityEntry,
  executeInnerCuriosityNoMemories,
  executeInnerCuriosityPrepare,
  executeInnerCuriosityState,
  type InnerCuriosityReceipt,
} from './inner-curiosity-lifecycle.node.js';
import {
  executeInnerCuriosityMemorySearch,
} from './inner-curiosity-memory-search.node.js';
import {
  executeInnerCuriosityQuestionGenerator,
} from './inner-curiosity-question-generator.node.js';
import { executeCuriosityWeightedSampler } from './curiosity-weighted-sampler.node.js';

const NOW = '2026-09-03T16:00:00.000Z';
const CONTEXT = {
  username: 'test-user',
  userId: 'test-user',
  cognitiveMode: 'agent' as const,
  executionId: 'task-stable',
  executionTimestamp: NOW,
  requestedExecutionTimestamp: NOW,
  idempotencyKey: 'inner-curiosity:test-user:task-stable',
};
const DIAGNOSTICS = {
  filesConsidered: 1,
  filesRead: 1,
  skippedMalformed: 0,
  skippedOversize: 0,
  skippedGenerated: 0,
  skippedEmpty: 0,
};
const MEMORIES = [{ id: 'memory-1', content: 'A grounded recent experience.' }];
const SEARCH_RESULTS = [{ id: 'memory-2', text: 'A related indexed memory.' }];

test('state owns configuration plus completed and prepared retry admission', async t => {
  await t.test('disabled', async () => {
    const result = await executeInnerCuriosityState({}, CONTEXT, {}, {
      loadConfig: () => ({
        maxOpenQuestions: 3,
        researchMode: 'local',
        innerQuestionMode: 'off',
        minTrustLevel: 'observe',
      }),
      loadReceipt: () => null,
    });
    assert.equal(result.shouldGenerate, false);
    assert.deepEqual(result.outcome, {
      status: 'skipped',
      username: 'test-user',
      executionId: 'task-stable',
      reason: 'disabled',
    });
  });

  await t.test('prepared retry does not require a newly generated timestamp to match', async () => {
    const receipt: InnerCuriosityReceipt = {
      schemaVersion: 1,
      kind: 'inner-curiosity-execution',
      status: 'prepared',
      executionId: 'task-stable',
      idempotencyKey: CONTEXT.idempotencyKey,
      username: 'test-user',
      timestamp: NOW,
      question: 'What changed?',
      answer: 'One bounded answer.',
      innerDialogue: 'What changed? One bounded answer.',
      sourceMemoryIds: ['memory-1'],
      searchResultIds: ['memory-2'],
      sampling: DIAGNOSTICS,
      preparedAt: NOW,
    };
    const result = await executeInnerCuriosityState({}, {
      ...CONTEXT,
      executionTimestamp: '2026-09-03T16:05:00.000Z',
      requestedExecutionTimestamp: undefined,
    }, {}, {
      loadConfig: () => { throw new Error('configuration should not be loaded during retry'); },
      loadReceipt: () => receipt,
    });
    assert.equal(result.status, 'prepared');
    assert.equal(result.deduplicated, true);
    assert.equal(result.prepared, receipt);
  });

  await t.test('an explicitly conflicting coordinator timestamp fails', async () => {
    const receipt: InnerCuriosityReceipt = {
      schemaVersion: 1,
      kind: 'inner-curiosity-execution',
      status: 'completed',
      executionId: 'task-stable',
      idempotencyKey: CONTEXT.idempotencyKey,
      username: 'test-user',
      timestamp: NOW,
      question: 'What changed?',
      answer: 'One bounded answer.',
      innerDialogue: 'What changed? One bounded answer.',
      sourceMemoryIds: ['memory-1'],
      searchResultIds: ['memory-2'],
      sampling: DIAGNOSTICS,
      preparedAt: NOW,
      completedAt: NOW,
    };
    await assert.rejects(
      executeInnerCuriosityState({}, {
        ...CONTEXT,
        executionTimestamp: '2026-09-03T16:05:00.000Z',
        requestedExecutionTimestamp: '2026-09-03T16:05:00.000Z',
      }, {}, {
        loadConfig: () => { throw new Error('configuration should not be loaded'); },
        loadReceipt: () => receipt,
      }),
      /identity conflicts/,
    );
  });
});

test('saved receipts with the former truncation diagnostic remain readable without rewriting them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-curiosity-receipt-'));
  const username = `inner-curiosity-receipt-${process.pid}`;
  const executionId = 'retained-execution';
  const idempotencyKey = `inner-curiosity:${username}:${executionId}`;
  const directory = path.join(root, 'state', 'inner-curiosity');
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  registerProfileStorageConfigGetter(candidate => candidate === username ? { path: root, type: 'internal' } : undefined);
  const filename = path.join(directory, `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`);
  const saved = JSON.stringify({ schemaVersion: 1, kind: 'inner-curiosity-execution', status: 'completed',
    username, executionId, idempotencyKey, timestamp: NOW, question: 'A retained question.', answer: 'Its retained answer.',
    innerDialogue: 'A retained result.', sourceMemoryIds: ['source'], searchResultIds: ['related'],
    sampling: { ...DIAGNOSTICS, truncatedContent: 2 }, preparedAt: NOW, completedAt: NOW });
  fs.writeFileSync(filename, saved);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executeInnerCuriosityState({}, { ...CONTEXT, username, userId: username, executionId, idempotencyKey });
    assert.equal(result.status, 'completed');
    assert.equal((result.outcome as any).deduplicated, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  }
});

test('question, search, and answer cognition stays inside registered nodes', async () => {
  let questionMessages: RouterMessage[] = [];
  const questionResult = await executeInnerCuriosityQuestionGenerator({
    memories: MEMORIES,
    personaLoaded: true,
    identity: { name: 'Test Persona' },
  }, CONTEXT, {}, {
    callModel: (async (request: RouterCallOptions) => {
      questionMessages = request.messages;
      return { content: 'What connection is worth examining?' };
    }) as any,
  });
  assert.equal(questionResult.question, 'What connection is worth examining?');
  assert.equal(typeof questionMessages[0].content, 'string');
  assert.equal(typeof questionMessages[1].content, 'string');
  assert.match(questionMessages[0].content as string, /Test Persona/);
  assert.match(questionMessages[1].content as string, /grounded recent experience/i);

  const searchedTerms: string[] = [];
  const searchResult = await executeInnerCuriosityMemorySearch({
    question: questionResult.question,
  }, CONTEXT, { maxTerms: 2, resultsPerTerm: 2, maxResults: 2 }, {
    query: (async (term: string) => {
      searchedTerms.push(term);
      return [{ item: SEARCH_RESULTS[0], score: 1 }];
    }) as any,
  });
  assert.ok(searchedTerms.length > 0);
  assert.deepEqual(searchResult.searchResults, SEARCH_RESULTS);

  let answerMessages: RouterMessage[] = [];
  const answerResult = await executeInnerCuriosityAnswerGenerator({
    question: questionResult.question,
    personaName: questionResult.personaName,
    memories: MEMORIES,
    searchResults: searchResult.searchResults,
  }, CONTEXT, {}, {
    callModel: (async (request: RouterCallOptions) => {
      answerMessages = request.messages;
      return { content: 'The evidence supports one cautious connection.' };
    }) as any,
  });
  assert.equal(answerResult.answer, 'The evidence supports one cautious connection.');
  assert.equal(typeof answerMessages[1].content, 'string');
  assert.match(answerMessages[1].content as string, /related indexed memory/i);
});

test('question and answer retain dated attributed evidence and the original delegated purpose', async () => {
  const memories = [
    { id: 'spoken-joke', timestamp: '2026-09-01T12:00:00Z', type: 'conversation', role: 'assistant',
      source: 'conversation', cognitiveMode: 'environment', content: 'My left actuator has forgotten arithmetic.' },
    { id: 'unattributed', content: 'A record without speaker or time.' },
  ];
  const indexed = { id: 'past-connection', timestamp: '2026-08-30T12:00:00Z', memoryType: 'inner_dialogue',
    role: 'reflection', source: 'autonomy', text: `An earlier disconnected-body observation. ${'Historical context. '.repeat(40)}The old observation does not describe the present connection.`,
    vector: [0.25, 0.75] };
  const taskBrief = JSON.stringify({ instruction: 'Examine the reported right actuator concern.',
    observed: 'Source observation at 2026-09-03T15:59:00Z.', decidedAt: NOW });
  const messages: RouterMessage[][] = [];
  const callModel = (async (request: RouterCallOptions) => {
    messages.push(request.messages);
    return { content: messages.length === 1 ? 'What does the report establish?' : 'The records have different sources and dates.' };
  }) as any;
  const question = await executeInnerCuriosityQuestionGenerator({ memories, taskBrief,
    personaLoaded: true, identity: { name: 'Test Persona' } }, CONTEXT, {}, { callModel });
  const search = await executeInnerCuriosityMemorySearch({ question: question.question }, CONTEXT, {}, {
    query: (async () => [{ item: indexed, score: 1 }]) as any,
  });
  const answer = await executeInnerCuriosityAnswerGenerator({ question: question.question, personaName: question.personaName,
    memories, searchResults: search.searchResults, taskBrief }, CONTEXT, {}, { callModel });
  assert.equal(answer.question, question.question, 'The model-selected question remains unchanged');
  for (const request of messages) {
    const supplied = String(request[1].content);
    for (const memory of memories) assert.ok(supplied.includes(JSON.stringify(memory)));
    assert.ok(supplied.includes(taskBrief), 'Both calls retain the complete originating purpose');
  }
  assert.ok(String(messages[1][1].content).includes(JSON.stringify({ id: indexed.id, timestamp: indexed.timestamp,
    type: indexed.memoryType, role: indexed.role, source: indexed.source, content: indexed.text })));
  assert.ok(!String(messages[1][1].content).includes('"vector"'));
  assert.equal(indexed.text.length > 500, true);
});

test('the saved graph and editor forward the same original task brief to both cognition stages', async () => {
  const graph = JSON.parse(fs.readFileSync(new URL('../../../../../etc/cognitive-graphs/inner-curiosity.json', import.meta.url), 'utf8'));
  const { nodeSchemas } = await import('../schemas.js');
  for (const target of ['question', 'answer']) {
    assert.ok(graph.edges.some((edge: any) => edge.source === 'task-brief' && edge.sourceHandle === 'text'
      && edge.target === target && edge.targetHandle === 'taskBrief'));
    const type = `inner_curiosity_${target}_generator`;
    const schema = nodeSchemas.find(node => node.id === type)!;
    assert.ok(schema.inputs.some(input => input.name === 'taskBrief' && input.optional));
    assert.ok(schema.properties?.userPromptTemplate.includes('{{taskBrief}}'));
  }
});

test('checkpoint, entry, and completion require both durable persistence effects', async () => {
  const saved: InnerCuriosityReceipt[] = [];
  const preparedResult = await executeInnerCuriosityPrepare({
    execution: {
      username: 'test-user',
      executionId: 'task-stable',
      idempotencyKey: CONTEXT.idempotencyKey,
      timestamp: NOW,
    },
    question: 'What connection is worth examining?',
    answer: 'The evidence supports one cautious connection.',
    memories: MEMORIES,
    searchResults: SEARCH_RESULTS,
    sampling: DIAGNOSTICS,
  }, CONTEXT, {}, {
    saveReceipt: receipt => { saved.push(receipt); },
    now: () => new Date(NOW),
  });
  assert.equal(saved[0].status, 'prepared');

  const entryResult = await executeInnerCuriosityEntry({ prepared: preparedResult.prepared }, CONTEXT);
  assert.equal((entryResult.entry as any).role, 'reflection');
  assert.equal((entryResult.entry as any).meta.idempotencyKey, CONTEXT.idempotencyKey);

  await assert.rejects(
    executeInnerCuriosityComplete({
      prepared: preparedResult.prepared,
      deduplicated: false,
      bufferPersisted: true,
      bufferSavedCount: 1,
      memorySaved: false,
      memorySavedCount: 0,
      followOnAdmitted: false,
      followOnSkipped: true,
    }, CONTEXT, {}, {
      saveReceipt: receipt => { saved.push(receipt); },
      auditGenerated: () => {},
      now: () => new Date(NOW),
    }),
    /memory saver did not durably capture/,
  );

  let audited = false;
  const completed = await executeInnerCuriosityComplete({
    prepared: preparedResult.prepared,
    deduplicated: false,
    bufferPersisted: true,
    bufferSavedCount: 1,
    memorySaved: true,
    memorySavedCount: 1,
    followOnAdmitted: false,
    followOnSkipped: true,
    followOnReason: 'probability',
    followOnProbability: 0.2,
    followOnRoll: 0.8,
  }, CONTEXT, {}, {
    saveReceipt: receipt => { saved.push(receipt); },
    auditGenerated: () => { audited = true; },
    now: () => new Date(NOW),
  });
  assert.equal((completed.receipt as InnerCuriosityReceipt).status, 'completed');
  assert.equal((completed.outcome as any).followOn.reason, 'probability');
  assert.equal(audited, true);
});

test('the graph-owned no-memory branch returns only an exact empty-sample outcome', async () => {
  const skipped = await executeInnerCuriosityNoMemories({
    execution: {
      username: 'test-user',
      executionId: 'task-stable',
      idempotencyKey: CONTEXT.idempotencyKey,
      timestamp: NOW,
    },
    memoryCount: 0,
  }, CONTEXT);
  assert.deepEqual(skipped.outcome, {
    status: 'skipped',
    username: 'test-user',
    executionId: 'task-stable',
    reason: 'no-memories',
  });
  await assert.rejects(
    executeInnerCuriosityNoMemories({
      execution: {
        username: 'test-user',
        executionId: 'task-stable',
        idempotencyKey: CONTEXT.idempotencyKey,
        timestamp: NOW,
      },
      memoryCount: 1,
    }, CONTEXT),
    /requires an exact zero/,
  );
});

test('invalid limits and model results fail rather than degrade silently', async () => {
  await assert.rejects(
    executeCuriosityWeightedSampler({}, CONTEXT, { sampleSize: 0 }),
    /sampleSize must be greater than zero/,
  );
  await assert.rejects(
    executeInnerCuriosityMemorySearch({ question: 'What connection matters?' }, CONTEXT, {
      maxTerms: 0,
    }, { query: (async () => []) as any }),
    /maxTerms must be an integer/,
  );
  await assert.rejects(
    executeInnerCuriosityQuestionGenerator({
      memories: MEMORIES,
      personaLoaded: true,
      identity: { name: 'Test Persona' },
    }, CONTEXT, { maxTokens: 0 }, { callModel: (async () => ({ content: 'unused' })) as any }),
    /maxTokens must be an integer/,
  );
  await assert.rejects(
    executeInnerCuriosityQuestionGenerator({
      memories: MEMORIES,
      personaLoaded: true,
      identity: { name: 'Test Persona' },
    }, CONTEXT, {}, { callModel: (async () => ({ content: '' })) as any }),
    /returned empty content/,
  );
  await assert.rejects(
    executeInnerCuriosityAnswerGenerator({
      question: 'What connection matters?',
      personaName: 'Test Persona',
      memories: MEMORIES,
      searchResults: [],
    }, CONTEXT, { temperature: 3 }, { callModel: (async () => ({ content: 'unused' })) as any }),
    /temperature must be from 0 to 2/,
  );
  await assert.rejects(
    executeInnerCuriosityAnswerGenerator({
      question: 'What connection matters?',
      personaName: 'Test Persona',
      memories: MEMORIES,
      searchResults: [],
    }, CONTEXT, {}, { callModel: (async () => ({ content: '' })) as any }),
    /returned empty content/,
  );
});
