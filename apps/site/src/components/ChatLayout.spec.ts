import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { get, writable } from 'svelte/store';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const transpile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

// Use the same component-handler test approach as AuthGate.spec.ts. Browser
// events and HTTP responses are fixtures; the initialization/fetch code is real.
test('portal mount delivers delayed status once and reuses the authenticated session', async () => {
  const script = read('./ChatLayout.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const source = ts.createSourceFile('ChatLayout.ts', script, ts.ScriptTarget.Latest, true);
  const functions = ['loadStatus', 'loadCognitiveModeState', 'fetchSystemStatus', 'stopRightSidebarResize', 'saveRightSidebarWidth'];
  const code = source.statements.filter(statement =>
    (ts.isFunctionDeclaration(statement) && functions.includes(statement.name!.text))
    || (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(source) === 'onMount'))
    .map(statement => statement.getText(source)).join('\n');
  const statusStore = writable<unknown>(null);
  const requests: string[] = [];
  let finishStatus!: (response: Response) => void;
  let mounted!: () => () => void;
  let failStatus = false;
  const state = vm.createContext({
    statusStore, rightSidebarStore: writable(false),
    apiFetch: async (url: string) => {
      requests.push(url);
      if (url === '/api/status') {
        if (failStatus) return new Response('{}', { status: 500 });
        return new Promise<Response>(resolve => { finishStatus = resolve; });
      }
      return new Response(JSON.stringify({ success: true, modes: [] }));
    },
    fetchSecurityPolicy: () => { requests.push('/api/security/policy'); },
    onMount: (callback: typeof mounted) => { mounted = callback; },
    updateScreenSize() {}, handleGlobalClick() {}, isMobile: false,
    leftSidebarOpen: false, rightSidebarWidth: 280, isResizingRightSidebar: false,
    window: Object.assign(new EventTarget(), { innerHeight: 800 }),
    document: Object.assign(new EventTarget(), { hidden: false, documentElement: { style: { setProperty() {} } } }),
    localStorage: { getItem: () => null },
    modeLoading: false, cognitiveModes: [], modeError: '',
    systemStatus: null, allowedModes: [],
    console: { log() {}, warn() {}, error() {} },
    isMobileApp: () => false, isHostedUi: () => false, getApiBaseUrl: () => '',
  });
  // Execute any page-level bootstrap script too, so a second fetch cannot hide
  // outside the layout. Theme initialization is checked separately below.
  for (const match of read('../pages/index.astro').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const page = ts.createSourceFile('index.ts', match[1], ts.ScriptTarget.Latest, true);
    vm.runInContext(transpile(page.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(page)).join('\n')), state);
  }
  vm.runInContext(transpile(code), state);
  const unmount = mounted();
  assert.equal(requests.filter(url => url === '/api/status').length, 1);
  assert.equal(requests.includes('/api/auth/me'), false);
  assert.equal(requests.includes('/api/security/policy'), false);
  assert.equal(get(statusStore), null);
  const status = { identity: { name: 'Fixture', icon: '/fixture.svg' } };
  finishStatus(new Response(JSON.stringify(status)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(get(statusStore), status);
  unmount();
  const requestCount = requests.length;
  state.window.dispatchEvent(new Event('focus'));
  state.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, requestCount, 'destroyed layout releases its refresh listeners');

  failStatus = true;
  await state.loadStatus();
  assert.deepEqual(get(statusStore), status, 'a failed refresh must not publish an error payload as status');
  failStatus = false;
  const refresh = state.loadStatus();
  finishStatus(new Response(JSON.stringify({ identity: { name: 'Updated fixture' } })));
  await refresh;
  assert.deepEqual(get(statusStore), { identity: { name: 'Updated fixture' } });
});

test('both page shells restore the saved theme, fall back to OS preference, and allow storage denial', () => {
  const init = read('./ThemeInit.astro').match(/<script is:inline>([\s\S]*?)<\/script>/)![1];
  for (const shell of ['../pages/index.astro', '../layouts/Base.astro']) {
    assert.match(read(shell), /<ThemeInit\s*\/>/);
    for (const saved of ['light', 'dark', null, 'denied']) {
      for (const osDark of [true, false]) {
        const classes = new Set<string>(['dark']);
        vm.runInNewContext(init, {
          localStorage: { getItem(key: string) {
            assert.equal(key, 'metahuman-theme');
            if (saved === 'denied') throw new Error('Storage denied');
            return saved;
          } },
          window: { matchMedia: () => ({ matches: osDark }) },
          document: { documentElement: { classList: { toggle(name: string, enabled: boolean) {
            if (enabled) classes.add(name); else classes.delete(name);
          } } } },
        });
        assert.equal(classes.has('dark'), saved === null || saved === 'denied' ? osDark : saved === 'dark');
      }
    }
  }
});

const componentRequire = createRequire(import.meta.url);

// Compile the real Svelte templates and render them with isolated stores and
// child components. This checks visible output and child admission, not CSS text.
function renderedComponent(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const compiled = compile(read(file), { filename: file, generate: 'server' }).js.code;
  const code = ts.transpileModule(compiled, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const context = vm.createContext({ ...globals, exports: {}, require: (id: string) =>
    Object.hasOwn(dependencies, id) ? dependencies[id] : componentRequire(id) });
  vm.runInContext(code, context);
  return context.exports.default;
}

test('rendered header follows shared identity/mode and collapsed asides are inert', async () => {
  const { render } = await import('svelte/server');
  const statusStore = writable({ identity: { name: 'First persona', icon: '/first.svg' } });
  const policyStore = writable({ mode: 'dual' });
  const rightSidebarOpen = writable(false);
  const component = renderedComponent('./ChatLayout.svelte', {
    '../stores/navigation': { statusStore, rightSidebarOpen, statusRefreshTrigger: writable(0),
      nodeEditorMode: writable(false), currentUserStore: writable(null), userDisplayNameStore: writable('Fixture'),
      graphEditorHref: () => '?workspace=graph-editor' },
    '../stores/security-policy': { policyStore, isOwner: writable(false) },
    '../lib/client/api-config': { apiUrl: (url: string) => url },
    './HeadlessClaimBanner.svelte': { default: () => {} },
    // Network initialization is separate from this rendered-state check.
    svelte: { ...componentRequire('svelte'), onMount: () => {} },
  });
  let html = render(component).body;
  assert.match(html, /First persona/);
  assert.match(html, /alt="Persona icon"/);
  const asides = [...html.matchAll(/<aside\b([^>]*)>/g)];
  assert.equal(asides.length, 2);
  for (const aside of asides) {
    assert.match(aside[1], /\binert\b/);
    assert.match(aside[1], /aria-hidden="true"/);
  }
  statusStore.set({ identity: { name: 'Second persona', icon: '' } });
  rightSidebarOpen.set(true);
  html = render(component).body;
  assert.match(html, /Second persona/);
  assert.doesNotMatch(html, /First persona|alt="Persona icon"/);
  const right = [...html.matchAll(/<aside\b([^>]*)>/g)][1][1];
  assert.doesNotMatch(right, /\binert\b/);
  assert.match(right, /aria-hidden="false"/);

  // Execute the real projection with the already-fetched catalog to verify a
  // policy refresh updates the header without reloading the catalog.
  const script = ts.createSourceFile('layout.ts', read('./ChatLayout.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const projection = script.statements.filter(s => ts.isLabeledStatement(s) && s.getText(script).startsWith('$: cognitiveMode'));
  const state = vm.createContext({ cognitiveModes: [{ id: 'dual' }, { id: 'environment' }], cognitiveMode: null, $policyStore: { mode: 'dual' } });
  const code = transpile(projection.map(s => s.getText(script)).join('\n'));
  vm.runInContext(code, state);
  assert.equal(state.cognitiveMode.id, 'dual');
  state.$policyStore = { mode: 'environment' };
  vm.runInContext(code, state);
  assert.equal(state.cognitiveMode.id, 'environment');
  state.$policyStore = null;
  vm.runInContext(code, state);
  assert.equal(state.cognitiveMode, null, 'missing policy must not label a default mode as active');
});

test('closed developer panel omits stream consumers across reopening', async () => {
  const { render } = await import('svelte/server');
  const rightSidebarOpen = writable(false);
  const mounted: string[] = [];
  let selectedTab = 'queue';
  const component = renderedComponent('./RightSidebar.svelte', {
    '../stores/navigation': { rightSidebarOpen },
    '../stores/security-policy': { isOwner: writable(true) },
    './AgentMonitor.svelte': { default: () => mounted.push('monitor') },
    './QueuePanel.svelte': { default: () => mounted.push('queue') },
    './ServerStatus.svelte': { default: () => mounted.push('servers') },
    svelte: { onMount: (callback: () => void) => callback() },
  }, { localStorage: { getItem: () => selectedTab, setItem() {} } });
  for (selectedTab of ['queue', 'monitor', 'servers']) {
    for (const visible of [false, true, false, true, false]) {
      rightSidebarOpen.set(visible);
      const before = mounted.length;
      assert.match(render(component).body, /Queue/);
      assert.deepEqual(mounted.slice(before), visible ? [selectedTab] : []);
    }
  }
});

test('resize ends on cancellation, blur, closure and destruction; keyboard width persists', () => {
  const script = ts.createSourceFile('layout.ts', read('./ChatLayout.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const names = ['startRightSidebarResize', 'handleRightSidebarResize', 'stopRightSidebarResize',
    'saveRightSidebarWidth', 'resizeRightSidebarWithKeyboard', 'toggleRightSidebar', 'updateScreenSize'];
  const code = script.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name!.text)
    || ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(script) === 'onMount')
    .map(s => s.getText(script)).join('\n');
  const document = Object.assign(new EventTarget(), { hidden: false,
    body: { style: { cursor: 'auto', userSelect: 'text' } }, documentElement: { style: { setProperty() {} } } });
  const window = Object.assign(new EventTarget(), { innerHeight: 800, innerWidth: 1024 });
  const stored = new Map<string, string>();
  let mount!: () => () => void;
  const state = vm.createContext({ document, window, localStorage: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
  }, rightSidebarStore: writable(true), isMobile: false, isResizingRightSidebar: false,
    rightSidebarWidth: 280, resizeStartX: 0, resizeStartWidth: 0, resizeUserSelect: '', resizeCursor: '', leftSidebarOpen: false,
    onMount: (callback: typeof mount) => { mount = callback; }, updateScreenSize() {}, handleGlobalClick() {},
    loadStatus() {}, loadCognitiveModeState() {}, fetchSystemStatus() {}, fetchSecurityPolicy() {},
  });
  vm.runInContext(transpile(code), state);
  for (const end of ['touchcancel', 'blur', 'close', 'mobile', 'destroy']) {
    window.innerWidth = 1024;
    const cleanup = mount();
    state.startRightSidebarResize({ clientX: 600 });
    state.handleRightSidebarResize({ clientX: 550 });
    if (end === 'touchcancel') document.dispatchEvent(new Event(end));
    if (end === 'blur') window.dispatchEvent(new Event(end));
    if (end === 'close') state.toggleRightSidebar();
    if (end === 'mobile') { window.innerWidth = 600; state.updateScreenSize(); }
    if (end !== 'destroy') assert.equal(state.isResizingRightSidebar, false, end);
    cleanup();
    for (const type of ['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel']) {
      assert.equal(getEventListeners(document, type).length, 0, type);
    }
    assert.equal(getEventListeners(window, 'blur').length, 0);
    assert.equal(state.isResizingRightSidebar, false, end);
    assert.deepEqual(document.body.style, { cursor: 'auto', userSelect: 'text' });
    const width = state.rightSidebarWidth;
    document.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 0 }));
    assert.equal(state.rightSidebarWidth, width, 'ended drag no longer changes width');
    assert.equal(stored.get('mh-right-sidebar-width'), String(width));
  }
  state.resizeRightSidebarWithKeyboard({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(stored.get('mh-right-sidebar-width'), String(state.rightSidebarWidth));
  const restored = mount();
  assert.equal(state.rightSidebarWidth, Number(stored.get('mh-right-sidebar-width')));
  restored();
});

test('unknown saved and URL views return to Chat; valid history and HMR keep working', () => {
  const source = ts.createSourceFile('navigation.ts', read('../stores/navigation.ts'), ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(s =>
    ts.isFunctionDeclaration(s) && ['restoredView', 'createNavigationStore'].includes(s.name!.text)
    || ts.isVariableStatement(s) && /^(export )?const (navigationItems|HEAVY_VIEWS)\b/.test(s.getText(source)))
    .map(s => s.getText(source).replace(/^export /, '')).join('\n');
  for (const [hash, saved, expected] of [['#view=removed', 'dashboard', 'chat'], ['', 'removed', 'chat'],
    ['#view=voice', 'dashboard', 'voice'], ['', 'dashboard', 'dashboard'], ['#view=training', '', 'chat']]) {
    const window = Object.assign(new EventTarget(), { location: { hash } });
    const stored = new Map([['mh_active_view', saved]]);
    const state = vm.createContext({ window, writable, URLSearchParams,
      history: { replaceState: (_: unknown, __: string, hash: string) => { window.location.hash = hash; } },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    });
    vm.runInContext(transpile(code), state);
    const store = state.createNavigationStore('chat');
    assert.equal(get(store), expected);
    assert.equal(stored.get('mh_active_view'), expected);
    window.location.hash = '#view=persona';
    window.dispatchEvent(new Event('hashchange'));
    assert.equal(get(store), 'persona');
    window.location.hash = '#view=removed';
    window.dispatchEvent(new Event('hashchange'));
    assert.equal(get(store), 'chat');
    assert.equal(state.createNavigationStore('chat'), store);
  }
});

test('final terminal reply renders as Big Brother while ordinary replies retain the persona name', async () => {
  const { render } = await import('svelte/server');
  const { formatTimestamp, parseThinkBlocks } = await import('./chat/message-discriminator');
  const base = renderedComponent('./chat/cards/BaseMessageCard.svelte', {
    '../../../stores/navigation': { personaNameStore: writable('Fixture Persona'), userDisplayNameStore: writable('Fixture Owner') },
    '../message-discriminator': { formatTimestamp },
  });
  const assistant = renderedComponent('./chat/cards/AssistantMessageCard.svelte', {
    './BaseMessageCard.svelte': { default: base },
    '../../Thinking.svelte': { default: () => {} },
    '../message-discriminator': { parseThinkBlocks },
  });
  const message = { role: 'assistant', content: 'Exact Codex final response.', timestamp: 1,
    meta: { source: 'big-brother', speaker: 'Big Brother' } };
  const terminal = render(assistant, { props: { message, index: 0 } }).body;
  assert.match(terminal, /Big Brother/);
  assert.match(terminal, /Exact Codex final response\./);
  assert.doesNotMatch(terminal, /Fixture Persona/);
  const ordinary = render(assistant, { props: { message: { ...message, meta: {} }, index: 0 } }).body;
  assert.match(ordinary, /Fixture Persona/);
  assert.doesNotMatch(ordinary, /Big Brother/);
});

test('rendered chat starts with Conversation alone and shows routing choices for combined Conversation and Terminal', async () => {
  const { render } = await import('svelte/server');
  const feed = await import('../lib/client/buffer-feed');
  const speech = await import('../lib/client/assistant-speech-preference');
  const modes = await import('../lib/client/active-operator-modes');
  const transport = await import('../lib/client/conversation-transport');
  const messageOwner = await import('../lib/client/composables/useMessages');
  const inputs: Array<{ readOnly: boolean; composeTarget: string }> = [];
  const blank = { default() {} };
  const component = renderedComponent('./ChatInterface.svelte', {
    svelte: { onMount() {}, beforeUpdate() {}, afterUpdate() {}, onDestroy() {} },
    './Thinking.svelte': blank, './ApprovalPrompt.svelte': blank,
    './terminal/TerminalChat.svelte': blank, './chat/MessageList.svelte': blank,
    './chat/InputArea.svelte': { default: (_payload: unknown, props: { readOnly: boolean; composeTarget: string }) => { inputs.push(props); } },
    '../stores/security-policy': { canUseOperator: writable(true), currentMode: writable('dual'), isOwner: writable(true) },
    '../stores/navigation': { yoloModeStore: writable(false), statusRefreshTrigger: writable(0) },
    '../lib/client/utils/audio-utils.js': { calculateVoiceVolume() {} },
    '../lib/client/assistant-speech-preference': speech,
    '../lib/client/composables/useTTS': { useTTS: () => ({ isPlaying: writable(false), isLoading: writable(false) }) },
    '../lib/client/composables/useMicrophone': { useMicrophone: () => ({ isRecording: writable(false), isContinuousMode: writable(false),
      interimTranscript: writable(''), isNativeMode: writable(false), isConversationMode: writable(false) }) },
    '../lib/client/composables/useThinkingTrace': { useThinkingTrace: () => ({ trace: writable(''), statusLabel: writable(''),
      active: writable(false), steps: writable(''), showIndicator: writable(false) }) },
    '../lib/client/composables/useMessages': messageOwner,
    '../lib/client/server-health': { forceHealthCheck() { throw new Error('Render must not submit work'); } },
    '../lib/client/api-config': { apiFetch() { throw new Error('Render must not fetch'); }, apiEventSource() { throw new Error('Render must not subscribe'); } },
    '../stores/proposals': { connectProposalsStream() {}, disconnectProposalsStream() {} },
    '../lib/client/active-operator-modes': modes,
    '../lib/stores/trigger-manager': { setActiveOperatorMode() {}, triggerManagerSnapshot: writable(null), useTriggerManager() {} },
    '../lib/client/buffer-feed': feed,
    '../lib/client/conversation-transport': transport,
  });
  const initial = render(component).body;
  assert.doesNotMatch(initial, /aria-label="Compose target"/);
  assert.match(initial, /aria-pressed="true"[^>]*aria-label="Toggle conversation view"/);
  assert.equal(inputs.at(-1)!.composeTarget, 'conversation');
  const mixed = render(component, { props: { terminalSelected: true } }).body;
  assert.match(mixed, /aria-label="Compose target"/);
  assert.match(mixed, /💬 Conversation/);
  assert.match(mixed, /⌨️ Terminal/);
  assert.doesNotMatch(mixed, /💭 Unvoiced thought/);
  assert.match(mixed, /aria-pressed="true"[^>]*aria-label="Toggle terminal view"/);
});

test('read-only input preserves its draft and disables sending without altering normal input', async () => {
  const { render } = await import('svelte/server');
  const component = renderedComponent('./chat/InputArea.svelte', {
    svelte: { onDestroy() {}, createEventDispatcher: () => () => {} },
    './FeedbackButtons.svelte': { default() {} },
  });
  const readOnly = render(component, { props: { input: 'preserved draft', readOnly: true, composeTarget: null } }).body;
  assert.match(readOnly, /<textarea[^>]*disabled/);
  assert.match(readOnly, /preserved draft/);
  assert.match(readOnly.match(/<button\b[^>]*class="send-btn\b[^"]*"[^>]*>/)![0], /disabled/);
  const normal = render(component, { props: { input: 'ready to send', composeTarget: 'conversation' } }).body;
  assert.doesNotMatch(normal.match(/<textarea\b[^>]*>/)![0], /disabled/);
  assert.doesNotMatch(normal.match(/<button\b[^>]*class="send-btn\b[^"]*"[^>]*>/)![0], /disabled/);
});

test('Body connection UI distinguishes a connected computer speaker from a disconnected robot', async () => {
  const { render } = await import('svelte/server');
  const component = renderedComponent('./BodyConnectionSelector.svelte', {});
  const agents = [{ id: 'environment-bridge', variables: [] }];
  const connection = { endpoint: 'ws://fixture/environment', adapterConnected: true, connected: false, active: true, ready: true };
  const html = render(component, { props: { agents, connections: [connection] } }).body;
  assert.match(html, /Body Control: connected/);
  assert.match(html, /Robot: disconnected/);
  assert.match(html, /Bridge: ready/);
  const unavailable = render(component, { props: { agents, connections: [{ ...connection,
    adapterConnected: false, active: false, ready: false, error: 'Connection refused' }] } }).body;
  assert.match(unavailable, /Body Control: disconnected/);
  assert.match(unavailable, /Bridge: not selected/);
  assert.match(unavailable, /Connection refused/);
});
