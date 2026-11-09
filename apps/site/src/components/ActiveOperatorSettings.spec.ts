import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const component = fs.readFileSync(new URL('./ActiveOperatorSettings.svelte', import.meta.url), 'utf8');
const script = ts.createSourceFile('ActiveOperatorSettings.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(script.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(script)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const projection = ts.transpileModule(script.statements.filter(ts.isLabeledStatement).map(node => node.getText(script)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function settings(fetch: (url: string, options: RequestInit) => Promise<Response>) {
  const state = vm.createContext({ apiFetch: fetch, semiAssessmentMinutes: 7, intervalDraft: { value: 7 },
    saving: false, error: '', autonomyMode: 'semi', confirm: () => true, $coordinatorError: '',
    $coordinatorSnapshot: { activeOperator: { configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 5 } } } });
  vm.runInContext(code, state);
  vm.runInContext(projection, state);
  return state;
}

test('an interval save does not replace a newer Coordinator value with its older HTTP reply', async () => {
  let reply!: (response: Response) => void;
  const state = settings(async (url, options) => {
    assert.equal(url, '/api/active-operator/config');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(String(options.body)).semiAssessmentMinutes, 7);
    return new Promise(resolve => { reply = resolve; });
  });
  const saving = state.saveAssessmentInterval();
  assert.equal(state.saving, true);
  // The Coordinator can deliver another client's committed edit while this response is in flight.
  state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = 8;
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 7, 'the in-flight draft remains visible');
  reply(new Response(JSON.stringify({ semiAssessmentMinutes: 7 })));
  await saving;
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 8);
  assert.equal(state.intervalDraft, null);
  assert.equal(state.saving, false);
});

test('HTTP completion preserves the submitted interval until the stream observes an interval change', async () => {
  for (const nextInterval of [7, 9]) {
    const state = settings(async () => new Response(JSON.stringify({ semiAssessmentMinutes: 7 })));
    await state.saveAssessmentInterval();
    vm.runInContext(projection, state);
    assert.equal(state.semiAssessmentMinutes, 7, 'HTTP success must not restore the old streamed interval');
    assert.equal(state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes, 5,
      'the draft must not rewrite canonical state');
    assert.equal(state.saving, false, 'HTTP completion releases the action without waiting for observation');
    state.$coordinatorSnapshot = { activeOperatorError: 'Operator status unavailable' };
    vm.runInContext(projection, state);
    assert.equal(state.semiAssessmentMinutes, 7, 'missing configuration is not an observed interval change');
    state.$coordinatorSnapshot = { activeOperator: { configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 5 } } };
    vm.runInContext(projection, state);
    assert.equal(state.semiAssessmentMinutes, 7, 'unrelated snapshots must not discard the submitted draft');
    state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = nextInterval;
    vm.runInContext(projection, state);
    assert.equal(state.semiAssessmentMinutes, nextInterval);
    assert.equal(state.intervalDraft, null);
    state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = 5;
    vm.runInContext(projection, state);
    assert.equal(state.semiAssessmentMinutes, 5, 'released drafts must not reappear on a later interval change');
  }
});

test('failed saves keep the draft and expose the backend error', async () => {
  const state = settings(async () => new Response(JSON.stringify({ error: 'Configuration write failed' }), { status: 500 }));
  await state.saveAssessmentInterval();
  assert.equal(state.intervalDraft.value, 7);
  assert.equal(Object.hasOwn(state.intervalDraft, 'savedFrom'), false);
  assert.equal(state.error, 'Configuration write failed');
  assert.equal(state.saving, false);
});

test('a delayed saved update cannot discard a subsequent edit, and unchanged saves release their draft', async () => {
  const state = settings(async () => new Response('{}'));
  await state.saveAssessmentInterval();
  vm.runInContext(projection, state);
  state.intervalDraft = { value: 9 };
  state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = 7;
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 9);
  await state.saveAssessmentInterval();
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 9);
  state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = 9;
  vm.runInContext(projection, state);
  assert.equal(state.intervalDraft, null);
  await state.saveAssessmentInterval();
  vm.runInContext(projection, state);
  assert.equal(state.intervalDraft, null, 'saving an unchanged interval needs no subsequent change event');
});

test('a successful emergency stop clears a previous error and leaves mode ownership with the stream', async () => {
  const state = settings(async (url, options) => {
    assert.equal(url, '/api/active-operator/control');
    assert.equal(JSON.parse(String(options.body)).action, 'emergency-stop');
    return new Response(JSON.stringify({ success: true, mode: 'reactive' }));
  });
  state.autonomyMode = 'full';
  state.error = 'Previous request failed';
  await state.emergencyStop();
  assert.equal(state.error, '');
  assert.equal(state.autonomyMode, 'full', 'the confirmed mode arrives through the Coordinator stream');
  assert.equal(state.saving, false);
});

test('cancelling the existing stop confirmation does not send a command or change local state', async () => {
  const state = settings(async () => { throw new Error('A cancelled action must not fetch'); });
  state.confirm = () => false;
  state.error = 'Previous request failed';
  await state.emergencyStop();
  assert.equal(state.error, 'Previous request failed');
  assert.equal(state.saving, false);
});

test('mode requests preserve the backend contract and release saving state on failure', async () => {
  const state = settings(async (url, options) => {
    assert.equal(url, '/api/active-operator/control');
    assert.equal(JSON.parse(String(options.body)).mode, 'semi');
    return new Response(JSON.stringify({ error: 'Mode change failed' }), { status: 500 });
  });
  await state.setMode('semi');
  assert.equal(state.error, 'Mode change failed');
  assert.equal(state.saving, false);
});

test('a committed interval change preserves an unsaved draft and becomes visible after the draft is released', () => {
  const state = settings(async () => { throw new Error('This projection must not fetch'); });
  state.$coordinatorError = '';
  state.$coordinatorSnapshot = { activeOperator: { configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 5 } } };
  vm.runInContext(projection, state);
  state.intervalDraft = { value: 7 };
  state.semiAssessmentMinutes = 7;
  state.$coordinatorSnapshot.activeOperator.configuration.semiAssessmentMinutes = 8;
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 7);
  state.intervalDraft = null;
  vm.runInContext(projection, state);
  assert.equal(state.semiAssessmentMinutes, 8);
});

test('settings instances share the existing Coordinator stream and release it only after the last unmount', async () => {
  const { writable, get } = await import('svelte/store');
  const streams: { onopen?: () => void; onmessage?: (event: { data: string }) => void; onerror?: () => void; close: () => void }[] = [];
  let closed = 0;
  const storeCode = ts.transpileModule(fs.readFileSync(new URL('../lib/stores/work-coordinator.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const store = vm.createContext({ exports: {}, window: {}, require: (id: string) => {
    if (id === 'svelte/store') return { writable };
    if (id === '../client/api-config') return { apiEventSource: (url: string) => {
      assert.equal(url, '/api/queue-stream');
      const stream = { close: () => { closed++; } };
      streams.push(stream);
      return stream;
    } };
    throw new Error(`Unexpected dependency ${id}`);
  } });
  vm.runInContext(storeCode, store);
  const mountCode = ts.transpileModule(script.statements.filter(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(script) === 'onMount')
    .map(node => node.getText(script)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let mount!: () => () => void;
  vm.runInNewContext(mountCode, { onMount: (callback: typeof mount) => { mount = callback; },
    useWorkCoordinator: store.exports.useWorkCoordinator });
  const first = mount();
  const second = mount();
  assert.equal(streams.length, 1);
  streams[0].onopen!();
  streams[0].onmessage!({ data: JSON.stringify({ snapshot: { activeOperator: { configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 8 } } } }) });
  assert.equal((get(store.exports.coordinatorSnapshot) as { activeOperator: { configuration: { semiAssessmentMinutes: number } } }).activeOperator.configuration.semiAssessmentMinutes, 8);
  streams[0].onerror!();
  assert.equal(get(store.exports.coordinatorConnection), 'reconnecting');
  streams[0].onopen!();
  assert.equal(get(store.exports.coordinatorConnection), 'live');
  first(); first();
  assert.equal(closed, 0);
  second();
  assert.equal(closed, 1);
  assert.equal(get(store.exports.coordinatorSnapshot), null);
  const third = mount();
  assert.equal(streams.length, 2);
  third();
  assert.equal(closed, 2);
});

test('native Svelte rendering preserves loading, saved values, reconnect status and owner visibility', async () => {
  const stores = await import('../lib/stores/work-coordinator.js');
  const { policyStore } = await import('../stores/security-policy.js');
  const { get } = await import('svelte/store');
  const previous = { policy: get(policyStore), snapshot: get(stores.coordinatorSnapshot), connection: get(stores.coordinatorConnection) };
  const file = new URL('./ActiveOperatorSettings.svelte', import.meta.url);
  const require = createRequire(import.meta.url);
  const generated = compile(component, { filename: fileURLToPath(file), generate: 'server' }).js.code;
  const code = generated.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) =>
    'from ' + JSON.stringify(specifier.startsWith('.') ? new URL(specifier, file).href : pathToFileURL(require.resolve(specifier)).href));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ainekio-settings-render-'));
  try {
    const compiled = path.join(temp, 'settings.mjs');
    fs.writeFileSync(compiled, code);
    const { default: Settings } = await import(pathToFileURL(compiled).href);
    const policy = { role: 'owner' as const, mode: 'environment' as const, canWriteMemory: true, canUseOperator: true,
      canChangeMode: true, canChangeTrust: true, canAccessTraining: true, canFactoryReset: true };
    policyStore.set(policy);
    stores.coordinatorSnapshot.set(null);
    stores.coordinatorConnection.set('connecting');
    let body = render(Settings).body;
    assert.match(body, /Connecting/);
    assert.doesNotMatch(body, /value="5"/);
    const frame: import('../lib/stores/work-coordinator.js').QueueSnapshot = {
      lifecycle: 'running', running: true, paused: false, degraded: false, tasks: [], executions: [], canConfirmRobotStopped: false,
      activeOperator: { configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 8 }, mode: 'semi', health: 'healthy',
        operations: [], assessments: [], queue: { length: 0, tasks: [] }, robotOperator: { runtime: null, episodes: [] } },
    };
    stores.coordinatorSnapshot.set(frame);
    stores.coordinatorConnection.set('live');
    body = render(Settings).body;
    assert.match(body, /value="8"/);
    assert.doesNotMatch(body, /Emergency stop autonomy/);
    stores.coordinatorConnection.set('reconnecting');
    assert.match(render(Settings).body, /reconnecting/);
    stores.coordinatorSnapshot.set({ ...frame, activeOperator: { ...frame.activeOperator!,
      configuration: { autonomyMode: 'full', semiAssessmentMinutes: 8 } } });
    assert.match(render(Settings).body, /Emergency stop autonomy/);
    policyStore.set({ ...policy, role: 'guest' });
    assert.doesNotMatch(render(Settings).body, /Active Operator/);
  } finally {
    policyStore.set(previous.policy);
    stores.coordinatorSnapshot.set(previous.snapshot);
    stores.coordinatorConnection.set(previous.connection);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
