import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';

const source = readFileSync(new URL('./OnboardingWizard.svelte', import.meta.url), 'utf8');
const script = ts.createSourceFile('OnboardingWizard.ts', source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(script.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(script)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const initial = () => ({ currentStep: 1, stepsCompleted: { welcome: false, identity: true, personality: false, context: false, goals: false, review: false },
  dataCollected: { identityQuestions: 2, personalityQuestions: 0, filesIngested: 0, tasksCreated: 0, memoriesCreated: 3 } });

// Reuse the existing component-handler VM approach; execute the real wizard.
function wizard(apiFetch: (url: string, options?: RequestInit) => Promise<Response>) {
  let completions = 0;
  const state = vm.createContext({ Error, apiFetch, state: null, loading: true, error: '', showSkipModal: false,
    onComplete() { completions++; } });
  Object.defineProperty(state, 'currentStep', { get: () => state.state?.currentStep ?? 1 });
  vm.runInContext(code, state);
  return { state, completions: () => completions };
}

test('load/save failures remain visible; one committed transition owns forward/backward progress and restoration', async () => {
  let stored = initial();
  let fail = true;
  const calls: { url: string; options?: RequestInit }[] = [];
  const view = wizard(async (url, options) => {
    calls.push({ url, options });
    if (fail) return Response.json({ error: 'Progress storage unavailable' }, { status: 503 });
    if (options?.method === 'POST') {
      const updates = JSON.parse(String(options.body)).updates;
      stored = { ...stored, ...updates, stepsCompleted: { ...stored.stepsCompleted, ...updates.stepsCompleted } };
    }
    return Response.json({ success: true, state: stored });
  });
  await view.state.loadState();
  const failedState = view.state.state;
  assert.equal(failedState, null);
  assert.equal(view.state.error, 'Progress storage unavailable');
  assert.equal(view.state.loading, false);
  fail = false;
  await view.state.loadState();
  fail = true;
  await view.state.handleStepComplete('welcome');
  assert.equal(view.state.currentStep, 1, 'a failed write cannot invent saved progress');
  assert.equal(view.state.state.stepsCompleted.welcome, false);
  fail = false;
  const before = calls.length;
  await view.state.handleStepComplete('welcome');
  assert.equal(calls.length, before + 1, 'completion and navigation share one state write');
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.options!.body)).updates.stepsCompleted, { welcome: true },
    'the client sends the selected change, not a copied snapshot of other flags');
  assert.equal(stored.currentStep, 2);
  assert.equal(stored.stepsCompleted.identity, true);
  await view.state.prevStep();
  assert.equal(stored.currentStep, 1);
  const reopened = wizard(async () => Response.json({ success: true, state: stored }));
  await reopened.state.loadState();
  assert.equal(reopened.state.currentStep, 1);
  assert.equal(reopened.state.state.stepsCompleted.welcome, true);
});

test('completion and skip exit only on acknowledgement, preserve failures for retry and do not replay on reload', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  let fail = true;
  const view = wizard(async (url, options) => {
    calls.push({ url, options });
    return Response.json(fail ? { error: 'Completion storage unavailable' } : { success: true, state: initial() }, { status: fail ? 500 : 200 });
  });
  await view.state.finishOnboarding('complete');
  assert.equal(view.completions(), 0);
  assert.equal(view.state.error, 'Completion storage unavailable');
  fail = false;
  await view.state.finishOnboarding('complete');
  assert.equal(view.completions(), 1);
  assert.equal(calls.at(-1)!.url, '/api/onboarding/complete');
  view.state.showSkipModal = true;
  await view.state.finishOnboarding('skip', 'user_declined');
  assert.equal(calls.at(-1)!.url, '/api/onboarding/skip');
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.options!.body)), { reason: 'user_declined' });
  assert.equal(view.completions(), 2);
  assert.equal(view.state.showSkipModal, false);
  const before = calls.length;
  await view.state.loadState();
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)!.options, undefined);
  assert.equal(view.completions(), 2);
});

// Existing compiled-render approach; no browser/API/model execution on render.
function renderStep(file: string, props: Record<string, unknown>, componentSource?: string) {
  const component = componentSource ?? readFileSync(new URL(file, import.meta.url), 'utf8');
  const componentRequire = createRequire(import.meta.url);
  const compiled = ts.transpileModule(compile(component, { filename: file, generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id.includes('api-config')
    ? { apiFetch() { assert.fail('Review rendering must not fetch progress or submit completion'); } } : componentRequire(id) });
  vm.runInContext(compiled, context);
  return componentRequire('svelte/server').render(context.exports.default, { props }).body;
}

test('the review renders parent progress and pending state without owning another request', () => {
  const state = initial();
  state.dataCollected.filesIngested = 4;
  const html = renderStep('./onboarding/Step6_Complete.svelte', { state, completing: true, onComplete() {}, onBack() {} });
  assert.match(html, /9<\/strong> total recorded data points/);
  assert.match(html, /Finalizing/);
  assert.match(html, /disabled/);
  assert.match(html, /Configured model providers/);
  assert.doesNotMatch(html, /100% locally|no external API calls/);
  const historical = { ...state, dataCollected: { personalityQuestions: 7 } };
  const partial = renderStep('./onboarding/Step6_Complete.svelte', { state: historical, onComplete() {}, onBack() {} });
  assert.match(partial, /7<\/strong> total recorded data points/);
  assert.doesNotMatch(partial, /NaN/);
  assert.deepEqual(historical.dataCollected, { personalityQuestions: 7 }, 'missing historical counters are not reconstructed');
});

test('the welcome describes the current companion purpose without denying the assistant role', () => {
  const html = renderStep('./onboarding/Step1_Welcome.svelte', { onNext() {}, onSkip() {} });
  assert.match(html, /companion and assistant/);
  assert.doesNotMatch(html, /not an assistant/);
});

const contextSource = readFileSync(new URL('./onboarding/Step4_Context.svelte', import.meta.url), 'utf8');
const contextScript = ts.createSourceFile('Step4_Context.ts', contextSource.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const contextCode = ts.transpileModule(contextScript.statements.filter(node => ts.isFunctionDeclaration(node)
  || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(contextScript) === 'onDestroy')
  .map(node => node.getText(contextScript)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function contextUpload(apiFetch: (url: string, options: RequestInit) => Promise<Response>) {
  let continuations = 0;
  let destroy!: () => void;
  const state = vm.createContext({ Error, FormData, apiFetch, uploadedFiles: [], uploading: false, uploadProgress: 0,
    uploadStatus: '', error: '', dragActive: false, active: true, onNext() { continuations++; }, onDestroy: (callback: () => void) => { destroy = callback; },
    setTimeout() { assert.fail('Upload continuation must not outlive its receipt on a timer'); } });
  vm.runInContext(contextCode, state);
  return { state, continuations: () => continuations, close: () => destroy() };
}

test('context upload retires acknowledged files, retries only pending files and advances immediately after receipts', async () => {
  const calls: string[] = [];
  let fail = true;
  const view = contextUpload(async (url, options) => {
    assert.equal(url, '/api/ingest');
    const name = ((options.body as FormData).get('file') as File).name;
    calls.push(name);
    return Response.json(fail && name === 'two.txt' ? { error: 'Inbox locked' } : { success: true, state: 'stored-in-inbox' },
      { status: fail && name === 'two.txt' ? 500 : 200 });
  });
  view.state.addFiles([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]);
  await view.state.handleUpload();
  assert.deepEqual(Array.from(view.state.uploadedFiles, (file: File) => file.name), ['two.txt']);
  assert.match(view.state.error, /two.txt: Inbox locked/);
  assert.equal(view.state.uploadStatus, '1 of 2 uploads acknowledged');
  assert.equal(view.continuations(), 0);
  assert.equal(view.state.uploading, false);
  fail = false;
  await view.state.handleUpload();
  assert.deepEqual(calls, ['one.txt', 'two.txt', 'two.txt']);
  assert.equal(view.state.uploadedFiles.length, 0);
  assert.equal(view.continuations(), 1);
  assert.equal(view.state.uploading, false);
  await view.state.handleUpload();
  assert.equal(calls.length, 3, 'retrying a failed parent progress save cannot replay stored files');
  assert.equal(view.continuations(), 2);
});

test('files added during a batch remain pending, and intentional duplicate selections retain distinct receipts', async () => {
  const calls: string[] = [];
  let finish!: (response: Response) => void;
  const view = contextUpload(async (_url, options) => {
    calls.push(await ((options.body as FormData).get('file') as File).text());
    if (calls.length > 1) return Response.json({ success: true });
    return new Promise(resolve => { finish = resolve; });
  });
  const first = new File(['same'], 'same.txt');
  view.state.addFiles([first, first]);
  const pending = view.state.handleUpload();
  await new Promise(resolve => setImmediate(resolve));
  view.state.addFiles([new File(['different'], 'same.txt')]);
  finish(Response.json({ success: true }));
  await pending;
  assert.deepEqual(calls, ['same', 'same']);
  assert.equal(view.state.uploadedFiles.length, 1);
  assert.equal(view.continuations(), 0);
  await view.state.handleUpload();
  assert.deepEqual(calls, ['same', 'same', 'different']);
  assert.equal(view.continuations(), 1);
});

test('unconfirmed uploads remain selected without automatic replay or invented ingestion counters', async () => {
  let requests = 0;
  const view = contextUpload(async () => { requests++; throw new TypeError('Connection interrupted'); });
  const file = new File(['notes'], 'notes.md');
  view.state.addFiles([new File(['unsupported'], 'program.exe')]);
  assert.match(view.state.error, /unsupported type/);
  const input = { files: [file], value: 'selected-file' };
  view.state.handleFileSelect({ target: input });
  assert.equal(input.value, '', 'the native picker releases its redundant file selection');
  assert.equal(view.state.error, '');
  await view.state.handleUpload();
  assert.equal(requests, 1);
  assert.equal(view.state.uploadedFiles[0], file);
  assert.equal(view.state.uploadStatus, '0 of 1 uploads acknowledged');
  assert.equal(view.state.error, 'Connection interrupted');
  assert.equal(view.continuations(), 0);
});

test('context uses a real browse button and distinguishes stored upload types from ingestion support', () => {
  const html = renderStep('./onboarding/Step4_Context.svelte', { onNext() {}, onBack() {}, onSkip() {} });
  assert.match(html, /Browse Files/);
  assert.doesNotMatch(html, /role="button"|tabindex="0"/);
  assert.match(html, /PDF and CSV files can be stored here/);
  assert.match(html, /does not process them/);
});

test('closing the context screen leaves a sent upload alone but ends further admission and navigation', async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    let finish!: (response: Response) => void;
    let requests = 0;
    const view = contextUpload(async (_url, options) => {
      requests++;
      assert.equal(options.signal, undefined, 'screen teardown must not cancel a sent upload');
      return new Promise(resolve => { finish = resolve; });
    });
    view.state.addFiles([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]);
    const pending = view.state.handleUpload();
    assert.equal(requests, 1);
    view.close();
    finish(Response.json({ success: true }));
    await pending;
    assert.equal(requests, 1);
    assert.equal(view.continuations(), 0);
    assert.equal(view.state.uploadedFiles.length, 1, 'the sent receipt still retires its delivered temporary copy');
    await view.state.handleUpload();
    assert.equal(requests, 1, 'the retired instance cannot admit another batch');
  }
  let requests = 0;
  const reopened = contextUpload(async () => { requests++; return Response.json({ success: true }); });
  assert.equal(reopened.state.uploadedFiles.length, 0, 'reopening does not replay the old selection');
  reopened.state.addFiles([new File(['new'], 'new.txt')]);
  await reopened.state.handleUpload();
  assert.equal(requests, 1);
  assert.equal(reopened.continuations(), 1);
});


// The same real component-handler approach covers the remaining onboarding children.
function childHandlers(file: string, state: Record<string, unknown>) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const script = ts.createSourceFile(file, text.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(script.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(script) === 'onDestroy').map(node => node.getText(script)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ Error, crypto, tick: async () => {}, messagesContainer: null, onDestroy(callback: () => void) { context.close = callback; }, ...state });
  vm.runInContext(code, context);
  return context;
}

test('goals do not replay acknowledged tasks after a later task failure and require progress acknowledgement', async () => {
  const tasks: string[] = [];
  let failTask = true;
  let failProgress = true;
  let next = 0;
  const state = childHandlers('./onboarding/Step5_Goals.svelte', {
    goals: [{ id: 'one', entry: { goal: 'First' }, isNew: true, category: 'short' }, { id: 'two', entry: { goal: 'Second' }, isNew: true, category: 'short' }],
    saving: false, error: '', tasksCreated: 3, active: true, onNext() { next++; },
    async apiFetch(url: string, options: RequestInit) {
      const body = JSON.parse(String(options.body));
      if (url === '/api/tasks') {
        tasks.push(body.title);
        if (failTask && body.title === 'Second') throw new Error('Task connection failed');
        return Response.json({ success: true, filepath: '/fixture/' + body.title });
      }
      if (url === '/api/onboarding/state') return Response.json(failProgress ? { error: 'Progress unavailable' } : { success: true, state: initial() }, { status: failProgress ? 503 : 200 });
      return Response.json({ success: true });
    },
  });
  await state.handleNext();
  assert.equal(next, 0);
  assert.equal(state.error, 'Task connection failed');
  failTask = false;
  await state.handleNext();
  assert.deepEqual(tasks, ['First', 'Second', 'Second'], 'a confirmed first task must not be created twice');
  assert.equal(next, 0, 'progress failure must remain on the goals screen');
  assert.equal(state.error, 'Progress unavailable');
  failProgress = false;
  await state.handleNext();
  assert.deepEqual(tasks, ['First', 'Second', 'Second']);
  assert.equal(state.tasksCreated, 5, 'the recorded count includes earlier acknowledged tasks');
  assert.equal(next, 1);
});


test('goals load existing entries without dropping metadata or converting saved goals into new tasks', async () => {
  const retained = { goal: 'Saved goal', status: 'planning', sourceDesireId: 'existing-desire', description: 'Keep description' };
  const calls: { url: string; body?: any }[] = [];
  let fail = true;
  let next = 0;
  const state = childHandlers('./onboarding/Step5_Goals.svelte', { goals: [], active: true, loading: true, goalsLoaded: false,
    tasksCreated: 2, error: '', currentGoal: { title: 'New goal', category: 'short', description: 'New description' },
    onNext() { next++; }, async apiFetch(url: string, options?: RequestInit) {
      calls.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      if (!options) return Response.json(fail ? { error: 'Goals unavailable' } : { persona: { goals: { shortTerm: [retained] } } }, { status: fail ? 503 : 200 });
      return Response.json(url === '/api/tasks' ? { success: true, filepath: '/fixture/new-task' } : { success: true, state: initial() });
    } });
  await state.loadGoals();
  assert.equal(state.goalsLoaded, false);
  assert.equal(state.error, 'Goals unavailable');
  fail = false;
  await state.loadGoals();
  assert.equal(state.goalsLoaded, true);
  state.addGoal();
  await state.handleNext();
  const saved = calls.find(call => call.url === '/api/persona-core' && call.body)!.body.goals;
  assert.deepEqual(saved.shortTerm[0], retained);
  assert.deepEqual(calls.filter(call => call.url === '/api/tasks').map(call => call.body.title), ['New goal']);
  assert.equal(state.tasksCreated, 3);
  assert.equal(next, 1);
  state.goals = [];
  await state.handleNext();
  assert.deepEqual(calls.filter(call => call.url === '/api/persona-core' && call.body).at(-1)!.body.goals,
    { shortTerm: [], midTerm: [], longTerm: [] }, 'removing all loaded goals is an explicit empty edit');
});

test('survey advances through seven responses; progress retry preserves the extraction acknowledgement and transcript', async () => {
  let extractionCalls = 0;
  let failExtraction = true;
  let failProgress = true;
  const transcripts: unknown[] = [];
  const state = childHandlers('./onboarding/Step3_Personality.svelte', { messages: [{ role: 'assistant', content: 'Existing first question' }],
    questions: Array.from({ length: 7 }, (_, i) => 'Question ' + i), currentQuestion: 0, userResponse: '', processing: false,
    extracting: false, error: '', active: true, personalitySaved: false, progressSaved: false,
    async apiFetch(url: string, options: RequestInit) {
      if (url === '/api/onboarding/extract-persona') {
        extractionCalls++; transcripts.push(JSON.parse(String(options.body)).messages);
        return Response.json(failExtraction ? { error: 'Extraction unavailable' } : { success: true }, { status: failExtraction ? 500 : 200 });
      }
      return Response.json(failProgress ? { error: 'Progress unavailable' } : { success: true, state: initial() }, { status: failProgress ? 503 : 200 });
    } });
  for (let i = 0; i < 7; i++) { state.userResponse = 'Response ' + i; await state.handleSendResponse(); }
  assert.equal(state.currentQuestion, 7);
  assert.equal(extractionCalls, 1);
  assert.equal(state.progressSaved, false);
  assert.equal(state.error, 'Extraction unavailable');
  assert.equal(state.messages.some((message: { content: string }) => message.content.includes('raw conversation data')), false);
  failExtraction = false;
  await state.extractPersonality();
  assert.equal(state.personalitySaved, true);
  assert.equal(state.progressSaved, false);
  assert.equal(state.error, 'Progress unavailable');
  assert.deepEqual(transcripts[0], transcripts[1], 'retry preserves the original survey instead of injecting workflow errors');
  failProgress = false;
  await state.extractPersonality();
  assert.equal(extractionCalls, 2, 'a progress retry must not repeat successful extraction/application');
  assert.equal(state.progressSaved, true);
});

test('closing goals or survey leaves the sent request intact and prevents subsequent work', async () => {
  for (const kind of ['goals', 'survey']) {
    const calls: string[] = [];
    let finish!: (response: Response) => void;
    let next = 0;
    const state = childHandlers(kind === 'goals' ? './onboarding/Step5_Goals.svelte' : './onboarding/Step3_Personality.svelte', {
      active: true, goals: [{ id: 'new', entry: { goal: 'New goal' }, category: 'short', isNew: true }], tasksCreated: 0,
      questions: ['Question'], messages: [{ role: 'user', content: 'Answer' }], personalitySaved: false, progressSaved: false,
      onNext() { next++; }, async apiFetch(url: string, options: RequestInit) {
        calls.push(url); assert.equal(options.signal, undefined);
        return new Promise(resolve => { finish = resolve; });
      } });
    const pending = kind === 'goals' ? state.handleNext() : state.extractPersonality();
    state.close(); finish(Response.json({ success: true })); await pending;
    assert.equal(calls.length, 1);
    assert.equal(next, 0);
    await (kind === 'goals' ? state.handleNext() : state.extractPersonality());
    assert.equal(calls.length, 1);
  }
});

function generator(apiFetch: (url: string, options?: RequestInit) => Promise<Response>) {
  const saved = new Map<string, string>();
  const state = childHandlers('./PersonaGenerator.svelte', { apiFetch, currentSession: null, currentAnswer: '', active: true,
    copyToTraining: true, loading: false, error: '', showReviewDialog: false, reviewData: null, editingAnswerId: null, editedAnswerText: '', sessions: [],
    loadingInterval: null, loadingMessageIndex: 0, THINKING_MESSAGES: ['Existing display text'],
    localStorage: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) },
    setInterval: () => 1, clearInterval() {}, setTimeout() { assert.fail('Session delivery must not depend on a timer'); } });
  return { state, saved };
}

const interview = (status = 'active') => ({ sessionId: 'existing-session', status, questions: [{ id: 'q1', prompt: 'Existing prompt', category: 'values' }], answers: [], categoryCoverage: { values: 50 } });
const review = () => ({ extracted: { confidence: { overall: 0.8 } }, confidence: { overall: 0.8 }, diff: { summary: { additions: 1, updates: 0 }, changes: [], text: 'Saved diff' } });

test('shared Generator finalizes into review and applies only the selected strategy after an acknowledged request', async () => {
  const calls: { url: string; body?: any }[] = [];
  let failApply = true;
  const { state, saved } = generator(async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.endsWith('/start')) return Response.json({ sessionId: 'existing-session', question: interview().questions[0], progress: { values: 50 } });
    if (url.endsWith('/answer')) return Response.json({ isComplete: true });
    if (url.endsWith('/finalize')) return Response.json(review());
    if (url.endsWith('/apply')) return Response.json(failApply ? { error: 'Apply unavailable' } : { success: true }, { status: failApply ? 500 : 200 });
    return Response.json({ sessions: [] });
  });
  await state.startNewSession();
  assert.equal(state.currentSession.categoryCoverage.values, 50);
  state.copyToTraining = false;
  state.currentAnswer = 'A user answer'; await state.submitAnswer();
  assert.equal(calls.find(call => call.url.endsWith('/finalize'))!.body.copyToTraining, false, 'onboarding does not acquire standalone training export');
  assert.equal(state.currentSession.status, 'finalized');
  assert.equal(state.showReviewDialog, true);
  assert.equal(calls.filter(call => call.url.endsWith('/apply')).length, 0, 'finalize is a draft, not permission to apply');
  await state.handleApply('append');
  assert.equal(state.currentSession.status, 'finalized');
  assert.equal(state.showReviewDialog, true);
  assert.match(state.error, /Apply unavailable/);
  assert.equal(saved.get('persona-generator-session'), 'existing-session');
  failApply = false; await state.handleApply('append');
  assert.equal(state.currentSession.status, 'applied');
  assert.equal(state.showReviewDialog, false);
  assert.equal(saved.has('persona-generator-session'), false);
  assert.equal(calls.filter(call => call.url.endsWith('/apply')).at(-1)!.body.strategy, 'append');
});

test('Generator reload recovers a lost finalize/apply receipt without repeating model or persona work', async () => {
  let storedStatus = 'finalized';
  const calls: string[] = [];
  let fail = true;
  const { state, saved } = generator(async url => {
    calls.push(url);
    if (fail) return Response.json({ error: 'Load unavailable' }, { status: 503 });
    return Response.json({ session: interview(storedStatus), ...(storedStatus === 'finalized' ? { reviewData: review() } : {}) });
  });
  state.currentSession = interview('completed');
  saved.set('persona-generator-session', 'existing-session');
  await state.retryFinalize();
  assert.equal(saved.has('persona-generator-session'), true, 'temporary load failure cannot destroy the resume identity');
  fail = false; await state.retryFinalize();
  assert.equal(state.currentSession.status, 'finalized');
  assert.equal(state.showReviewDialog, true);
  assert.equal(state.reviewData.diff.text, 'Saved diff');
  storedStatus = 'applied'; await state.resumeSession('existing-session');
  assert.equal(state.currentSession.status, 'applied');
  assert.equal(state.showReviewDialog, false);
  assert.equal(saved.has('persona-generator-session'), false);
  assert.ok(calls.every(url => url.includes('/load?sessionId=')), 'recovery uses persisted receipts without re-execution');
});

test('closed Generator admits no finalization after an answer, or history work after apply', async () => {
  for (const action of ['answer', 'apply']) {
    let finish!: (response: Response) => void;
    const calls: string[] = [];
    const { state } = generator(async (url, options) => { calls.push(url); assert.equal(options?.signal, undefined); return new Promise(resolve => { finish = resolve; }); });
    state.currentSession = interview(action === 'answer' ? 'active' : 'finalized'); state.currentAnswer = 'An answer';
    const pending = action === 'answer' ? state.submitAnswer() : state.handleApply('merge');
    state.close(); finish(Response.json(action === 'answer' ? { isComplete: true } : { success: true })); await pending;
    assert.equal(calls.length, 1);
    await state.finalizeSession(); await state.handleApply('merge');
    assert.equal(calls.length, 1);
  }
});


test('review summary selects five actual changes before counting remaining changes', () => {
  const unchanged = Array.from({ length: 6 }, (_, i) => ({ field: 'Unchanged ' + i, action: 'no-change' }));
  const changed = Array.from({ length: 7 }, (_, i) => ({ field: 'Changed ' + i, action: 'add', newValue: 'Value ' + i }));
  const html = renderStep('./ReviewApplyDialog.svelte', { reviewData: { ...review(), diff: {
    changes: [...unchanged, ...changed], summary: { additions: 7, updates: 0 }, text: 'Full diff' } },
    onApply() {}, onDiscard() {}, onReload() {} });
  assert.match(html, /Changed 0/);
  assert.match(html, /Changed 4/);
  assert.doesNotMatch(html, /Changed 5|Unchanged 0/);
  assert.match(html, /\+ 2 more changes/);
  assert.match(html, /80%/);
});


test('failed goals read keeps Back, Skip and Retry available while Continue awaits existing data', async () => {
  const file = './onboarding/Step5_Goals.svelte';
  const state = childHandlers(file, { loading: true, goalsLoaded: false, error: '',
    async apiFetch() { return Response.json({ error: 'Saved goals unavailable' }, { status: 503 }); } });
  await state.loadGoals();
  assert.equal(state.goalsLoaded, false);
  // Initialize the actual SSR view with the failed handler result; markup/handlers are unchanged.
  const failed = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace('let loading = true;', `let loading = ${JSON.stringify(state.loading)};`)
    .replace("let error = '';", `let error = ${JSON.stringify(state.error)};`);
  for (const component of [undefined, failed]) {
    const html = renderStep(file, { onNext() {}, onBack() {}, onSkip() {} }, component);
    assert.match(html, /← Back/);
    assert.match(html, />\s*Skip\s*</);
    assert.doesNotMatch(html, /Continue →/);
    assert.doesNotMatch(html, /<button[^>]*\sdisabled(?:[\s=>])/);
    if (component) {
      assert.match(html, /Saved goals unavailable/);
      assert.match(html, /Retry loading goals/);
    }
  }
});
