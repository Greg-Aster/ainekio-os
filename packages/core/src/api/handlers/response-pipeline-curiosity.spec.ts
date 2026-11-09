import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SvelteFlowGraph } from '../../cognitive-graph-schema.js';
import test from 'node:test';
import type { GraphExecutionState, NodeExecutionState } from '../../graph-executor.js';
import { resolveCuriosityResponse } from '../../nodes/response/response-action-router.node.js';
import {
  buildResponsePipelineExecutionContext,
  extractResponsePipelineResult,
  validateResponsePipelineRequest,
  type ResponsePipelineRequest,
} from './response-pipeline.js';

const responseGraph: SvelteFlowGraph = JSON.parse(readFileSync(new URL('../../../../../etc/cognitive-graphs/response-pipeline.json', import.meta.url), 'utf8'));

function request(cardType: string, cardData: ResponsePipelineRequest['cardData']): ResponsePipelineRequest {
  return {
    message: 'Here is my answer.',
    cardType,
    cardData,
    sessionId: 'conversation-one',
  };
}

function node(type: string, outputs: Record<string, unknown>): NodeExecutionState {
  return {
    nodeId: type,
    status: 'completed',
    definition: { type },
    outputs,
  };
}

function completedGraph(overrides: Partial<Record<string, Record<string, unknown>>> = {}): GraphExecutionState {
  return {
    status: 'completed',
    startTime: Date.now(),
    nodes: new Map([
      ['action', node('response_action_router', overrides.action || {
        response: 'Thanks for answering.',
        actionTaken: 'Curiosity question marked answered',
        pipelineTriggered: false,
        nextStatus: null,
      })],
      ['context', node('response_context_writer', overrides.context || {
        responseBufferId: 'response-one',
        persisted: true,
        exchangeCount: 2,
      })],
      ['conversation', node('conversation_buffer', overrides.conversation || {
        persisted: true,
        messageCount: 2,
      })],
      ['memory', node('memory_capture', overrides.memory || {
        saved: true,
        savedCount: 2,
      })],
    ]),
  };
}

test('curiosity response resolves through the canonical question store', async () => {
  const calls: unknown[][] = [];
  const resolver = {
    resolve: async (...args: unknown[]) => {
      calls.push(args);
      return { changed: true, record: {} as never };
    },
  };
  await resolveCuriosityResponse({ questionId: 'cur-q-one' }, 'alice', resolver as never);
  assert.deepEqual(calls, [['alice', 'cur-q-one', 'answered']]);
});

test('already-resolved curiosity response fails instead of reporting success', async () => {
  const resolver = {
    resolve: async () => ({ changed: false, record: {} as never }),
  };
  await assert.rejects(
    () => resolveCuriosityResponse({ questionId: 'cur-q-one' }, 'alice', resolver as never),
    /already resolved/,
  );
});

test('response pipeline validates supported card identities', () => {
  assert.equal(validateResponsePipelineRequest(request('curiosity_response', { questionId: 'cur-q-one' })), null);
  assert.equal(
    validateResponsePipelineRequest({
      ...request('curiosity_response', { questionId: 'cur-q-one' }),
      sessionId: '',
    }),
    'Session ID is required',
  );
  assert.equal(
    validateResponsePipelineRequest(request('assistant_message', {})),
    'Unsupported response pipeline card type: assistant_message',
  );
  assert.equal(
    validateResponsePipelineRequest(request('desire_plan', {})),
    'desire_plan requires a desireId',
  );
});

test('response pipeline extracts the explicit action and persistence receipts', () => {
  assert.deepEqual(extractResponsePipelineResult(completedGraph(), responseGraph), {
    response: 'Thanks for answering.',
    responseBufferId: 'response-one',
    actionTaken: 'Curiosity question marked answered',
    pipelineTriggered: false,
    nextStatus: undefined,
  });
});

test('response pipeline fails when canonical conversation memory is incomplete', () => {
  assert.throws(
    () => extractResponsePipelineResult(completedGraph({ memory: { saved: false, savedCount: 1 } }), responseGraph),
    /did not persist every admitted conversation entry/,
  );
});

test('response pipeline does not substitute a request buffer id for a missing writer receipt', () => {
  assert.throws(
    () => extractResponsePipelineResult(completedGraph({ context: { persisted: true, exchangeCount: 2 } }), responseGraph),
    /produced no response buffer ID/,
  );
});

test('response pipeline execution propagates cognitive mode and cancellation', () => {
  const controller = new AbortController();
  const environment = buildResponsePipelineExecutionContext(
    request('curiosity_response', { questionId: 'cur-q-one' }),
    'alice',
    'environment',
    controller.signal,
    'owner',
  );
  assert.equal(environment.cognitiveMode, 'environment');
  assert.equal(environment.allowMemoryWrites, true);
  assert.equal(environment.recordPersonaMemory, true);
  assert.equal(environment.abortSignal, controller.signal);
  assert.equal(environment.userRole, 'owner');

  const emulation = buildResponsePipelineExecutionContext(
    request('curiosity_response', { questionId: 'cur-q-one' }),
    'alice',
    'emulation',
  );
  assert.equal(emulation.cognitiveMode, 'emulation');
  assert.equal(emulation.allowMemoryWrites, false);
  assert.equal(emulation.recordPersonaMemory, true);
});

test('focused response identity comes from the saved card exchange through its real graph wiring', () => {
  const receipt = completedGraph();
  const outputsByType = new Map([...receipt.nodes.values()].map(node => [node.definition!.type!, node.outputs!]));
  const nodes = new Map<string, NodeExecutionState>();
  for (const graphNode of responseGraph.nodes) {
    const type = graphNode.data.nodeType;
    nodes.set(graphNode.id, { nodeId: graphNode.id, status: 'completed', definition: { type },
      inputs: { response: 'Thanks for answering.' },
      outputs: { response: 'Thanks for answering.', ...outputsByType.get(type),
        ...(type === 'conversation_buffer' ? { entries: [
          { role: 'user', content: 'Original answer', meta: { idempotencyKey: 'saved-user' } },
          { role: 'assistant', content: 'Thanks for answering.', meta: { idempotencyKey: 'saved-card-reply' } },
        ] } : {}) },
    });
  }
  const state: GraphExecutionState = { status: 'completed', startTime: 1, nodes };
  assert.deepEqual(extractResponsePipelineResult(state, responseGraph).responseEntry,
    { mode: 'conversation', id: 'saved-card-reply' });
  const unrelated = structuredClone(responseGraph);
  const bufferId = responseGraph.nodes.find(node => node.data.nodeType === 'conversation_buffer')!.id;
  unrelated.edges = unrelated.edges.filter(edge => !(edge.target === bufferId && edge.targetHandle === 'response'));
  assert.equal(extractResponsePipelineResult(state, unrelated).responseEntry, undefined);
});
