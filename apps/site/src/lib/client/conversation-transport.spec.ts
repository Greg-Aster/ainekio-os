import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  buildResponsePipelineRequestBody,
  parseConversationStreamEvent,
  responsePipelineCardTypeForReply,
} from './conversation-transport.js';

test('response pipeline routing is limited to stateful card interactions', () => {
  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'environment',
    questionId: 'curiosity-one',
  }), 'curiosity_response');

  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'dual',
    dialogueSource: 'agency-system',
    desireId: 'desire-one',
    cardType: 'plan_rejected',
  }), 'desire_rejection');

  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'dual',
    dialogueSource: 'agency-system',
    desireId: 'desire-one',
    cardType: 'clarifying_questions',
  }), 'clarifying_questions');

  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'dual',
    dialogueSource: 'agency-system',
    desireId: 'desire-one',
    cardType: 'approval_requested',
  }), 'desire_plan');
});

test('all chat task observers retain answers through reconnect and end on actual terminal events, including handoff without answer', () => {
  const component = readFileSync(new URL('../../components/ChatInterface.svelte', import.meta.url), 'utf8');
  const source = /<script[^>]*>([\s\S]*?)<\/script>/.exec(component)![1];
  const ast = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.ES2022, true);
  const handlers = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['openChatTaskStream', 'showChatError'].includes(node.name!.text));
  assert.equal(handlers.length, 2);
  for (const route of ['conversation', 'inner', 'focused'] as const) {
    for (const outcome of ['handoff', 'answer', 'error', 'cancelled'] as const) {
      const answers: any[][] = [], errors: string[] = [];
      const stream = { closed: false, readyState: 0, close() { this.closed = true; },
        onopen() {}, onerror() {}, onmessage(_event: { data: string }) {} };
      const state: any = { isComponentMounted: true, loading: false, activeChatTaskId: null,
        queuedChatStreams: new Map(), reasoningStages: [], EventSource: { CLOSED: 2 },
        parseConversationStreamEvent, apiEventSource: () => stream,
        pushGeneratedResponse: (...args: any[]) => answers.push(args),
        messagesApi: { pushMessage: (_role: string, message: string) => errors.push(message) },
        reportChatError: async () => {},
        thinkingTraceApi: { setActive() {}, stop() {}, setStatusLabel() {}, setTrace() {}, appendTrace() {} },
      };
      const context = vm.createContext(state);
      vm.runInContext(ts.transpileModule(handlers.map(node => node.getText(ast)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText, context);
      state.openChatTaskStream('current-task', route === 'inner' ? 'inner' : 'conversation',
        route === 'focused' ? { type: 'curiosity_response', data: { questionId: 'question-one' } } : undefined);
      const send = (type: string, data = {}) => stream.onmessage({ data: JSON.stringify({ type, data }) });
      stream.onopen(); send('queued_task_started');
      stream.onerror();
      assert.equal(stream.closed, false, 'A transient network failure leaves native EventSource reconnect active');
      assert.equal(state.queuedChatStreams.size, 1);
      stream.onopen(); send('queued_task_started');
      send('progress', { step: 'input_forwarded', message: 'Input delivered to selected execution' });
      send('reasoning', { content: 'Actual model reasoning' });
      assert.equal(state.reasoningStages.length, 1);
      stream.onopen(); send('queued_task_started');
      send('reasoning', { content: 'Actual model reasoning' });
      assert.equal(state.reasoningStages.length, 1, 'Replayed reasoning replaces the prior reader projection');
      if (outcome === 'answer') {
        send('answer', { response: '<think>Raw thought</think>Model answer', responseEntry: { mode: route === 'inner' ? 'inner' : 'conversation', id: 'saved-entry' } });
        assert.equal(state.loading, true, 'Response availability does not claim task completion');
        assert.equal(stream.closed, false);
        send('queued_task_completed', { taskId: 'current-task' });
      } else if (outcome === 'error') send('error', { message: 'Delivery failed', failedNode: 'response_llm', failedNodes: [{ nodeId: 'response-llm', error: 'Delivery failed' }], suggestion: 'Check the configured backend' });
      else if (outcome === 'cancelled') send('cancelled', { message: 'User cancelled' });
      else send('queued_task_completed', { taskId: 'current-task' });
      assert.equal(state.loading, false, `${route}: ${outcome}`);
      assert.equal(state.activeChatTaskId, null);
      assert.equal(stream.closed, true);
      assert.equal(state.queuedChatStreams.size, 0);
      assert.equal(answers.length, outcome === 'answer' ? 1 : 0);
      if (outcome === 'answer') {
        assert.equal(answers[0][0], '<think>Raw thought</think>Model answer');
        assert.equal(answers[0][2], 'current-task');
        assert.equal(answers[0][3].id, 'saved-entry');
        if (route === 'focused') assert.equal(answers[0][4].cardType, 'curiosity_response');
      }
      assert.equal(errors.length, outcome === 'error' || outcome === 'cancelled' ? 1 : 0);
      if (outcome === 'error') {
        assert.match(errors[0], /Failed at node: response_llm/);
        assert.match(errors[0], /Check the configured backend/);
      }
    }
  }
});

test('ordinary selected replies and passive Agency notices use the active conversation graph', () => {
  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'dual',
    cardType: 'assistant_message',
  }), null);

  assert.equal(responsePipelineCardTypeForReply({
    cognitiveMode: 'agent',
    dialogueSource: 'agency-system',
    cardType: 'desire_checkin_status',
  }), null);
});

test('response pipeline requests carry the conversation session id', () => {
  assert.deepEqual(
    buildResponsePipelineRequestBody(
      '  answer  ',
      'curiosity_response',
      { questionId: 'curiosity-one' },
      'conversation-one',
      'buffer-one',
    ),
    {
      message: 'answer',
      cardType: 'curiosity_response',
      cardData: { questionId: 'curiosity-one' },
      sessionId: 'conversation-one',
      responseBufferId: 'buffer-one',
    },
  );
});
