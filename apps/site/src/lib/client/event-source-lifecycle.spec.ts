import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { get } from 'svelte/store';
import { coordinatorSnapshot, coordinatorConnection, coordinatorError, useWorkCoordinator } from '../stores/work-coordinator.js';
import { triggerManagerSnapshot, triggerManagerConnection, triggerManagerError, useTriggerManager } from '../stores/trigger-manager.js';
import { policyStore, type SecurityPolicy } from '../../stores/security-policy.js';
import { useThinkingTrace } from './composables/useThinkingTrace.js';
import { agentCatalogSnapshot, agentCatalogConnection, agentCatalogError, useAgentCatalog, registerCatalogAgent, unregisterCatalogAgent } from '../stores/agent-catalog.js';
import type { AgentCatalogSnapshot } from '../stores/agent-catalog.js';

test('thinking display uses task-supplied progress and reasoning without opening another stream', () => {
  const original = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor() { throw new Error('Thinking display must not open a subscription'); }
  } as unknown as typeof EventSource;
  try {
    const thinking = useThinkingTrace({ getCurrentMode: () => 'environment',
      getReasoningDepth: () => 1, getReasoningStagesCount: () => 0 });
    thinking.start();
    thinking.setTrace(['Task progress']);
    thinking.appendTrace('Task reasoning');
    assert.deepEqual(get(thinking.trace), ['Task progress', 'Task reasoning']);
    assert.equal(get(thinking.showIndicator), true);
    thinking.stop();
    assert.equal(get(thinking.active), false);
    assert.deepEqual(get(thinking.trace), []);
  } finally { globalThis.EventSource = original; }
});

function component(name: string) {
  const text = readFileSync(new URL(`../../components/${name}.svelte`, import.meta.url), 'utf8');
  const script = text.slice(text.indexOf('>', text.indexOf('<script')) + 1, text.indexOf('</script>'));
  return ts.createSourceFile(`${name}.ts`, script, ts.ScriptTarget.Latest, true);
}

test('Trigger Manager views release one shared subscription and their presentation clocks on every unmount', () => {
  for (const name of ['TriggerManagerDashboard', 'TriggerManagerSummary', 'TriggerManagerSettings']) {
    for (let cycle = 0; cycle < 2; cycle++) {
      let mounted!: () => unknown;
      let users = 0;
      const cleanup: (() => void)[] = [];
      const clocks = new Map<number, () => void>();
      const context = vm.createContext({
        $triggerManagerSnapshot: null, $triggerManagerConnection: 'connecting', $triggerManagerError: '',
        autonomyModeDefinition: () => ({ label: 'Reactive' }),
        onMount: (callback: typeof mounted) => { mounted = callback; },
        onDestroy: (callback: () => void) => cleanup.push(callback),
        useTriggerManager: () => { users++; return () => { users--; }; },
        setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 1_000); clocks.set(1, callback); return 1; },
        clearInterval: (id: number) => clocks.delete(id),
      });
      const ast = component(name);
      run(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'), context);
      const release = mounted();
      if (typeof release === 'function') cleanup.push(release as () => void);
      assert.equal(users, 1);
      assert.equal(clocks.size, name === 'TriggerManagerSettings' ? 0 : 1);
      for (const tick of clocks.values()) tick();
      assert.equal(users, 1, 'countdown ticks must not create another subscription');
      cleanup.forEach(close => close());
      assert.equal(users, 0, `${name} must release its subscription exactly once`);
      assert.equal(clocks.size, 0);
    }
  }
});

function functions(name: string, names: string[]) {
  const ast = component(name);
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name!.text))
    .map(node => node.getText(ast)).join('\n');
}

function run(code: string, context: vm.Context) {
  vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}

function fixture() {
  const sources: Source[] = [];
  class Source {
    static CLOSED = 2;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: (event: unknown) => void;
    constructor(readonly url: string) { sources.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    send(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  return { sources, Source };
}

test('Catalog views share one monitor stream, recover in place and release it on navigation', async () => {
  const { sources, Source } = fixture();
  const original = { source: globalThis.EventSource, window: globalThis.window, fetch: globalThis.fetch };
  const requests: string[] = [];
  globalThis.EventSource = Source as unknown as typeof EventSource;
  globalThis.window = {} as Window & typeof globalThis;
  globalThis.fetch = async input => { requests.push(String(input)); return new Response(JSON.stringify({ success: true, snapshot: {} })); };
  const releases: (() => void)[] = [];
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const dashboard = useAgentCatalog();
      const settings = useAgentCatalog();
      releases.push(dashboard, settings);
      const source = sources.at(-1)!;
      assert.equal(source?.url, '/api/monitor/stream');
      assert.equal(sources.filter(item => item.readyState !== Source.CLOSED).length, 1);
      assert.equal(get(agentCatalogConnection), 'loading');
      source.open();
      source.send({ type: 'error', error: 'Catalog source is unavailable' });
      assert.equal(get(agentCatalogError), 'Catalog source is unavailable');
      assert.equal(get(agentCatalogSnapshot), null);
      const catalog = { revision: cycle + 1, agents: [{ id: 'organizer' }] } as AgentCatalogSnapshot;
      source.send({ type: 'snapshot', catalog });
      assert.deepEqual(get(agentCatalogSnapshot), catalog);
      assert.equal(get(agentCatalogConnection), 'ready');
      assert.equal(get(agentCatalogError), null);
      source.onerror?.({});
      assert.equal(get(agentCatalogConnection), 'reconnecting');
      assert.deepEqual(get(agentCatalogSnapshot), catalog, 'reconnect retains the last received inventory');
      source.open();
      source.send({ type: 'snapshot', catalog: { ...catalog, revision: cycle + 2 } });
      assert.equal(get(agentCatalogSnapshot)?.revision, cycle + 2);
      assert.equal(sources.length, cycle + 1, 'the browser reconnects its existing EventSource');
      dashboard(); dashboard();
      assert.notEqual(source.readyState, Source.CLOSED, 'Settings still needs the subscription');
      settings();
      assert.equal(source.readyState, Source.CLOSED);
      assert.equal(get(agentCatalogConnection), 'idle');
      assert.equal(get(agentCatalogSnapshot), null);
      assert.equal(get(agentCatalogError), null);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [], 'live Catalog views must not poll or perform a second initial read');
  } finally {
    releases.forEach(release => release());
    globalThis.EventSource = original.source;
    globalThis.window = original.window;
    globalThis.fetch = original.fetch;
  }
});

test('Catalog registration uses its existing API while committed stream events own the displayed inventory', async () => {
  const { sources, Source } = fixture();
  const original = { source: globalThis.EventSource, window: globalThis.window, fetch: globalThis.fetch };
  const requests: Array<{ url: string; body: unknown }> = [];
  let failed = false;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify(failed ? { success: false, error: 'Registration is not permitted' }
      : { success: true, snapshot: { revision: 2, agents: [] } }), { status: failed ? 403 : 200 });
  };
  const release = useAgentCatalog();
  try {
    const source = sources[0];
    source.send({ type: 'snapshot', catalog: { revision: 1, agents: [] } });
    await registerCatalogAgent('organizer');
    await unregisterCatalogAgent('organizer');
    assert.deepEqual(requests, ['register', 'unregister'].map(action => ({
      url: '/api/agent-catalog/control', body: { action, agentId: 'organizer' },
    })));
    assert.equal(get(agentCatalogSnapshot)?.revision, 1, 'HTTP acknowledgement does not compete with the live snapshot');
    source.send({ type: 'snapshot', catalog: { revision: 2, agents: [] } });
    assert.equal(get(agentCatalogSnapshot)?.revision, 2);
    failed = true;
    await assert.rejects(registerCatalogAgent('organizer'), /Registration is not permitted/);
    assert.equal(get(agentCatalogSnapshot)?.revision, 2, 'failed registration cannot invent a new inventory');
  } finally {
    release();
    globalThis.EventSource = original.source;
    globalThis.window = original.window;
    globalThis.fetch = original.fetch;
  }
});

test('Queue and Trigger Manager share one stream, reconnect in place and release only their own consumers', () => {
  const { sources, Source } = fixture();
  const background = Array.from({ length: 12 }, (_, i) => new Source(`/existing-${i}`));
  const oldSource = globalThis.EventSource;
  const oldWindow = globalThis.window;
  const oldPolicy = get(policyStore);
  globalThis.EventSource = Source as unknown as typeof EventSource;
  globalThis.window = {} as Window & typeof globalThis;
  policyStore.set({ role: 'owner' } as SecurityPolicy);
  const releases: (() => void)[] = [];
  try {
    // Start in either order, as Queue and the persistent autonomy controls do.
    for (const triggerFirst of [false, true]) {
      const first = triggerFirst ? useTriggerManager() : useWorkCoordinator();
      const second = triggerFirst ? useWorkCoordinator() : useTriggerManager();
      const anotherTrigger = useTriggerManager();
      releases.push(first, second, anotherTrigger);
      const queue = sources.at(-1)!;
      assert.equal(queue.url, '/api/queue-stream');
      assert.equal(sources.filter(source => source.readyState !== 2).length, 13);
      queue.open();
      queue.send({ type: 'snapshot', snapshot: { tasks: [{ id: 'work' }], triggerManager: { lifecycle: 'running' } } });
      assert.equal(get(coordinatorSnapshot)?.tasks[0].id, 'work');
      assert.equal(get(triggerManagerSnapshot)?.lifecycle, 'running');
      assert.equal(get(triggerManagerConnection), 'live');
      const count = sources.length;
      queue.onerror?.({});
      assert.equal(get(coordinatorConnection), 'reconnecting');
      assert.equal(get(triggerManagerConnection), 'reconnecting');
      queue.open();
      assert.equal(sources.length, count, 'native reconnect must not allocate another source');
      queue.send({ type: 'trigger-state', snapshot: { tasks: [], triggerManager: { lifecycle: 'paused' } } });
      assert.equal(get(triggerManagerSnapshot)?.lifecycle, 'paused');
      queue.send({ type: 'error', error: 'Coordinator unavailable' });
      assert.equal(get(coordinatorError), 'Coordinator unavailable');
      assert.equal(get(triggerManagerError), 'Coordinator unavailable');
      queue.send({ type: 'reconcile', snapshot: { tasks: [], triggerManager: { lifecycle: 'running' } } });
      assert.equal(get(coordinatorError), '');
      assert.equal(get(triggerManagerError), '');
      first(); first(); second();
      assert.notEqual(queue.readyState, 2, 'the other Trigger Manager consumer still needs this stream');
      anotherTrigger();
      assert.equal(queue.readyState, 2);
      assert.equal(get(coordinatorConnection), 'idle');
      assert.equal(get(coordinatorSnapshot), null);
      assert.equal(get(triggerManagerSnapshot), null);
      assert.ok(background.every(source => source.readyState !== 2));
    }
    policyStore.set({ role: 'guest' } as SecurityPolicy);
    const count = sources.length;
    useTriggerManager()();
    assert.equal(sources.length, count, 'non-owner trigger controls do not subscribe');
  } finally {
    releases.forEach(release => release());
    policyStore.set(oldPolicy);
    globalThis.EventSource = oldSource;
    globalThis.window = oldWindow;
  }
});

test('buffer reconnect and teardown preserve speech and Queue; network errors do not allocate duplicates', () => {
  const { sources, Source } = fixture();
  const queue = new Source('/api/queue-stream');
  const context = vm.createContext({ EventSource: Source, console: { log() {}, error() {} },
    apiEventSource: (path: string) => new Source(path),
    document: { hidden: false }, selectedViews: new Set(['conversation', 'inner', 'system']),
    bufferStream: null,
    messages: { update(fn: (value: unknown[]) => unknown[]) { fn([]); } },
    messagesApi: { pushMessage() {} },
    replaceBufferSlice: (_msgs: unknown[], _mode: string, messages: unknown[]) => messages,
    queueStream: null, consumerId: 'fixture',
  });
  run(functions('TTSQueueConsumer', ['connectQueueStream']), context);
  context.connectQueueStream();
  const speech = sources.at(-1)!;
  context.connectQueueStream();
  assert.equal(sources.length, 2, 'speech connects once');
  run(functions('ChatInterface', ['connectMultipleBufferStreams', 'disconnectAllBufferStreams']), context);
  context.connectMultipleBufferStreams();
  assert.equal(sources.filter(source => source.readyState !== 2).length, 3);
  const firstBuffers = sources.slice(2);
  assert.equal(firstBuffers[0].url, '/api/buffer-stream?mode=conversation,inner,system,robot');
  for (const source of firstBuffers) source.onerror?.({});
  assert.equal(sources.length, 3, 'native EventSource reconnection keeps the same objects');
  context.connectMultipleBufferStreams();
  assert.ok(firstBuffers.every(source => source.readyState === 2));
  assert.equal(sources.filter(source => source.readyState !== 2).length, 3);
  context.disconnectAllBufferStreams();
  assert.deepEqual(sources.filter(source => source.readyState !== 2), [queue, speech]);
});

test('speech queue releases audio unlock listeners even when an admitted attempt finishes after teardown', async () => {
  for (const stage of ['unlock', 'delivery'] as const) {
    const sources: { closed: boolean; onmessage?: (event: { data: string }) => void }[] = [];
    const deliveries: unknown[] = [];
    const interrupted: string[] = [];
    const timers = new Set<number>();
    let mounted!: () => void, destroyed!: () => void;
    let unlockCalls = 0, cleanupCalls = 0;
    let finishUnlock!: (value: boolean) => void;
    let finishDelivery!: (response: Response) => void;
    const browser = Object.assign(new EventTarget(), {
      setInterval() { timers.add(1); return 1; }, clearInterval(id: number) { timers.delete(id); },
    });
    const ast = component('TTSQueueConsumer');
    const context = vm.createContext({ window: browser, crypto: { randomUUID: () => 'fixture' },
      console: { log() {}, warn() {}, error() {} }, readAssistantSpeechEnabled: () => true,
      onMount(callback: typeof mounted) { mounted = callback; }, onDestroy(callback: typeof destroyed) { destroyed = callback; },
      useTTS: () => ({ ensureAudioUnlocked() {
        if (++unlockCalls === 1) return Promise.resolve(true);
        return stage === 'unlock' ? new Promise<boolean>(resolve => { finishUnlock = resolve; }) : Promise.resolve(false);
      }, cleanup() { cleanupCalls++; }, speak() { assert.fail('blocked speech must not play'); },
      interruptPlaybackRequest(id: string) { interrupted.push(id); } }),
      apiEventSource() { const source = { closed: false, close() { this.closed = true; } }; sources.push(source); return source; },
      apiFetch: async (_url: string, init: RequestInit) => {
        deliveries.push(JSON.parse(String(init.body)));
        return stage === 'delivery' ? new Promise<Response>(resolve => { finishDelivery = resolve; }) : Response.json({});
      },
    });
    run(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'), context);
    mounted(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sources.length, 1);
    assert.equal(getEventListeners(browser, 'pointerdown').length, 0);
    const pending = context.playAdmittedItem({ id: 'queued-item', text: 'Complete admitted speech.', leaseToken: 'original-lease', generation: 0 });
    if (stage === 'delivery') await new Promise(resolve => setImmediate(resolve));
    sources[0].onmessage?.({ data: JSON.stringify({ type: 'interrupt', generation: 1 }) });
    assert.deepEqual(interrupted, ['queued-item']);
    destroyed();
    assert.equal(getEventListeners(browser, 'pointerdown').length + getEventListeners(browser, 'keydown').length, 0);
    if (stage === 'unlock') finishUnlock(false);
    else finishDelivery(Response.json({}));
    await pending;
    assert.deepEqual(deliveries, [{ itemId: 'queued-item', leaseToken: 'original-lease', action: 'retry' }], 'the original lease is released for redelivery, never acknowledged as completed');
    assert.equal(getEventListeners(browser, 'pointerdown').length + getEventListeners(browser, 'keydown').length, 0, `${stage} completion must not rearm destroyed listeners`);
    assert.equal(timers.size, 0);
    assert.equal(cleanupCalls, 1);
    assert.equal(sources[0].closed, true);
    assert.equal(vm.runInContext('queueInterruptedDeliveries.size', context), 0, 'finished deferred attempts release their temporary interruption marker');
  }
});

test('Active Operator mounts share coordinator observation and never start status polling', () => {
  const { sources, Source } = fixture();
  const originalSource = globalThis.EventSource;
  const originalWindow = globalThis.window;
  globalThis.EventSource = Source as unknown as typeof EventSource;
  globalThis.window = {} as Window & typeof globalThis;
  const releases: (() => void)[] = [];
  const mount = (name: string) => {
    const source = component(name);
    const statements = source.statements.filter(node => !ts.isImportDeclaration(node));
    // Svelte initializes declarations before running reactive statements.
    const code = [...statements.filter(node => !ts.isLabeledStatement(node)),
      ...statements.filter(node => ts.isLabeledStatement(node))].map(node => node.getText(source)).join('\n');
    const context = vm.createContext({
      $coordinatorSnapshot: get(coordinatorSnapshot), $coordinatorError: '', $coordinatorConnection: 'idle',
      $isOwner: true,
      AUTONOMY_MODES: [], useWorkCoordinator,
      onMount: (start: () => () => void) => releases.push(start()), onDestroy: () => {},
      setInterval: () => { throw new Error('Active Operator must not poll status'); },
      apiFetch: () => { throw new Error('Mounting Active Operator must not fetch separate status/config copies'); },
    });
    run(code, context);
  };
  try {
    mount('ActiveOperatorDashboard');
    mount('ActiveOperatorSettings');
    assert.equal(sources.length, 1);
    const source = sources[0];
    source.open();
    source.send({ type: 'snapshot', snapshot: { activeOperator: { mode: 'semi', operations: [] } } });
    assert.equal(get(coordinatorSnapshot)?.activeOperator?.mode, 'semi');
    source.onerror?.({});
    assert.equal(get(coordinatorConnection), 'reconnecting');
    source.open();
    source.send({ type: 'operator-state', snapshot: { activeOperator: { mode: 'reactive', operations: [] } } });
    assert.equal(get(coordinatorSnapshot)?.activeOperator?.mode, 'reactive');
    assert.equal(sources.length, 1, 'native reconnection keeps the shared connection');
    releases.shift()!();
    assert.notEqual(source.readyState, 2, 'the settings view still owns its subscription');
    releases.shift()!();
    assert.equal(source.readyState, 2);
    assert.equal(get(coordinatorSnapshot), null);
    mount('ActiveOperatorDashboard');
    assert.equal(sources.length, 2, 'reopening starts one fresh subscription');
  } finally {
    for (const release of releases) release();
    globalThis.EventSource = originalSource;
    globalThis.window = originalWindow;
  }
});

function monitorFixture(fetcher: (url: string, options?: RequestInit) => Promise<Response>) {
  const { sources, Source } = fixture();
  const ast = component('AgentMonitor');
  const statements = ast.statements.filter(node => !ts.isImportDeclaration(node));
  let start!: () => unknown;
  const cleanup: (() => void)[] = [];
  const requests: { url: string; options?: RequestInit }[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  const context = vm.createContext({ AbortController, DOMException, Error, console,
    get: () => true, isOwner: {},
    apiEventSource: (url: string) => new Source(url),
    apiFetch: (url: string, options?: RequestInit) => { requests.push({ url, options }); return fetcher(url, options); },
    onMount: (callback: typeof start) => { start = callback; }, onDestroy: (callback: () => void) => cleanup.push(callback),
    setTimeout: (callback: () => void, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  run([...statements.filter(node => !ts.isLabeledStatement(node)), ...statements.filter(ts.isLabeledStatement)]
    .map(node => node.getText(ast)).join('\n'), context);
  return { sources, requests, timers, set: (key: string, value: unknown) => { context[key] = value; },
    read: (expression: string) => vm.runInContext(expression, context),
    mount() { const result = start(); if (typeof result === 'function') cleanup.push(result as () => void); },
    unmount() { cleanup.splice(0).forEach(release => release()); } };
}

function monitorPayload(value = 'ws://old') {
  return { runningAgents: [], recentFailures: [], startableAgents: [], catalog: { agents: [{ id: 'environment-bridge', serviceRegistered: true }] }, agentData: {
    'environment-bridge': { agentId: 'environment-bridge', displayName: 'Environment Bridge', kind: 'connection',
      lifecycle: 'stopped', readiness: 'not-ready', dependencyHealth: 'configured', errors: [],
      variables: [{ key: 'adapterUrl', label: 'Gateway URL', type: 'url', writable: true, applyMode: 'restart', value }] },
  } };
}
const monitorResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test('Monitor variables follow received values until edited and release committed drafts without overwriting newer input', async () => {
  let finish!: (response: Response) => void;
  const ui = monitorFixture(async () => new Promise(resolve => { finish = resolve; }));
  const apply = (value: string) => { ui.set('payload', monitorPayload(value)); ui.read('applyPayload(payload)'); };
  const value = () => ui.read("draftValue('environment-bridge', agentData['environment-bridge'].variables[0])");
  apply('ws://old'); apply('ws://external'); assert.equal(value(), 'ws://external');
  ui.read("setDraftValue('environment-bridge', agentData['environment-bridge'].variables[0], '  ws://submitted  ')");
  const saving = ui.read("saveVariable(agentData['environment-bridge'], agentData['environment-bridge'].variables[0])");
  finish(monitorResponse({ success: true, agentData: monitorPayload('ws://submitted').agentData['environment-bridge'] }));
  await saving; assert.equal(value(), 'ws://submitted', 'display the backend-normalized committed value');
  apply('ws://later'); assert.equal(value(), 'ws://later');
  ui.read("setDraftValue('environment-bridge', agentData['environment-bridge'].variables[0], 'ws://saving')");
  const second = ui.read("saveVariable(agentData['environment-bridge'], agentData['environment-bridge'].variables[0])");
  ui.read("setDraftValue('environment-bridge', agentData['environment-bridge'].variables[0], 'ws://new-draft')");
  finish(monitorResponse({ success: true, agentData: monitorPayload('ws://saving').agentData['environment-bridge'] }));
  await second; assert.equal(value(), 'ws://new-draft');
});

test('Monitor save acknowledgements cannot replace a newer stream panel and failed saves retain the draft', async () => {
  let finish!: (response: Response) => void;
  const ui = monitorFixture(async () => new Promise(resolve => { finish = resolve; }));
  ui.set('payload', monitorPayload()); ui.read('applyPayload(payload)');
  ui.read("setDraftValue('environment-bridge', agentData['environment-bridge'].variables[0], 'ws://submitted')");
  const saving = ui.read("saveVariable(agentData['environment-bridge'], agentData['environment-bridge'].variables[0])");
  ui.set('payload', monitorPayload('ws://newer')); ui.read('applyPayload(payload)');
  finish(monitorResponse({ success: true, agentData: monitorPayload('ws://submitted').agentData['environment-bridge'] }));
  await saving;
  assert.equal(ui.read("agentData['environment-bridge'].variables[0].value"), 'ws://newer');
  ui.read("setDraftValue('environment-bridge', agentData['environment-bridge'].variables[0], 'ws://unsaved')");
  const failed = ui.read("saveVariable(agentData['environment-bridge'], agentData['environment-bridge'].variables[0])");
  finish(monitorResponse({ error: 'Write failed' }, 500)); await failed;
  assert.equal(ui.read("draftValue('environment-bridge', agentData['environment-bridge'].variables[0])"), 'ws://unsaved');
  assert.equal(ui.read('feedback.text'), 'Write failed');
});

test('Monitor observes one stream without initial, reconnect or post-action GETs and retains admitted action acknowledgements', async () => {
  const ui = monitorFixture(async (_url, options) => options?.method === 'POST'
    ? monitorResponse({ success: true, taskId: 'fixture-task', message: 'Control accepted' })
    : monitorResponse({ error: 'Read unavailable' }, 500));
  ui.mount(); assert.equal(ui.sources.length, 1); assert.equal(ui.requests.length, 0);
  ui.sources[0].open(); ui.sources[0].send({ type: 'snapshot', ...monitorPayload() });
  ui.sources[0].onerror?.({}); assert.equal(ui.requests.length, 0);
  await ui.read("runAgent('organizer')");
  assert.match(ui.read('feedback.text'), /queued as fixture-task/);
  await ui.read("controlAgent('clear-failure', 'organizer')");
  await ui.read('restartBootAgents()');
  assert.ok(ui.requests.every(request => request.options?.method === 'POST'));
  assert.equal(ui.timers.size, 0, 'no arbitrary request cutoff or feedback expiry');
  ui.unmount(); assert.equal(ui.sources[0].readyState, 2);
});

test('Monitor manual refresh cannot overwrite newer stream state and navigation releases pending reads and callbacks', async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    let finish!: (response: Response) => void;
    const ui = monitorFixture(async () => new Promise(resolve => { finish = resolve; }));
    ui.mount(); const source = ui.sources[0]; source.open();
    const read = ui.read('refreshNow()');
    source.send({ type: 'snapshot', ...monitorPayload('ws://current') });
    assert.equal(ui.requests[0].options?.signal?.aborted, true);
    finish(monitorResponse(monitorPayload('ws://obsolete'))); await read;
    assert.equal(ui.read("agentData['environment-bridge'].variables[0].value"), 'ws://current');
    const pending = ui.read('refreshNow()'); ui.unmount();
    assert.equal(ui.requests[1].options?.signal?.aborted, true);
    assert.equal(source.readyState, 2); assert.equal(source.onmessage, null); assert.equal(source.onerror, null);
    finish(monitorResponse(monitorPayload('ws://late'))); await pending;
    assert.equal(ui.read("agentData['environment-bridge'].variables[0].value"), 'ws://current');
  }
});

test('Monitor body connection saves every supplied setting before using the existing run or restart route', async () => {
  let failSetting = false;
  const ui = monitorFixture(async url => failSetting && url === '/api/monitor/agent-variable'
    ? monitorResponse({ error: 'Setting write failed' }, 500) : monitorResponse({ success: true, taskId: 'fixture-task' }));
  await ui.read("connectBody('environment-bridge', { adapterUrl: 'ws://fixture', followRobot: true })");
  assert.deepEqual(ui.requests.map(request => request.url), ['/api/monitor/agent-variable', '/api/monitor/agent-variable', '/api/agents/run']);
  ui.read("runningAgents = [{ name: 'environment-bridge' }]");
  await ui.read("connectBody('environment-bridge', { transport: 'local' })");
  assert.deepEqual(JSON.parse(String(ui.requests.at(-1)?.options?.body)), { action: 'restart', agent: 'environment-bridge' });
  const before = ui.requests.length; failSetting = true;
  await ui.read("connectBody('environment-bridge', { adapterUrl: 'ws://bad', transport: 'ssh' })");
  assert.equal(ui.requests.length, before + 1, 'a partial settings failure must not request a connection switch');
  assert.match(ui.read('feedback.text'), /no connection switch requested/);
});

test('Monitor exposes malformed acknowledgements and stream read failures without fabricating success or empty inventory', async () => {
  const ui = monitorFixture(async () => new Response('{malformed', { status: 200 }));
  ui.mount(); const source = ui.sources[0]; source.open();
  source.send({ type: 'error', error: 'Monitor source unavailable' });
  assert.equal(ui.read('streamError'), 'Monitor source unavailable');
  assert.equal(ui.read('hasSnapshot'), false);
  source.send({ type: 'snapshot', ...monitorPayload('ws://actual') });
  assert.equal(ui.read('streamError'), ''); assert.equal(ui.read('hasSnapshot'), true);
  await ui.read("runAgent('organizer')");
  assert.equal(ui.read('feedback.type'), 'error');
  assert.doesNotMatch(ui.read('feedback.text'), /start requested|started with|queued as/);
  assert.equal(ui.read("agentData['environment-bridge'].variables[0].value"), 'ws://actual');
  ui.unmount();
});

test('Sleep status shares the approved clock, reports read failures and releases cached data across remounts', async () => {
  const { sleepStatus } = await import('../stores/sleep-status.js');
  const previous = { window: globalThis.window, fetch: globalThis.fetch };
  const timers = new Map<number, () => Promise<void>>();
  const requests: { resolve: (response: Response) => void }[] = [];
  let nextTimer = 0;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const releases: (() => void)[] = [];
  globalThis.window = { setInterval(callback: () => Promise<void>, ms: number) {
    assert.equal(ms, 10_000); timers.set(++nextTimer, callback); return nextTimer;
  }, clearInterval(id: number) { timers.delete(id); } } as unknown as Window & typeof globalThis;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/sleep-status'); assert.equal(options?.cache, 'no-store');
    return new Promise<Response>(resolve => { requests.push({ resolve }); });
  };
  try {
    for (const staleOutcome of ['success', 'error']) {
      const seen: unknown[] = [];
      const first = sleepStatus.subscribe(value => seen.push(value)); releases.push(first);
      const second = sleepStatus.subscribe(() => {}); releases.push(second);
      await flush(); assert.equal(timers.size, 1);
      requests.at(-1)!.resolve(Response.json({ error: 'Sleep runtime unavailable' }, { status: 503 }));
      await flush();
      assert.deepEqual(get(sleepStatus), { data: null, error: 'Sleep runtime unavailable' });
      const tick = [...timers.values()][0](); await flush();
      requests.at(-1)!.resolve(Response.json({ status: 'sleeping', profile: 'old', lastChecked: '2026-11-05T12:00:00Z' })); await tick;
      assert.equal(get(sleepStatus).data?.status, 'sleeping'); assert.equal(get(sleepStatus).error, '');
      const oldRead = [...timers.values()][0](); await flush();
      const stale = requests.at(-1)!;
      first(); assert.equal(timers.size, 1); second(); assert.equal(timers.size, 0);
      const nextSeen: unknown[] = [];
      const next = sleepStatus.subscribe(value => nextSeen.push(value)); releases.push(next);
      assert.deepEqual(nextSeen[0], { data: null, error: '' }, 'previous profile state must not be the next view initial value');
      await flush(); requests.at(-1)!.resolve(Response.json({ status: 'awake', profile: 'new', lastChecked: '2026-11-05T12:01:00Z' })); await flush();
      stale.resolve(staleOutcome === 'success' ? Response.json({ status: 'dreaming', profile: 'old' })
        : Response.json({ error: 'Old profile failure' }, { status: 503 }));
      await oldRead;
      assert.equal(get(sleepStatus).data?.status, 'awake'); assert.equal(get(sleepStatus).error, '');
      next(); assert.equal(timers.size, 0);
    }
  } finally {
    releases.forEach(release => release());
    globalThis.window = previous.window; globalThis.fetch = previous.fetch;
  }
});

test('older overlapping Sleep completions cannot replace a newer published status or error while polling stays concurrent', async () => {
  const { sleepStatus } = await import('../stores/sleep-status.js');
  const previous = { window: globalThis.window, fetch: globalThis.fetch };
  let tick!: () => Promise<void>;
  let requests: ((response: Response) => void)[] = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  globalThis.window = { setInterval(callback: () => Promise<void>, ms: number) { assert.equal(ms, 10_000); tick = callback; return 1; },
    clearInterval() {} } as unknown as Window & typeof globalThis;
  globalThis.fetch = async () => new Promise<Response>(resolve => { requests.push(resolve); });
  try {
    for (const newer of ['success', 'error']) for (const older of ['success', 'error']) {
      requests = [];
      const release = sleepStatus.subscribe(() => {});
      try {
        await flush(); const newerRead = tick(); await flush();
        assert.equal(requests.length, 2, 'a slow read must not suppress the next approved poll');
        requests[1](newer === 'success' ? Response.json({ status: 'dreaming', lastChecked: '2026-11-05T12:02:00Z' })
          : Response.json({ error: 'Newer read failed' }, { status: 503 }));
        await newerRead;
        const published = get(sleepStatus);
        requests[0](older === 'success' ? Response.json({ status: 'awake', lastChecked: '2026-11-05T12:01:00Z' })
          : Response.json({ error: 'Older read failed' }, { status: 503 }));
        await flush();
        assert.deepEqual(get(sleepStatus), published, `${older} must not overwrite newer ${newer}`);
      } finally { release(); }
    }
  } finally { globalThis.window = previous.window; globalThis.fetch = previous.fetch; }
});
