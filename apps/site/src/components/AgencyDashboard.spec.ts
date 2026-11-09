import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { writable } from 'svelte/store';
import { readServerEvents } from '../lib/client/sse';

const component = readFileSync(new URL('./AgencyDashboard.svelte', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AgencyDashboard.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const handlers = ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n');
function dashboard(extra: Record<string, unknown> = {}) {
  const state = vm.createContext({ AbortController, URLSearchParams, console, readServerEvents,
    streamObservation: new AbortController(), listRead: null, executionRead: null, operationRead: null,
    streamEventSource: null, agentProcessingId: null, processingId: null, agentOperation: null,
    currentLoadingMessage: '', streamingPhase: '', streamingOutput: '', streamingSteps: 0,
    desires: [], metrics: null, summary: null, agencyConfig: null, agencyConfigDirty: false, activationThreshold: null,
    statusFilter: 'open', loading: true, dataError: '', error: '', executionData: {}, expandedCardId: null,
    showScratchpadFor: null, scratchpadOffset: 0,
    scratchpadRead: null, fileRead: null, planListRead: null, planRead: null,
    scratchpadLimit: 10, scratchpadEntries: [], scratchpadFiles: [], scratchpadTotal: 0, scratchpadError: '',
    planVersions: [], planListError: '', planError: '', selectedPlanVersion: null, viewingPlan: null,
    selectedFileName: null, selectedFileContent: null, fileError: '', executionErrors: {},
    setInterval() { throw new Error('Agency must not use timer-driven progress or refresh'); }, ...extra });
  vm.runInContext(transpile(handlers), state);
  return state;
}
const payload = (url: string, label: string) => url.includes('/desires?')
  ? { desires: [{ id: label }] } : url.endsWith('/metrics')
    ? { metrics: { totalGenerated: 1 }, counts: {}, summary: { total: 1 } } : { config: { mode: label } };

test('rapid filter changes discard old reads, preserve settings drafts and expose read failures', async () => {
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const state = dashboard({ apiFetch: (url: string, { signal }: { signal: AbortSignal }) =>
    new Promise<Response>(resolve => requests.push({ url, signal, resolve })) });
  const first = state.loadAll();
  state.statusFilter = 'completed';
  const second = state.loadAll(false);
  assert.equal(requests.length, 6, 'a newer filter must not be suppressed by an elapsed-time throttle');
  assert(requests.slice(0, 3).every(request => request.signal.aborted));
  for (const request of requests.slice(3)) request.resolve(Response.json(payload(request.url, 'new')));
  await second;
  assert.equal(state.desires[0].id, 'new');
  for (const request of requests.slice(0, 3)) request.resolve(Response.json(payload(request.url, 'old')));
  await first;
  assert.equal(state.desires[0].id, 'new', 'a late response must not replace the selected filter');
  state.agencyConfigDirty = true;
  state.agencyConfig = { mode: 'unsaved' };
  const draft = state.loadAll(false);
  for (const request of requests.slice(6)) request.resolve(Response.json(payload(request.url, 'remote')));
  await draft;
  assert.equal(state.agencyConfig.mode, 'unsaved');
  const failed = state.loadAll(false);
  for (const request of requests.slice(9)) request.resolve(Response.json({ error: 'Storage locked' }, { status: 423 }));
  await failed;
  assert.equal(state.dataError, 'Storage locked');
  assert.equal(state.loading, false);
  state.streamObservation.abort();
  await state.loadAll();
  assert.equal(requests.length, 12, 'disposed views must not start more reads');
});

test('planning EOF and error receipts preserve critique drafts and the open card', async () => {
  for (const frames of ['', 'event: error\ndata: {"error":"Planner failed"}\n\n']) {
    const state = dashboard({ critiqueText: { desire: 'Keep critique' }, expandedCardId: 'desire', apiFetch: async () => new Response(frames) });
    let reloads = 0;
    state.loadAll = async () => { reloads++; };
    await state.handleGeneratePlan('desire');
    assert.equal(state.critiqueText.desire, 'Keep critique');
    assert.equal(state.expandedCardId, 'desire');
    assert.match(state.error, frames ? /Planner failed/ : /unconfirmed|outcome|interrupted/i);
    assert.equal(reloads, 0);
  }
});

test('execution HTTP rejection exposes the real error without treating the response as a stream', async () => {
  const state = dashboard({ confirm: () => true, apiFetch: async () => Response.json({ error: 'Desire not executable' }, { status: 409 }) });
  state.loadAll = async () => {};
  await state.handleExecute('desire');
  assert.equal(state.error, 'Desire not executable');
});

test('creation acknowledgement preserves a newer form draft', async () => {
  let reply!: (response: Response) => void;
  const state = dashboard({ newDesire: { title: 'Submitted', description: 'First', reason: '', risk: 'low', goalType: 'one_time', strength: 0.8, status: 'pending', decayRate: 0.03, tags: '' },
    showNewDesire: true, showAdvancedOptions: true, apiFetch: () => new Promise(resolve => { reply = resolve; }) });
  state.loadAll = async () => {};
  const saving = state.handleCreateDesire();
  state.newDesire = { ...state.newDesire, title: 'Newer draft' };
  reply(Response.json({ success: true }));
  await saving;
  assert.equal(state.newDesire.title, 'Newer draft');
  assert.equal(state.showNewDesire, true);
});

test('revision and clarifying-answer acknowledgements do not discard newer drafts', async () => {
  for (const kind of ['revision', 'answers']) {
    let reply!: (response: Response) => void;
    const state = dashboard({ critiqueText: { desire: 'Submitted critique' }, questionAnswers: { desire: { question: 'Submitted answer' } }, revisingId: null,
      apiFetch: () => new Promise(resolve => { reply = resolve; }) });
    state.loadAll = async () => {};
    const saving = kind === 'revision' ? state.handleRevise('desire') : state.handleAnswerQuestions({ id: 'desire', clarifyingQuestions: { questions: [{ id: 'question', required: true }] } });
    if (kind === 'revision') state.critiqueText.desire = 'Newer critique';
    else state.setQuestionAnswer('desire', 'question', 'Newer answer');
    reply(Response.json({ success: true }));
    await saving;
    assert.equal(kind === 'revision' ? state.critiqueText.desire : state.questionAnswers.desire?.question, kind === 'revision' ? 'Newer critique' : 'Newer answer');
  }
});

test('a late scratchpad response cannot replace the currently selected desire', async () => {
  const reads: Array<(response: Response) => void> = [];
  const state = dashboard({ scratchpadLimit: 10, expandedEntryIndex: null, scratchpadEntries: [], scratchpadFiles: [], scratchpadTotal: 0,
    apiFetch: () => new Promise(resolve => reads.push(resolve)) });
  state.showScratchpadFor = 'first';
  const first = state.loadScratchpadEntries('first');
  state.showScratchpadFor = 'second';
  const second = state.loadScratchpadEntries('second');
  reads[1](Response.json({ entries: [{ description: 'Second' }], files: [], total: 1 }));
  await second;
  reads[0](Response.json({ entries: [{ description: 'First' }], files: [], total: 1 }));
  await first;
  assert.equal(state.scratchpadEntries[0].description, 'Second');
});

test('scratchpad and plan catalog failures retain prior evidence and recover through their existing loaders', async () => {
  for (const kind of ['scratchpad', 'plans']) {
    let fail = false;
    const state = dashboard({ apiFetch: async () => fail ? Response.json({ error: 'Evidence unavailable' }, { status: 503 })
      : Response.json(kind === 'scratchpad' ? { entries: [{ description: 'Recorded' }], files: ['record.json'], total: 1 } : { versions: ['v1.json'] }) });
    const load = () => kind === 'scratchpad' ? state.loadScratchpadEntries('desire') : state.loadPlanVersions('desire');
    await load();
    fail = true;
    await load();
    assert.equal(kind === 'scratchpad' ? state.scratchpadError : state.planListError, 'Evidence unavailable');
    assert.equal(kind === 'scratchpad' ? state.scratchpadEntries[0].description : state.planVersions[0], kind === 'scratchpad' ? 'Recorded' : 'v1.json');
    fail = false;
    await load();
    assert.equal(kind === 'scratchpad' ? state.scratchpadError : state.planListError, '');
  }
});

test('file and selected-plan reads cannot overwrite replacements or closed views', async () => {
  for (const kind of ['file', 'plan']) {
    const reads: Array<(response: Response) => void> = [];
    const state = dashboard({ apiFetch: () => new Promise(resolve => reads.push(resolve)) });
    const first = kind === 'file' ? state.loadScratchpadFile('desire', 'one.json') : state.loadPlanVersion('desire', 1);
    const second = kind === 'file' ? state.loadScratchpadFile('desire', 'two.json') : state.loadPlanVersion('desire', 2);
    reads[1](Response.json(kind === 'file' ? { entry: { description: 'Second' } } : { plan: { version: 2 } }));
    await second;
    reads[0](Response.json(kind === 'file' ? { entry: { description: 'First' } } : { plan: { version: 1 } }));
    await first;
    assert.equal(kind === 'file' ? state.selectedFileContent.description : state.viewingPlan.version, kind === 'file' ? 'Second' : 2);
    const closing = kind === 'file' ? state.loadScratchpadFile('desire', 'late.json') : state.loadPlanVersion('desire', 3);
    state.closeScratchpadView();
    reads[2](Response.json(kind === 'file' ? { entry: { description: 'Late' } } : { plan: { version: 3 } }));
    await closing;
    assert.equal(kind === 'file' ? state.selectedFileContent : state.viewingPlan, null);
  }
});

test('reopening a desire retains unsent answers rather than replacing them with persisted answers', () => {
  const state = dashboard({ questionAnswers: { desire: { question: 'Unsent draft' } }, desires: [{ id: 'desire', clarifyingQuestions: {
    questions: [{ id: 'question' }], answers: [{ questionId: 'question', answer: 'Persisted answer' }] } }] });
  state.loadExecutionData = async () => {};
  state.toggleCardExpand('desire');
  state.toggleCardExpand('desire');
  state.toggleCardExpand('desire');
  assert.equal(state.questionAnswers.desire.question, 'Unsent draft');
});

test('planning completion comes from the explicit receipt and leaves unsubmitted critique text alone', async () => {
  const state = dashboard({ critiqueText: { desire: 'Unsubmitted revision draft' }, expandedCardId: 'desire',
    apiFetch: async () => new Response('event: complete\ndata: {"success":true,"awaitingQuestions":true}\n\n') });
  let reloads = 0;
  state.loadAll = async () => { reloads++; };
  await state.handleGeneratePlan('desire');
  assert.equal(state.error, '');
  assert.equal(state.critiqueText.desire, 'Unsubmitted revision draft');
  assert.equal(state.expandedCardId, null);
  assert.equal(reloads, 1);
});

test('threshold status uses acknowledged configuration while newer configuration edits remain drafts', async () => {
  let reply!: (response: Response) => void;
  const state = dashboard({ agencyConfig: { thresholds: { activation: 0.2 } }, agencyConfigDirty: true,
    apiFetch: (url: string, options?: RequestInit) => options?.method === 'PUT' ? new Promise(resolve => { reply = resolve; })
      : Promise.resolve(Response.json(url.endsWith('/config') ? { config: { thresholds: { activation: 0.83 } } } : payload(url, 'loaded'))) });
  await state.loadAll(false);
  assert.equal(state.activationThreshold, 0.83);
  assert.equal(state.agencyConfig.thresholds.activation, 0.2);
  const saving = state.saveAgencySettings();
  state.agencyConfig = { thresholds: { activation: 0.31 } };
  reply(Response.json({ config: { thresholds: { activation: 0.2 } } }));
  await saving;
  assert.equal(state.activationThreshold, 0.2);
  assert.equal(state.agencyConfig.thresholds.activation, 0.31);
  assert.equal(state.agencyConfigDirty, true);
});

test('a superseded progress observer cannot close or reset its replacement', () => {
  const state = dashboard();
  const first = state.beginOperation('first', 'planning', 'Requesting a plan');
  const second = state.beginOperation('second', 'executing', 'Requesting execution');
  assert.equal(first.signal.aborted, true);
  state.finishOperation(first);
  assert.equal(second.signal.aborted, false);
  assert.equal(state.processingId, 'second');
  state.finishOperation(second);
  assert.equal(second.signal.aborted, true);
  assert.equal(state.processingId, null);
  assert.equal(state.currentLoadingMessage, '');
});

test('Agency subscribes to committed changes and reconnects, then releases observation on navigation', async () => {
  const snapshots = writable<any>(null);
  const connections = writable('live');
  let retained = 0;
  const destroy: (() => void)[] = [];
  const requests: string[] = [];
  const state = dashboard({
    $isOwner: true, $coordinatorSnapshot: null, coordinatorSnapshot: snapshots, coordinatorConnection: connections,
    useWorkCoordinator: () => { retained++; return () => retained--; },
    onMount: (start: () => () => void) => destroy.push(start()), onDestroy: (end: () => void) => destroy.push(end),
    apiFetch: async (url: string) => { requests.push(url); return Response.json(payload(url, 'current')); },
  });
  const lifecycle = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ['onMount', 'onDestroy'].includes(node.expression.expression.getText(ast))).map(node => node.getText(ast)).join('\n');
  vm.runInContext(transpile(lifecycle), state);
  const settled = () => new Promise<void>(resolve => setImmediate(resolve));
  await settled();
  assert.equal(requests.length, 3);
  snapshots.set({ agencyChange: { revision: 'one' } });
  await settled();
  assert.equal(requests.length, 6);
  snapshots.set({ agencyChange: { revision: 'one' } });
  await settled();
  assert.equal(requests.length, 6, 'unrelated queue snapshots must not reload Agency');
  connections.set('reconnecting'); connections.set('live');
  await settled();
  assert.equal(requests.length, 9);
  for (const stop of destroy) stop();
  assert.equal(retained, 0);
  assert.equal(state.streamObservation.signal.aborted, true);
  snapshots.set({ agencyChange: { revision: 'two' } });
  connections.set('reconnecting'); connections.set('live');
  await settled();
  assert.equal(requests.length, 9);
});

test('saving Agency settings preserves edits made while the request is in flight', async () => {
  let reply!: (response: Response) => void;
  const state = dashboard({ agencyConfig: { mode: 'supervised' }, agencyConfigDirty: true,
    savingAgencyConfig: false, apiFetch: () => new Promise<Response>(resolve => { reply = resolve; }) });
  const save = state.saveAgencySettings();
  state.agencyConfig = { mode: 'off' };
  reply(Response.json({ config: { mode: 'supervised' } }));
  await save;
  assert.equal(state.agencyConfig.mode, 'off');
  assert.equal(state.agencyConfigDirty, true);
  assert.equal(state.savingAgencyConfig, false);
});
