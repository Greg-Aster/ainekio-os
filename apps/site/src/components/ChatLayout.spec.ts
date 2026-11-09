import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { get, writable } from 'svelte/store';
import { calculateVoiceVolume } from '../lib/client/utils/audio-utils.js';

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
  const statusStore = writable<{ data: unknown; error: string | null; receivedAt?: number } | null>(null);
  const requests: string[] = [];
  let finishStatus!: (response: Response) => void;
  let mounted!: () => () => void;
  let failStatus = false;
  const state = vm.createContext({
    statusRead: undefined, modeRead: undefined, systemRead: undefined, closed: false, AbortController, statusStore, statusRefreshTrigger: writable(4), rightSidebarStore: writable(false),
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
    modeLoading: false, modeSaving: false, cognitiveModes: [], modeError: '',
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
  assert.deepEqual(get(statusStore)?.data, status);
  unmount();
  const requestCount = requests.length;
  state.window.dispatchEvent(new Event('focus'));
  state.document.dispatchEvent(new Event('visibilitychange'));
  state.statusRefreshTrigger.update((value: number) => value + 1);
  assert.equal(requests.length, requestCount, 'destroyed layout releases its refresh listeners');

  failStatus = true;
  await state.loadStatus();
  assert.deepEqual(get(statusStore)?.data, status, 'a failed refresh must retain the last server snapshot');
  assert.match(get(statusStore)?.error ?? '', /Failed to load portal status/);
  failStatus = false;
  const refresh = state.loadStatus();
  finishStatus(new Response(JSON.stringify({ identity: { name: 'Updated fixture' } })));
  await refresh;
  assert.deepEqual(get(statusStore)?.data, { identity: { name: 'Updated fixture' } });
  assert.equal(get(statusStore)?.error, null);
  const lastGood = get(statusStore)?.data;
  const cleanupAgain = mounted();
  cleanupAgain();
  finishStatus(Response.json({ identity: { name: 'Old request after destruction' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(get(statusStore)?.data, lastGood, 'a destroyed status reader cannot overwrite the shared snapshot');
});

test('both page shells restore the saved theme, fall back to OS preference, and allow storage denial', () => {
  const init = read('./ThemeInit.astro').match(/<script is:inline>([\s\S]*?)<\/script>/)![1];
  for (const shell of ['../pages/index.astro', '../layouts/PageLayout.astro']) {
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

test('sidebar persists the current YOLO store value when trust resets it and preserves other preferences', async () => {
  const yolo = writable(true);
  const stored = new Map([['chatPrefs', JSON.stringify({ yoloMode: true, fontSize: 18 })]]);
  const ui = editorFixture('LeftSidebar', async url => {
    assert.equal(url, '/api/trust'); return Response.json({ level: 'observe', available: ['observe'] });
  }, {
    MODEL_ROLE_OPTIONS: [], get, yoloModeStore: yolo, $isOwner: true, yoloMode: true,
    localStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) },
  });
  await ui.run('loadTrustOptions()');
  assert.equal(get(yolo), false);
  assert.deepEqual(JSON.parse(stored.get('chatPrefs')!), { yoloMode: false, fontSize: 18 });
  yolo.set(true); ui.run('saveChatPrefs()');
  assert.equal(JSON.parse(stored.get('chatPrefs')!).yoloMode, true);
});

test('sidebar reports an unread shared status failure and releases its existing subscription', () => {
  const status = writable<any>(null);
  const ui = editorFixture('LeftSidebar', async () => { throw new Error('Status must come from the shared owner'); }, {
    MODEL_ROLE_OPTIONS: [], statusStore: status,
  });
  const unsubscribe = ui.run('subscribeStatus()');
  assert.equal(ui.run('loading'), true);
  status.set({ data: null, error: 'Fixture status unavailable' });
  assert.equal(ui.run('loading'), false); assert.equal(ui.run('statusError'), 'Fixture status unavailable');
  status.set({ data: { identity: { name: 'Received persona' } }, error: null });
  assert.equal(ui.run('statusError'), ''); assert.equal(ui.run('identity.name'), 'Received persona');
  unsubscribe(); status.set({ data: { identity: { name: 'After closure' } }, error: null });
  assert.equal(ui.run('identity.name'), 'Received persona'); assert.equal(ui.requests.length, 0);
});

test('persona facet write failure preserves the received facet and permits a successful retry', async () => {
  let fail = true; const refresh = writable(0);
  const ui = editorFixture('LeftSidebar', async () => fail
    ? Response.json({ error: 'Fixture facet write refused' }, { status: 503 })
    : Response.json({ success: true, activeFacet: 'second' }), {
    MODEL_ROLE_OPTIONS: [], statusRefreshTrigger: refresh,
  });
  ui.run("activeFacet = 'first'; facets = { first: { enabled: true }, second: { enabled: true } }");
  await ui.run('cyclePersonaFacet()');
  assert.equal(ui.run('activeFacet'), 'first'); assert.equal(ui.run('personaFacetWriteError'), 'Fixture facet write refused');
  assert.equal(get(refresh), 0);
  fail = false; await ui.run('cyclePersonaFacet()');
  assert.equal(ui.run('activeFacet'), 'second'); assert.equal(ui.run('personaFacetWriteError'), '');
  assert.equal(get(refresh), 1);
});

test('sidebar keeps registered and status-discovered remote choices under their existing data owners', () => {
  const { render } = componentRequire('svelte/server');
  const registered = { id: 'registered', provider: 'remote-server', model: 'Registered remote' };
  const discovered = { id: 'remote-server:discovered', provider: 'remote-server', model: 'Discovered remote' };
  const status = writable<any>({ data: { systemHealth: { cloudModels: [discovered] } } });
  const screen = renderedComponent('./ServerStatus.svelte', {
    '../stores/navigation': { statusStore: status, activeView: writable('chat'), systemSection: writable('settings'), statusRefreshTrigger: writable(0), graphEditorHref: () => '?workspace=graph-editor' },
    '../stores/security-policy': { currentMode: writable('dual'), isOwner: writable(true) },
    '../lib/client/api-config': { apiFetch() { throw new Error('Rendering must not fetch'); } },
    '../lib/client/model-role-presentation': componentRequire('../lib/client/model-role-presentation.ts'),
  }, {}, {
    loading: false, hasModelRegistry: true,
    modelRoles: { persona: { modelId: 'registered' } }, roleAssignments: { persona: 'registered' },
    availableModels: [registered], modelCategories: { local: [], remote: [registered], bigBrother: [] },
  });
  let html = render(screen).body;
  assert.match(html, /Registered remote/); assert.match(html, /Discovered remote/);
  status.set({ data: { systemHealth: { cloudModels: [] } } });
  html = render(screen).body;
  assert.match(html, /Registered remote/); assert.doesNotMatch(html, /Discovered remote/);
});

test('logout retains local authentication on HTTP failure and clears it only after HTTP acknowledgement', async () => {
  const user = writable<any>({ username: 'fixture' }); const status = writable<any>({ data: { identity: 'fixture' } });
  let fail = true; let cleared = 0;
  const browser = { location: { href: '/active' } };
  const ui = editorFixture('ChatLayout', async () => fail
    ? Response.json({ error: 'Fixture logout unavailable' }, { status: 503 }) : Response.json({ success: true }), {
    currentUserStore: user, statusStore: status, clearSecurityPolicy: () => cleared++, window: browser,
  });
  await ui.run('handleLogout()');
  assert.equal(get(user).username, 'fixture'); assert.ok(get(status)); assert.equal(cleared, 0);
  assert.equal(browser.location.href, '/active'); assert.equal(ui.run('logoutError'), 'Fixture logout unavailable');
  fail = false; await ui.run('handleLogout()');
  assert.equal(get(user), null); assert.equal(get(status), null); assert.equal(cleared, 1);
  assert.equal(browser.location.href, '/'); assert.equal(ui.run('logoutError'), '');
});

test('layout metadata readers discard older and closed replies while keeping received system constraints on failure', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = editorFixture('ChatLayout', () => new Promise(resolve => finishes.push(resolve)));
  const older = ui.run('loadCognitiveModeState()'); const newer = ui.run('loadCognitiveModeState()');
  finishes[1](Response.json({ modes: [{ id: 'environment' }] })); await newer;
  finishes[0](Response.json({ modes: [{ id: 'dual' }] })); await older;
  assert.equal(ui.run('cognitiveModes[0].id'), 'environment'); assert.equal(ui.requests[0].options?.signal?.aborted, true);
  const original = ui.run('fetchSystemStatus()'); const latest = ui.run('fetchSystemStatus()');
  finishes[3](Response.json({ success: true, status: 'high_security', allowedModes: ['emulation'] })); await latest;
  finishes[2](Response.json({ success: true, allowedModes: ['dual'] })); await original;
  assert.equal(ui.run('allowedModes[0]'), 'emulation');
  const failed = ui.run('fetchSystemStatus()');
  finishes[4](Response.json({ error: 'Fixture status unavailable' }, { status: 503 })); await failed;
  assert.equal(ui.run('systemStatus.status'), 'high_security'); assert.equal(ui.run('systemStatusError'), 'Fixture status unavailable');
  const closing = ui.run('loadCognitiveModeState()');
  ui.run('closed = true; modeRead.abort(); systemRead?.abort()');
  finishes[5](Response.json({ modes: [{ id: 'after-close' }] })); await closing;
  assert.equal(ui.run('cognitiveModes[0].id'), 'environment');
});

test('an overlapping cognitive-mode read cannot release the pending mode write', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = editorFixture('ChatLayout', () => new Promise(resolve => finishes.push(resolve)), {
    fetchSecurityPolicy: async () => {}, statusRefreshTrigger: writable(0),
  });
  const writing = ui.run("changeCognitiveMode('agent')");
  const reading = ui.run('loadCognitiveModeState()');
  finishes[1](Response.json({ modes: [{ id: 'dual' }] })); await reading;
  assert.equal(ui.run('modeLoading'), true); assert.equal(ui.run('modeSaving'), true);
  assert.equal(ui.requests[0].options?.signal, undefined);
  finishes[0](Response.json({ success: true })); await new Promise(resolve => setImmediate(resolve));
  finishes[2](Response.json({ modes: [{ id: 'agent' }] })); await writing;
  assert.equal(ui.run('modeSaving'), false); assert.equal(ui.run('modeLoading'), false);
  const closingWrite = ui.run("changeCognitiveMode('dual')");
  ui.run('closed = true');
  finishes[3](Response.json({ success: true })); await closingWrite;
  assert.equal(ui.requests.length, 4, 'a sent mode write finishes without starting observations for the closed layout');
  assert.equal(ui.run('modeSaving'), false);
  const denied = ui.run("closed = false; changeCognitiveMode('dual')");
  finishes[4](Response.json({ error: 'Owner permission required' }, { status: 403 })); await denied;
  assert.equal(ui.run('modeError'), 'Owner permission required');
});

test('Flow Editor import failure stays visible without repeated reactive loading', async () => {
  const source = ts.createSourceFile('layout.ts', read('./ChatLayout.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const loader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadFlowEditor')!;
  const trigger = source.statements.find(node => ts.isLabeledStatement(node) && node.getText(source).includes('$nodeEditorMode'))!;
  let attempts = 0;
  const context = vm.createContext({ flowEditorLoading: false, flowEditorError: '', FlowEditorLayoutComponent: null, $nodeEditorMode: true,
    loadModule: async () => { attempts++; throw new Error('Fixture editor chunk unavailable'); },
  });
  vm.runInContext(transpile(loader.getText(source).replace("import('./flow-editor/FlowEditorLayout.svelte')", 'loadModule()')), context);
  await context.loadFlowEditor();
  assert.equal(context.flowEditorError, 'Fixture editor chunk unavailable'); assert.equal(context.flowEditorLoading, false);
  for (let n = 0; n < 3; n++) vm.runInContext(transpile(trigger.getText(source)), context);
  assert.equal(attempts, 1);
});

test('sidebar reader replacement and unmount release facets, registry and remote health without cancelling writes', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const status = writable<any>(null);
  const refresh = writable(0);
  const leftUi = editorFixture('LeftSidebar', () => new Promise(resolve => finishes.push(resolve)), {
    currentMode: writable('dual'), statusStore: status, $isOwner: false,
    statusRefreshTrigger: refresh,
  });
  const firstFacet = leftUi.run('loadFacets()'); const lastFacet = leftUi.run('loadFacets()');
  finishes[1](Response.json({ activeFacet: 'current', facets: { current: { enabled: true } } })); await lastFacet;
  finishes[0](Response.json({ activeFacet: 'old', facets: { old: {} } })); await firstFacet;
  assert.equal(leftUi.run('activeFacet'), 'current');
  leftUi.mount(); leftUi.unmount();
  assert.equal(leftUi.requests.at(-1)?.options?.signal?.aborted, true);
  const leftCount = leftUi.requests.length;
  await leftUi.run('loadFacets()');
  assert.equal(leftUi.requests.length, leftCount);

  const serverFinishes: Array<(response: Response) => void> = [];
  const ui = editorFixture('ServerStatus', () => new Promise(resolve => serverFinishes.push(resolve)), {
    MODEL_ROLE_OPTIONS: [], currentMode: writable('dual'), statusStore: status, $isOwner: false,
    statusRefreshTrigger: refresh, modelRoleSections: [], discoveredModels: [],
    getRemoteSyncConfig: async () => ({ configured: false }),
    document: Object.assign(new EventTarget(), { hidden: false }),
  });
  const firstRegistry = ui.run('loadModelRegistry()'); const lastRegistry = ui.run('loadModelRegistry()');
  serverFinishes[1](Response.json({ success: true, availableModels: [], roleAssignments: { persona: 'current' } })); await lastRegistry;
  serverFinishes[0](Response.json({ success: true, availableModels: [], roleAssignments: { persona: 'old' } })); await firstRegistry;
  assert.equal(ui.run('roleAssignments.persona'), 'current');
  ui.run("backendAvailability.remoteServer = { configured: true, serverUrl: 'https://old.example' }");
  const firstHealth = ui.run('checkRemoteServerConnection()');
  ui.run("backendAvailability.remoteServer.serverUrl = 'https://current.example'");
  const lastHealth = ui.run('checkRemoteServerConnection()');
  serverFinishes[3](Response.json({ healthy: true })); await lastHealth;
  serverFinishes[2](Response.json({ healthy: false })); await firstHealth;
  assert.equal(ui.run('backendAvailability.remoteServer.connected'), true);
  assert.match(ui.requests[3].url, /serverUrl=https%3A%2F%2Fcurrent.example/);
  const failedHealth = ui.run('checkRemoteServerConnection()');
  serverFinishes[4](Response.json({ error: 'Fixture health unavailable' }, { status: 503 })); await failedHealth;
  assert.match(ui.run('getRemoteServerTooltip(backendAvailability.remoteServer, remoteHealthLoading, remoteHealthError, modelCategories.remote)'), /Unreachable.*Fixture health unavailable/);
  const writing = ui.run("assignModelToRole('persona', 'submitted')");
  assert.equal(ui.requests[5].options?.signal, undefined, 'the already sent write is not tied to a view reader');
  ui.mount(); ui.unmount();
  assert.equal(ui.requests.at(-1)?.options?.signal?.aborted, true);
  serverFinishes[5](Response.json({ success: true })); await writing;
  assert.equal(get(refresh), 1, 'the write acknowledgement still reaches the existing shared refresh owner');
  const count = ui.requests.length;
  await ui.run('loadModelRegistry(); checkRemoteServerConnection()');
  assert.equal(ui.requests.length, count);
  for (const finish of serverFinishes.slice(6)) finish(Response.json({ success: true, availableModels: [] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(leftUi.run('activeFacet'), 'current'); assert.equal(ui.run('roleAssignments.persona'), 'current');
});

test('Network settings use measured health, consolidate tunnel actions and acknowledge the saved boot flag', async () => {
  const browser = Object.assign(new EventTarget(), { location: { origin: 'http://fixture.local' } });
  const status = writable({ data: { runtime: { headless: false, changedAt: 'old', lastChangedBy: 'local' } } });
  const refresh = writable(0);
  let healthChecks = 0;
  let failTunnel = false;
  const ui = editorFixture('NetworkServerSettings', async (url, options) => {
    if (url === '/api/server-info') return Response.json({ success: true, server: { hostname: 'fixture' } });
    if (url === '/api/cloudflare/status') return Response.json({ installed: true, running: true, enabled: true });
    if (url === '/api/runtime/mode') return Response.json({ success: true, mode: { headless: true, changedAt: 'new', lastChangedBy: 'local' } });
    assert.equal(options?.method, 'POST');
    return failTunnel ? Response.json({ error: 'Fixture tunnel failure' }, { status: 500 }) : Response.json({ success: true });
  }, {
    statusStore: status, statusRefreshTrigger: refresh, healthStatus: writable({ connected: false }), getApiBaseUrl: () => '',
    isMobileApp: () => false, window: browser, clearTimeout() {},
    forceHealthCheck: async () => { healthChecks++; },
    setInterval() { throw new Error('Network settings must not start another polling loop'); },
  });
  ui.mount(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.run('currentServerUrl'), 'http://fixture.local');
  assert.deepEqual(ui.requests.map(request => request.url), ['/api/cloudflare/status', '/api/server-info']);
  assert.equal(healthChecks, 0, 'the existing monitor supplies connection state');
  await ui.run('testCurrentConnection()'); assert.equal(healthChecks, 1);
  for (const action of ['start', 'stop', 'toggle']) await ui.run(`changeTunnel('${action}', true)`);
  assert.deepEqual(ui.requests.filter(request => request.options?.method === 'POST').map(request => request.url),
    ['/api/cloudflare/start', '/api/cloudflare/stop', '/api/cloudflare/toggle']);
  failTunnel = true; await ui.run("changeTunnel('start')");
  assert.equal(ui.run('error'), 'Fixture tunnel failure'); assert.equal(ui.run('successMessage'), null);
  await ui.run('toggleHeadlessMode(true)');
  assert.equal(get(status).data.runtime.headless, true);
  assert.equal(get(refresh), 1, 'the existing status owner cancels any older portal read and refreshes its snapshot');
  assert.match(ui.run('successMessage'), /next system start/);
  assert.doesNotMatch(ui.run('successMessage'), /pause|resume/);
  browser.dispatchEvent(new Event('focus')); await new Promise(resolve => setImmediate(resolve));
  const count = ui.requests.length;
  ui.unmount(); browser.dispatchEvent(new Event('focus'));
  assert.equal(ui.requests.length, count);
  assert.equal(ui.requests.at(-1)?.options?.signal?.aborted, true);
});

test('Network settings discard superseded and closed reads and expose read failures', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = editorFixture('NetworkServerSettings', () => new Promise(resolve => finishes.push(resolve)), {
    statusStore: writable(null), healthStatus: writable({ connected: false }), clearTimeout() {},
    isMobileApp: () => false, getApiBaseUrl: () => '', window: { location: { origin: 'http://fixture.local' }, addEventListener() {}, removeEventListener() {} },
  });
  ui.run('isMobile = true');
  const first = ui.run('refreshSettings()'); const second = ui.run('loadTunnelStatus(settingsRead.signal)');
  finishes[1](Response.json({ hostname: 'new' })); await second;
  finishes[0](Response.json({ hostname: 'old' })); await first;
  assert.equal(ui.run('tunnelStatus.hostname'), 'new');
  assert.equal(ui.requests[0].options?.signal?.aborted, true);
  const failure = ui.run('refreshSettings()');
  finishes[2](Response.json({ error: 'Fixture status unavailable' }, { status: 503 })); await failure;
  assert.equal(ui.run('error'), 'Fixture status unavailable'); assert.equal(ui.run('tunnelStatus.hostname'), 'new');
  ui.mount(); ui.unmount();
  for (const finish of finishes.slice(3)) finish(Response.json({ success: true, server: { hostname: 'closed' }, hostname: 'closed' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.run('tunnelStatus.hostname'), 'new'); assert.equal(ui.run('localServerInfo'), null);
  const { render } = componentRequire('svelte/server');
  const health = writable({ connected: false, consecutiveFailures: 0, error: undefined as string | undefined });
  const screen = renderedComponent('./NetworkServerSettings.svelte', {
    '../lib/client/api-config': {}, '../lib/client/server-health': { healthStatus: health },
    '../stores/navigation': { statusStore: writable(null) },
    './SyncStatus.svelte': { default() {} }, './UpdateManager.svelte': { default() {} },
  }, {}, { loading: false, error: 'Fixture server read failed' });
  let html = render(screen).body;
  assert.match(html, /Not checked/); assert.doesNotMatch(html, /Disconnected/);
  assert.match(html, /Server addresses are unavailable/); assert.match(html, /Retry server addresses/);
  assert.match(html, /Fixture server read failed/); assert.doesNotMatch(html, /http:\/\/192\.168\.x\.x:4321/);
  health.set({ connected: false, consecutiveFailures: 1, error: 'Connection refused' });
  html = render(screen).body; assert.match(html, /Disconnected/); assert.match(html, /Connection refused/);
});

test('Headless banner shares runtime status and opens its sole settings owner without claiming resources', () => {
  const { render } = componentRequire('svelte/server');
  const status = writable({ data: { runtime: { headless: true } } });
  const active = writable('chat'); const section = writable('settings');
  const dependencies = {
    '../lib/client/api-config': { isMobileApp: () => false },
    '../stores/navigation': { statusStore: status, activeView: active, systemSection: section },
  };
  const screen = renderedComponent('./HeadlessClaimBanner.svelte', dependencies);
  let html = render(screen).body;
  assert.match(html, /Open Network Settings/); assert.match(html, /does not stop or resume/);
  assert.doesNotMatch(html, /Claim Runtime|Local agents are paused|dedicate all resources/);
  status.set({ data: { runtime: { headless: false } } });
  assert.doesNotMatch(render(screen).body, /Headless Mode Active/);
  const ui = editorFixture('HeadlessClaimBanner', async () => { throw new Error('Banner must not read or mutate another copy'); }, {
    isMobileApp: () => false, statusStore: status, activeView: active, systemSection: section,
  });
  ui.run('openNetworkSettings()');
  assert.equal(get(active), 'system'); assert.equal(get(section), 'network'); assert.equal(ui.run('dismissed'), true);
  html = render(renderedComponent('./HeadlessClaimBanner.svelte', {
    ...dependencies, '../lib/client/api-config': { isMobileApp: () => true },
  })).body;
  assert.doesNotMatch(html, /Headless Mode Active/);
});

test('server restart requires its Core acknowledgement instead of treating a fetch failure as success', async () => {
  const source = ts.createSourceFile('app-updater.ts', read('../lib/client/app-updater.ts'), ts.ScriptTarget.Latest, true);
  let response: Response | Error = new TypeError('Failed to fetch');
  const requests: string[] = [];
  const context = vm.createContext({ Error, TypeError, console, writable, derived: componentRequire('svelte/store').derived,
    isMobileApp: () => false, apiFetch: async (url: string, options: RequestInit) => {
      requests.push(url); assert.equal(options.method, 'POST');
      if (response instanceof Error) throw response;
      return response;
    },
  });
  vm.runInContext(transpile(source.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(source).replace(/^export\s+/, '')).join('\n')), context);
  await assert.rejects(context.restartServer(), /Failed to fetch/);
  response = Response.json({ error: 'Owner permission required' }, { status: 403 });
  await assert.rejects(context.restartServer(), /Owner permission required/);
  response = Response.json({ success: true }); await context.restartServer();
  assert.deepEqual(requests, Array(3).fill('/api/server-update/restart'));
});

test('Update Manager releases a failed restart request and reports only an acknowledged request', async () => {
  let fail = true;
  const ui = editorFixture('UpdateManager', async () => { throw new Error('Component must reuse its updater'); }, {
    restartServer: async () => { if (fail) throw new TypeError('Failed to fetch'); },
  });
  await ui.run('handleRestart()');
  assert.equal(ui.run('restarting'), false); assert.equal(ui.run('restartRequested'), false);
  assert.equal(ui.run('restartError'), 'Failed to fetch');
  fail = false; await ui.run('handleRestart()');
  assert.equal(ui.run('restarting'), false); assert.equal(ui.run('restartRequested'), true);
  assert.equal(ui.run('restartError'), null);
  const { render } = componentRequire('svelte/server');
  const updates = writable<any>({ platform: 'mobile', currentVersion: '1.0', currentVersionCode: 1,
    latestMobileVersion: { version: '2.0', fileSize: 1024 }, updateAvailable: true });
  const screen = renderedComponent('./UpdateManager.svelte', {
    '../lib/client/app-updater': { updateState: updates, formatFileSize: () => '1 KB' },
  });
  let html = render(screen).body;
  assert.match(html, /Installed version 1.0 \(build 1\)/); assert.match(html, /Download Signed APK/);
  updates.set({ platform: 'server', restartRequired: true, updateAvailable: true,
    serverUpdateInfo: { currentVersion: 'fixture', commitsBehind: 2, canUpdate: false,
      reason: 'Local changes detected', changesSummary: ['Fixture upstream change'] } });
  html = render(screen).body;
  assert.match(html, /2 update commits available/); assert.match(html, /Local changes detected/);
  assert.match(html, /Fixture upstream change/); assert.doesNotMatch(html, /Install and Build Update/);
  const requested = renderedComponent('./UpdateManager.svelte', {
    '../lib/client/app-updater': { updateState: updates },
  }, {}, { restartRequested: true });
  assert.match(render(requested).body, /Restart requested — reload when available/);
});

test('Sync Status opens only the canonical manager and does not initialize the retired browser replica', () => {
  const { render } = componentRequire('svelte/server');
  let managers = 0;
  const screen = renderedComponent('./SyncStatus.svelte', {
    '../lib/client/profile-sync': { getRemoteSyncConfig() { throw new Error('SSR must not read configuration'); } },
    './SyncManager.svelte': { default() { managers++; } },
  });
  let html = render(screen, { props: { compact: true } }).body;
  assert.match(html, /Open Profile Sync/); assert.doesNotMatch(html, /Synced|pending|conflict/);
  assert.equal(managers, 0, 'a hidden modal must not start another configuration reader');
  html = render(screen).body;
  assert.match(html, /Loading sync configuration/); assert.match(html, /Open Sync Manager/);
  assert.equal(managers, 0);
});

test('User Guide renders index retry and chapter failure without concealing the received chapter', () => {
  const { render } = componentRequire('svelte/server');
  const dependencies = { '../lib/client/api-config': { apiFetch() { throw new Error('SSR must not load the guide'); } } };
  let screen = renderedComponent('./UserGuide.svelte', dependencies, {}, { loading: false, error: 'Fixture index unavailable' });
  let html = render(screen).body;
  assert.match(html, /Fixture index unavailable/); assert.match(html, /Retry loading user guide/);
  screen = renderedComponent('./UserGuide.svelte', dependencies, {}, {
    loading: false, chapterError: 'Fixture chapter unavailable', selectedChapterId: 'missing',
    currentChapter: { id: 'received', content: '<h1>Received chapter</h1>' },
  });
  html = render(screen).body;
  assert.match(html, /Fixture chapter unavailable/); assert.match(html, /Retry chapter/);
  assert.match(html, /<h1>Received chapter<\/h1>/);
});

test('Sync Manager reports configuration, preference and request failures through its existing actions', async () => {
  const ui = editorFixture('SyncManager', async () => { throw new Error('Unexpected alternate HTTP path'); }, {
    getRemoteSyncConfig: async () => { throw new Error('Fixture config read failed'); },
    getSyncSettings: async () => { throw new Error('Fixture preferences read failed'); },
    updateSyncSettings: async () => { throw new Error('Fixture preferences write failed'); },
    clearRemoteSyncConfig: async () => { throw new Error('Fixture disconnect failed'); },
    runProfileSyncAgent: async () => { throw new Error('Fixture admission failed'); },
  });
  await ui.run('loadServerConfig()'); await ui.run('loadSyncSettings()');
  assert.equal(ui.run('configError'), 'Fixture config read failed');
  assert.equal(ui.run('settingsError'), 'Fixture preferences read failed');
  ui.run('syncSettingsData = { syncOnLogin: true }'); await ui.run('handleSaveSyncSettings()');
  assert.equal(ui.run('settingsError'), 'Fixture preferences write failed');
  await ui.run('handleClearConfig()'); assert.equal(ui.run('configError'), 'Fixture disconnect failed');
  await ui.run('handleRemoteSync()');
  assert.equal(ui.run('showSyncComplete'), true);
  assert.equal(ui.run('syncResult.error'), 'Fixture admission failed');
});

test('Sync Manager releases configuration and job observation on unmount without another admission', async () => {
  let finishConfig!: (config: unknown) => void;
  let finishPreferences!: (settings: unknown) => void;
  let readSignal: AbortSignal | undefined;
  let runSignal: AbortSignal | undefined;
  let admissions = 0;
  const ui = editorFixture('SyncManager', async () => { throw new Error('Unexpected alternate HTTP path'); }, {
    getRemoteSyncConfig: (options?: { signal?: AbortSignal }) => {
      readSignal = options?.signal;
      return new Promise(resolve => { finishConfig = resolve; });
    },
    getSyncSettings: () => new Promise(resolve => { finishPreferences = resolve; }),
    runProfileSyncAgent: async (_args: string[], _progress: unknown, options?: { signal?: AbortSignal }) => {
      admissions++; runSignal = options?.signal;
      return new Promise(resolve => runSignal?.addEventListener('abort', () => resolve({ success: false, error: 'Stopped observing' })));
    },
  });
  ui.mount(); const running = ui.run('handleRemoteSync()'); ui.unmount();
  assert.equal(readSignal?.aborted, true); assert.equal(runSignal?.aborted, true);
  finishConfig({ configured: true, serverUrl: 'https://obsolete.example' }); finishPreferences({ syncOnLogin: true });
  await new Promise(resolve => setImmediate(resolve));
  // The existing run owner may refresh its config after a receipt; release that
  // observation too, without executing the admitted job a second time.
  finishConfig({ configured: true }); await running;
  assert.equal(ui.run('isServerConfigured'), false); assert.equal(ui.run('syncSettingsData'), null);
  assert.equal(admissions, 1);
});

test('Sync Manager keeps selected Profile Sync arguments and displays the actual task receipt', async () => {
  const admissions: string[][] = [];
  const ui = editorFixture('SyncManager', async () => { throw new Error('Unexpected alternate HTTP path'); }, {
    getRemoteSyncConfig: async () => ({ configured: true, serverUrl: 'https://fixture.example', username: 'fixture' }),
    runProfileSyncAgent: async (args: string[]) => { admissions.push([...args]); return { success: true, taskId: 'fixture-sync-task' }; },
  });
  await ui.run('handleRemoteSync()');
  assert.deepEqual(admissions[0], ['--memories-only', '--skip-persona', '--skip-config', '--days=7']);
  ui.run('selectAll(); memoryDays = 0'); await ui.run('handleRemoteSync()');
  assert.deepEqual(admissions[1], []);
  const { render } = componentRequire('svelte/server');
  const screen = renderedComponent('./SyncManager.svelte', {
    '../lib/client/profile-sync': {}, '../lib/client/sync-settings': {},
  }, {}, { showSyncComplete: true, syncResult: { success: true, taskId: 'fixture-sync-task' },
    configError: 'Fixture config read failed', settingsError: 'Fixture preferences read failed' });
  const html = render(screen, { props: { isOpen: true } }).body;
  assert.match(html, /fixture-sync-task/);
  assert.match(html, /Fixture config read failed/); assert.match(html, /Fixture preferences read failed/);
  assert.doesNotMatch(html, /Connection verified|Your local profile is now synchronized/);
});

function editorFixture(name: string, fetcher: (url: string, options?: RequestInit) => Promise<Response>, dependencies: Record<string, unknown> = {}) {
  const component = read(`./${name}.svelte`);
  const source = ts.createSourceFile(`${name}.ts`, component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const cleanup: (() => void)[] = [];
  const events: { name: string; detail: unknown }[] = [];
  const requests: { url: string; options?: RequestInit }[] = [];
  let mounted!: () => unknown;
  const context = vm.createContext({ AbortController, AbortSignal, Error, console, confirm: () => true,
    createEventDispatcher: () => (name: string, detail: unknown) => events.push({ name, detail }),
    onMount: (callback: typeof mounted) => { mounted = callback; }, onDestroy: (callback: () => void) => cleanup.push(callback),
    apiFetch: (url: string, options?: RequestInit) => { requests.push({ url, options }); return fetcher(url, options); },
    ...dependencies,
  });
  vm.runInContext(transpile(source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isLabeledStatement(node))
    .map(node => node.getText(source).replace(/^export\s+/, '')).join('\n')), context);
  return { requests, events, run: (code: string) => vm.runInContext(code, context),
    dirty() {
      const statement = source.statements.find(node => ts.isLabeledStatement(node) && node.getText(source).includes('isDirty ='))!;
      vm.runInContext(transpile(statement.getText(source)), context);
      return vm.runInContext('isDirty', context);
    },
    mount() { const result = mounted(); if (typeof result === 'function') cleanup.push(result as () => void); },
    unmount() { cleanup.splice(0).forEach(close => close()); } };
}

test('Memory Editor acknowledges submitted text while retaining newer edits and failed-save drafts', async () => {
  let finish!: (response: Response) => void;
  const ui = editorFixture('MemoryEditor', async (_url, options) => options?.method === 'PUT'
    ? new Promise(resolve => { finish = resolve; }) : new Response(JSON.stringify({ success: true, content: 'original' })));
  ui.run("isOpen = true; relPath = 'profile:memory/one.json'");
  await ui.run('loadContent()');
  ui.run("content = 'submitted'"); ui.dirty();
  const saving = ui.run('saveContent()');
  ui.run("content = 'newer draft'");
  finish(new Response('{"success":true}')); await saving;
  assert.equal(ui.dirty(), true, 'text typed during a write has not been saved');
  assert.equal(ui.run('content'), 'newer draft');
  assert.deepEqual(JSON.parse(String(ui.requests[1].options?.body)), { relPath: 'profile:memory/one.json', content: 'submitted' });
  const failing = ui.run('saveContent()');
  finish(new Response('{"success":false,"error":"Fixture write failed"}', { status: 500 })); await failing;
  assert.equal(ui.dirty(), true); assert.equal(ui.run('error'), 'Fixture write failed');
});

test('Memory Editor releases superseded and closed reads without replacing another file', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = editorFixture('MemoryEditor', async () => new Promise(resolve => finishes.push(resolve)));
  ui.run("isOpen = true; relPath = 'profile:one'"); const first = ui.run('loadContent()');
  ui.run("relPath = 'profile:two'"); const second = ui.run('loadContent()');
  finishes[1](new Response('{"success":true,"content":"second file"}')); await second;
  finishes[0](new Response('{"success":true,"content":"obsolete first file"}')); await first;
  assert.equal(ui.run('content'), 'second file');
  assert.equal(ui.requests[0].options?.signal?.aborted, true);
  ui.run("relPath = 'profile:three'"); const closing = ui.run('loadContent()');
  ui.run('close()');
  finishes[2](new Response('{"success":true,"content":"closed file"}')); await closing;
  assert.equal(ui.run('content'), ''); assert.equal(ui.requests[2].options?.signal?.aborted, true);
  ui.unmount();
});

test('Memory Editor reports the written file when an earlier save completes after changing files', async () => {
  let finish!: (response: Response) => void;
  const ui = editorFixture('MemoryEditor', async (_url, options) => options?.method === 'PUT'
    ? new Promise(resolve => { finish = resolve; }) : new Response('{"success":true,"content":"original"}'));
  ui.run("isOpen = true; relPath = 'profile:one'"); await ui.run('loadContent()');
  ui.run("content = 'submitted'"); ui.dirty(); const saving = ui.run('saveContent()');
  ui.run("relPath = 'profile:two'"); await ui.run('loadContent()'); ui.run("content = 'second draft'");
  finish(new Response('{"success":true}')); await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(ui.events.at(-1))), { name: 'saved', detail: { relPath: 'profile:one' } });
  assert.equal(ui.run('content'), 'second draft'); assert.equal(ui.dirty(), true);
});

test('Mood Editor retains fields edited during save while applying normalized values and current metadata', async () => {
  const initial = { success: true, settings: { bufferSource: 'conversation', maxMessagesPerBuffer: 20, maxContextChars: 8000,
    baselineFacet: 'default', overridePersonaDisabled: false, minimumConfidence: 0.5 }, state: {},
    trigger: { enabled: true, eventCountThreshold: 10, idleResetSeconds: 1800, eventPattern: 'conversation.*' },
    facets: {}, activeFacet: 'default' };
  let finish!: (response: Response) => void;
  const ui = editorFixture('MoodAgentSettings', async (_url, options) => options?.method === 'PUT'
    ? new Promise(resolve => { finish = resolve; }) : new Response(JSON.stringify(initial)));
  await ui.run('load()');
  ui.run('data.settings.minimumConfidence = 0.8'); const saving = ui.run('save()');
  ui.run('data.settings.minimumConfidence = 0.9; data.trigger.eventCountThreshold = 25');
  finish(new Response(JSON.stringify({ ...initial, activeFacet: 'calm', settings: { ...initial.settings, minimumConfidence: 0.8, maxMessagesPerBuffer: 15 } })));
  await saving;
  assert.equal(ui.run('data.settings.minimumConfidence'), 0.9);
  assert.equal(ui.run('data.trigger.eventCountThreshold'), 25);
  assert.equal(ui.run('data.settings.maxMessagesPerBuffer'), 15);
  assert.equal(ui.run('data.activeFacet'), 'calm'); assert.match(ui.run('feedback'), /Newer edits have not been saved/);
  assert.equal(JSON.parse(String(ui.requests[1].options?.body)).settings.minimumConfidence, 0.8);
});

test('Mood Editor can retry failed reads and releases an unfinished read on navigation', async () => {
  let finish!: (response: Response) => void;
  const ui = editorFixture('MoodAgentSettings', async () => new Promise(resolve => { finish = resolve; }));
  ui.mount(); finish(new Response('{"success":false,"error":"Fixture load failed"}', { status: 500 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.run('data'), null); assert.equal(ui.run('error'), 'Fixture load failed');
  const retry = ui.run('load()'); ui.unmount();
  finish(new Response('{"success":true,"settings":{},"state":{},"facets":{},"trigger":null}')); await retry;
  assert.equal(ui.requests[1].options?.signal?.aborted, true); assert.equal(ui.run('data'), null);
});

test('Editor initial states do not claim unread memory is saved and Mood exposes retry after failure', () => {
  const { render } = componentRequire('svelte/server');
  const memory = renderedComponent('./MemoryEditor.svelte', {
    '../lib/client/api-config': { apiFetch: () => new Promise(() => {}) },
  }, { AbortController });
  const html = render(memory, { props: { isOpen: true, relPath: 'profile:one' } }).body;
  assert.doesNotMatch(html, /All changes saved/);
  assert.match(html, /Loading memory/);
  const mood = renderedComponent('./MoodAgentSettings.svelte', {
    '../lib/client/api-config': { apiFetch() {} }, '../stores/navigation': { graphEditorHref: () => '/editor' },
  }, {}, { loading: false, error: 'Fixture load failed' });
  assert.match(render(mood).body, /Retry loading Mood settings/);
});

for (const file of ['TriggerManagerDashboard', 'TriggerManagerSummary', 'TriggerManagerSettings']) {
  test(`${file} distinguishes unread state and failure from received schedules and lifecycle`, () => {
    const { render } = componentRequire('svelte/server');
    const trigger = { id: 'curator', displayName: 'Scheduled curator', enabled: true, lifecycle: 'scheduled-work',
      type: 'interval', interval: 60, handler: 'agent.curator', priority: 'normal', allowedModes: ['semi'],
      startupPolicy: 'skip', maxRetries: 0, nextRun: '2030-01-01T00:01:00Z', eligibleInCurrentMode: true,
      handlerRegistered: true, sourceResolvable: true, runCount: 0, errorCount: 0, suppressionCount: 0 };
    const received = { lifecycle: 'paused', admissionPaused: true, admissionEnabled: false, autonomyMode: 'semi',
      serverTime: '2030-01-01T00:00:00Z', timezone: 'UTC', config: { scope: 'system', runtimeRevision: 3 },
      globalSettings: { pauseAll: true, timezone: 'UTC' }, triggers: [trigger], recentAdmissions: [], healthFindings: [] };
    const triggerManagerSnapshot = writable<unknown>(null);
    const triggerManagerConnection = writable('connecting');
    const triggerManagerError = writable('');
    const screen = renderedComponent(`./${file}.svelte`, {
      '../lib/stores/trigger-manager': { triggerManagerSnapshot, triggerManagerConnection, triggerManagerError,
        useTriggerManager() {}, patchTriggerConfig() {}, runTriggerNow() {}, reloadTriggerConfig() {}, setTriggerAdmissionPaused() {} },
      '../stores/navigation': { openTriggerManagerDashboard() {}, openTriggerManagerSettings() {}, rightSidebarOpen: writable(false) },
      '../lib/client/active-operator-modes': componentRequire('../lib/client/active-operator-modes.ts'),
    });
    let html = render(screen).body;
    assert.match(html, /Waiting for|Loading authoritative/);
    assert.doesNotMatch(html, /starting|Reactive|No enabled trigger|Eligible timer admissions enabled/);
    triggerManagerError.set('Fixture coordinator unavailable');
    html = render(screen).body;
    assert.match(html, /Fixture coordinator unavailable/);
    assert.doesNotMatch(html, /Loading authoritative|Waiting for authoritative/);
    triggerManagerError.set('');
    triggerManagerConnection.set('live');
    assert.match(render(screen).body, /unavailable/);
    triggerManagerSnapshot.set(received);
    triggerManagerError.set('');
    html = render(screen).body;
    assert.match(html, /Scheduled curator/);
    if (file !== 'TriggerManagerSettings') assert.match(html, /Semi-autonomous|paused/);
    triggerManagerConnection.set('reconnecting');
    triggerManagerError.set('Fixture stream interrupted');
    html = render(screen).body;
    assert.match(html, /Fixture stream interrupted/);
    assert.match(html, /Scheduled curator/);
    assert.match(html, /reconnecting/);
  });
}

test('Trigger Manager settings exposes the pause write error beside its control', () => {
  const { render } = componentRequire('svelte/server');
  const screen = renderedComponent('./TriggerManagerSettings.svelte', {
    '../lib/stores/trigger-manager': { triggerManagerSnapshot: writable({ admissionPaused: false,
      config: { scope: 'system' }, globalSettings: {}, timezone: 'UTC', triggers: [] }),
      triggerManagerConnection: writable('live'), triggerManagerError: writable(''), useTriggerManager() {},
      patchTriggerConfig() {}, runTriggerNow() {} },
    '../stores/navigation': { openTriggerManagerDashboard() {}, rightSidebarOpen: writable(false) },
    '../lib/client/active-operator-modes': componentRequire('../lib/client/active-operator-modes.ts'),
  }, {}, { errors: { 'global.pauseAll': 'Fixture pause write failed' } });
  assert.match(render(screen).body, /Fixture pause write failed/);
});

test('Trigger Manager settings clears old success while a new manual run is pending or fails', async () => {
  const source = ts.createSourceFile('TriggerManagerSettings.ts', read('./TriggerManagerSettings.svelte')
    .match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  let fail!: (error: Error) => void;
  const context = vm.createContext({ onMount() {}, onDestroy() {}, runTriggerNow: () => new Promise((_resolve, reject) => { fail = reject; }),
    useTriggerManager() {}, trigger: { id: 'curator', displayName: 'Curator' } });
  vm.runInContext(transpile(source.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(source)).join('\n')), context);
  vm.runInContext("feedback = 'Old run queued'", context);
  const pending = vm.runInContext('runNow(trigger)', context);
  assert.equal(vm.runInContext('feedback', context), '');
  fail(new Error('Fixture run rejected'));
  await pending;
  assert.equal(vm.runInContext('feedback', context), '');
  assert.equal(vm.runInContext("errors['curator.run']", context), 'Fixture run rejected');
  assert.equal(vm.runInContext('saving', context), '');
});

test('Trigger Manager change handlers submit edits while retaining received values after a rejected patch', async () => {
  const component = read('./TriggerManagerSettings.svelte');
  const source = ts.createSourceFile('TriggerManagerSettings.ts', component
    .match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  for (const [handler, edited, received, key] of [
    ["saveGlobal('timezone',", 'Invalid/Zone', 'UTC', 'global.timezone'],
    ['saveAgentType(trigger,', 'manual', 'interval', 'curator.type'],
    ["saveAgent(trigger, 'interval',", '75', '60', 'curator.interval'],
  ]) {
    const control = { value: edited };
    const patches: unknown[] = [];
    const context = vm.createContext({ onMount() {}, onDestroy() {}, useTriggerManager() {},
      $triggerManagerSnapshot: { timezone: 'UTC' }, trigger: { id: 'curator', type: 'interval', interval: 60 },
      event: { currentTarget: control },
      patchTriggerConfig: async (patch: unknown) => { patches.push(patch); throw new Error('Fixture patch rejected'); },
    });
    vm.runInContext(transpile(source.statements.filter(node => !ts.isImportDeclaration(node))
      .map(node => node.getText(source)).join('\n')), context);
    const start = component.indexOf(`on:change={event => ${handler}`) + 'on:change={'.length;
    assert.ok(start >= 'on:change={'.length, `Missing real handler for ${handler}`);
    const callback = component.slice(start, component.indexOf('}', start));
    const pending = vm.runInContext(transpile(`(${callback})(event)`), context);
    assert.equal(control.value, received, 'pending edit must not replace the displayed received configuration');
    await pending;
    assert.equal(control.value, received);
    assert.equal(vm.runInContext(`errors[${JSON.stringify(key)}]`, context), 'Fixture patch rejected');
    const patch = JSON.parse(JSON.stringify(patches[0]));
    if (key === 'global.timezone') assert.equal(patch.globalSettings.timezone, edited);
    if (key === 'curator.interval') assert.equal(patch.agents.curator.interval, 75);
    if (key === 'curator.type') {
      assert.equal(patch.agents.curator.type, edited);
      assert.equal(patch.agents.curator.interval, null, 'existing type change clears the superseded interval');
    }
  }
});

test('Bridge diagnostics distinguishes absent Freestyle telemetry from explicit false and true values', () => {
  const { render } = componentRequire('svelte/server');
  const screen = renderedComponent('./EnvironmentBridgeDiagnostics.svelte', {
    '../lib/client/api-config': { apiUrl: (path: string) => path },
  });
  const session = { sessionId: 'session-one', updatedAt: '2026-11-05T12:00:00Z',
    transport: { inboundBytes: 0, outboundBytes: 0, inboundMessages: 0, outboundMessages: 0,
      inboundBytesPerSecond: 0, outboundBytesPerSecond: 0 },
    media: { imageFrames: 0, imageBytes: 0, audioUtterances: 0, audioBytes: 0 },
    microphoneLevel: 0, pendingAudioUtterances: 0, recentEvents: [] };
  for (const [freestyleMovement, expected] of [
    [undefined, 'Body support unknown Owner policy unknown Route unknown'],
    [{ supported: false, enabled: false, available: false }, 'Body support unsupported Owner policy disabled Route closed'],
    [{ supported: true, enabled: true, available: true }, 'Body support supported Owner policy enabled Route available'],
    [{ supported: true, enabled: false, available: false }, 'Body support supported Owner policy disabled Route closed'],
  ] as const) {
    const html = render(screen, { props: { diagnostics: { updatedAt: session.updatedAt, connections: [], sessions: [{ ...session, freestyleMovement }] } } }).body;
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    assert.ok(text.includes(expected), `Expected reported state: ${expected}; received: ${text}`);
  }
  const empty = render(screen, { props: { diagnostics: { updatedAt: session.updatedAt, connections: [], sessions: [] } } }).body;
  assert.match(empty, /Waiting for diagnostic telemetry/);
  assert.doesNotMatch(empty, /unsupported|disabled|closed/);
});

test('Agent Monitor offers service controls for registered running services and leaves finite work with its coordinator', () => {
  const { render } = componentRequire('svelte/server');
  const panel = { agentId: 'environment-bridge', displayName: 'Environment Bridge', description: 'Connection service',
    kind: 'connection', lifecycle: 'running', readiness: 'ready', dependencyHealth: 'ok', variables: [], errors: [] };
  const dependencies = {
    '../lib/client/api-config': { apiEventSource() { throw new Error('SSR must not open a stream'); }, apiFetch() {} },
    '../stores/security-policy': { isOwner: writable(true) },
    '../stores/navigation': { rightSidebarSection: writable('') },
    './BodyConnectionSelector.svelte': { default() {} },
    './EnvironmentBridgeDiagnostics.svelte': { default() {} },
  };
  const state = { hasSnapshot: true, selectedAgentName: panel.agentId, agentData: { [panel.agentId]: panel },
    registeredServices: new Set([panel.agentId]), startableAgents: [] };
  let screen = renderedComponent('./AgentMonitor.svelte', dependencies, {}, state);
  let html = render(screen).body;
  assert.match(html, />\s*Stop\s*</);
  assert.match(html, />\s*Restart\s*</);
  screen = renderedComponent('./AgentMonitor.svelte', dependencies, {}, {
    ...state, registeredServices: new Set(),
    agentData: { [panel.agentId]: { ...panel, kind: 'manual' } },
  });
  html = render(screen).body;
  assert.doesNotMatch(html, />\s*(Stop|Restart)\s*</);
});

// Compile the real Svelte templates and render them with isolated stores and
// child components. This checks visible output and child admission, not CSS text.
function renderedComponent(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}, initialState: Record<string, unknown> = {}) {
  let component = read(file);
  if (Object.keys(initialState).length) {
    // Seed the existing view fields for SSR snapshots; compile the actual
    // template, conditions and handlers without running browser-only reads.
    const match = component.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)!;
    const offset = match.index! + match[0].indexOf('>') + 1;
    const script = ts.createSourceFile(file, match[1], ts.ScriptTarget.Latest, true);
    const remaining = new Set(Object.keys(initialState));
    const edits: { start: number; end: number; value: string }[] = [];
    for (const statement of script.statements.filter(ts.isVariableStatement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(script);
        if (!remaining.has(name) || !declaration.initializer) continue;
        edits.push({ start: offset + declaration.initializer.getStart(script), end: offset + declaration.initializer.end,
          value: `__renderState[${JSON.stringify(name)}]` });
        remaining.delete(name);
      }
    }
    assert.equal(remaining.size, 0, `Unknown render fields: ${[...remaining].join(', ')}`);
    for (const edit of edits.sort((a, b) => b.start - a.start)) component = component.slice(0, edit.start) + edit.value + component.slice(edit.end);
  }
  const compiled = compile(component, { filename: file, generate: 'server' }).js.code;
  const code = ts.transpileModule(compiled, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const context = vm.createContext({ ...globals, __renderState: initialState, exports: {}, require: (id: string) =>
    Object.hasOwn(dependencies, id) ? dependencies[id] : componentRequire(id) });
  vm.runInContext(code, context);
  return context.exports.default;
}

test('Agent Catalog renders initial failures without a loading message and explains an empty filter', () => {
  const snapshot = writable<any>(null);
  const error = writable<string | null>('Catalog source is unavailable');
  const component = renderedComponent('./AgentCatalogDashboard.svelte', {
    '../lib/stores/agent-catalog': { agentCatalogSnapshot: snapshot, agentCatalogError: error, useAgentCatalog: () => () => {} },
    '../stores/navigation': { openAgentCatalogSettings() {} },
  });
  const { render } = componentRequire('svelte/server');
  let html = render(component).body;
  assert.match(html, /Catalog source is unavailable/);
  assert.doesNotMatch(html, /Loading Agent Catalog/);
  error.set(null);
  snapshot.set({ counts: { total: 0, installed: 0, triggerRegistered: 0, services: 0, available: 0, missingSource: 0 }, agents: [] });
  html = render(component).body;
  assert.match(html, /No agents match/);
  assert.match(html, /Manage catalog/);
});

test('Agent Catalog keeps search local and returns its subscription cleanup from mount', () => {
  const script = read('./AgentCatalogDashboard.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const ast = ts.createSourceFile('AgentCatalogDashboard.ts', script, ts.ScriptTarget.Latest, true);
  let mounted!: () => () => void;
  let users = 0;
  const context = vm.createContext({
    onMount: (callback: typeof mounted) => { mounted = callback; },
    useAgentCatalog: () => { users++; return () => { users--; }; },
    $agentCatalogSnapshot: { agents: [
      { id: 'system-code-review', displayName: 'System Code Review', description: 'Diagnoses technical errors', owner: 'trigger-manager', tags: ['repair'] },
      { id: 'organizer', displayName: 'Organizer', description: 'Organizes memories', owner: 'workflow', tags: ['memory'] },
    ] },
  });
  vm.runInContext(transpile(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join('\n')), context);
  const reactive = transpile(ast.statements.filter(ts.isLabeledStatement).map(statement => statement.getText(ast)).join('\n'));
  for (const [search, expected] of [['  SYSTEM CODE  ', 'system-code-review'], ['repair', 'system-code-review'],
    ['workflow', 'organizer'], ['memories', 'organizer'], ['missing', ''], ['', 'system-code-review,organizer']]) {
    vm.runInContext(`search = ${JSON.stringify(search)};\n${reactive}`, context);
    assert.equal(context.agents.map((agent: any) => agent.id).join(','), expected);
  }
  for (let cycle = 0; cycle < 2; cycle++) {
    const release = mounted();
    assert.equal(users, 1);
    assert.equal(typeof release, 'function');
    release();
    assert.equal(users, 0);
  }
});

test('Catalog Settings retains the embedded Active Operator controls and its error state', () => {
  const error = writable<string | null>(null);
  const snapshot = writable<any>({ counts: { total: 1, installed: 1, triggerRegistered: 0, services: 0, available: 0, missingSource: 0 },
    agents: [{ id: 'robot-operator', displayName: 'Active Operator', description: 'Controls autonomous work',
      owner: 'robot-operator', health: 'ready', risk: 'standard', tags: [], parentIds: [] }] });
  const component = renderedComponent('./AgentCatalogSettings.svelte', {
    '../lib/stores/agent-catalog': { agentCatalogSnapshot: snapshot, agentCatalogError: error,
      agentCatalogConnection: writable('ready'), useAgentCatalog: () => () => {} },
    '../lib/stores/trigger-manager': { patchTriggerConfig() {} },
    '../lib/client/api-config': { apiFetch() {} },
    '../stores/navigation': { openTriggerManagerSettings() {} },
    './ActiveOperatorSettings.svelte': { default: ($$payload: { push: (html: string) => void }) => { $$payload.push('<p>Active Operator controls fixture</p>'); } },
    './MoodAgentSettings.svelte': { default: () => {} },
  });
  const { render } = componentRequire('svelte/server');
  assert.match(render(component).body, /Active Operator controls fixture/);
  snapshot.set(null);
  error.set('Catalog source is unavailable');
  const html = render(component).body;
  assert.match(html, /Catalog source is unavailable/);
  assert.doesNotMatch(html, /Loading Agent Catalog/);
});

test('rendered header follows shared identity/mode and collapsed asides are inert', async () => {
  const { render } = await import('svelte/server');
  const statusStore = writable({ data: { identity: { name: 'First persona', icon: '/first.svg' } }, error: null, receivedAt: 1 });
  const policyStore = writable({ mode: 'dual' });
  const rightSidebarOpen = writable(false);
  const component = renderedComponent('./ChatLayout.svelte', {
    '../stores/navigation': { statusStore, rightSidebarOpen, statusRefreshTrigger: writable(0),
      nodeEditorMode: writable(false), currentUserStore: writable(null), userDisplayNameStore: writable('Fixture'),
      graphEditorHref: () => '?workspace=graph-editor' },
    '../stores/security-policy': { policyStore, isOwner: writable(false) },
    '../lib/client/api-config': { apiUrl: (url: string) => url },
    './HeadlessClaimBanner.svelte': { default: () => {} },
    './ThemeToggle.svelte': { default: renderedComponent('./ThemeToggle.svelte', {}) },
    './LeftSidebar.svelte': { default: ($$payload: { push: (html: string) => void }) => { $$payload.push('<p>Left panel fixture</p>'); } },
    './CenterContent.svelte': { default: ($$payload: { push: (html: string) => void }) => { $$payload.push('<p>Center panel fixture</p>'); } },
    './RightSidebar.svelte': { default: ($$payload: { push: (html: string) => void }) => { $$payload.push('<p>Right panel fixture</p>'); } },
    // Network initialization is separate from this rendered-state check.
    svelte: { ...componentRequire('svelte'), onMount: () => {} },
  });
  let html = render(component).body;
  for (const panel of ['Left', 'Center', 'Right']) {
    assert.equal(html.split(`${panel} panel fixture`).length - 1, 1);
  }
  assert.match(html, /aria-label="Toggle theme"/);
  assert.match(html, /First persona/);
  assert.match(html, /alt="Persona icon"/);
  const asides = [...html.matchAll(/<aside\b([^>]*)>/g)];
  assert.equal(asides.length, 2);
  for (const aside of asides) {
    assert.match(aside[1], /\binert\b/);
    assert.match(aside[1], /aria-hidden="true"/);
  }
  statusStore.set({ data: { identity: { name: 'Second persona', icon: '' } }, error: null, receivedAt: 2 });
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
  const rightSidebarTab = writable('queue');
  const mounted: string[] = [];
  const component = renderedComponent('./RightSidebar.svelte', {
    '../stores/navigation': { rightSidebarOpen, rightSidebarTab, rightSidebarSection: writable(null) },
    '../stores/security-policy': { isOwner: writable(true) },
    './AgentMonitor.svelte': { default: () => mounted.push('monitor') },
    './QueuePanel.svelte': { default: () => mounted.push('queue') },
    './ServerStatus.svelte': { default: () => mounted.push('servers') },
  });
  for (const selectedTab of ['queue', 'monitor', 'servers']) {
    rightSidebarTab.set(selectedTab);
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
    statusRefreshTrigger: writable(0), statusRead: undefined, modeRead: undefined, systemRead: undefined, closed: false,
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
    './ApprovalPrompt.svelte': blank,
    './terminal/TerminalChat.svelte': blank, './chat/MessageList.svelte': blank,
    './chat/InputArea.svelte': { default: (_payload: unknown, props: { readOnly: boolean; composeTarget: string }) => { inputs.push(props); } },
    '../stores/security-policy': { currentMode: writable('dual'), isOwner: writable(true) },
    '../stores/navigation': { yoloModeStore: writable(false) },
    '../lib/client/assistant-speech-preference': speech,
    '../lib/client/composables/useTTS': { useTTS: () => ({ isPlaying: writable(false), isLoading: writable(false) }) },
    '../lib/client/composables/useMicrophone': { useMicrophone: () => ({ isRecording: writable(false), isContinuousMode: writable(false),
      interimTranscript: writable(''), isNativeMode: writable(false), isConversationMode: writable(false) }) },
    '../lib/client/composables/useThinkingTrace': { useThinkingTrace: () => ({ trace: writable(''), statusLabel: writable(''),
      active: writable(false), steps: writable(''), showIndicator: writable(false) }) },
    '../lib/client/composables/useMessages': messageOwner,
    '../lib/client/server-health': { forceHealthCheck() { throw new Error('Render must not submit work'); } },
    '../lib/client/api-config': { apiFetch() { throw new Error('Render must not fetch'); }, apiEventSource() { throw new Error('Render must not subscribe'); } },
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
    svelte: { afterUpdate() {}, onDestroy() {}, createEventDispatcher: () => () => {} },
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

test('center loads only the selected panel without an eager preload or storage-backed reload path', async () => {
  const { render } = await import('svelte/server');
  const requested: string[] = [];
  const dependencies: Record<string, unknown> = {
    '../stores/navigation': { activeView: writable('dashboard'), dashboardSection: writable('tasks'),
      systemSection: writable('chat'), agencySection: writable('overview') },
    '../stores/security-policy': { isOwner: writable(false) },
    '../lib/client/api-config': {},
    './ChatInterface.svelte': { default: () => {} },
    './TTSQueueConsumer.svelte': { default: () => {} },
    svelte: { ...componentRequire('svelte'), onMount: () => {}, onDestroy() {} },
  };
  for (const name of ['Dashboard', 'TaskManager']) {
    Object.defineProperty(dependencies, `./${name}.svelte`, { get() {
      requested.push(name);
      return { default: () => {} };
    } });
  }
  const component = renderedComponent('./CenterContent.svelte', dependencies, {
    window: { removeEventListener() {}, get sessionStorage() {
      requested.push('sessionStorage');
      return { removeItem() {} };
    } },
  });
  for (let visit = 0; visit < 2; visit++) {
    assert.match(render(component).body, /Loading tasks/);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(requested, ['TaskManager', 'TaskManager']);
});

test('selected view import errors propagate without reloading or substituting another view', async () => {
  const source = ts.createSourceFile('center.ts', read('./CenterContent.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const loader = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'loadComponent')!;
  const error = new Error('Failed to fetch dynamically imported module');
  const requests: string[] = [];
  const state = vm.createContext({ require(id: string) { requests.push(id); throw error; } });
  vm.runInContext(ts.transpileModule(loader.getText(source), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, state);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(state.loadComponent('Dashboard'), error);
  }
  assert.deepEqual(requests, ['./Dashboard.svelte', './Dashboard.svelte']);
  await assert.rejects(state.loadComponent('Unknown'), /Unknown component: Unknown/);
});

test('application composition keeps the layout import behind the real authentication gate', async () => {
  const { render } = await import('svelte/server');
  const gate = renderedComponent('./AuthGate.svelte', {
    './OnboardingWizard.svelte': { default: () => {} },
    './ProfileSelector.svelte': { default: () => {} },
    '../lib/client/api-config': { isMobileApp: () => false, getApiBaseUrl: () => '', getSyncServerUrl: () => '' },
    '../lib/client/server-health': { healthStatus: writable({ connected: true }) },
    '../lib/client/sync-settings': {},
    '../lib/client/profile-sync': {},
    '../stores/security-policy': {},
    '../stores/navigation': {},
    svelte: { ...componentRequire('svelte'), onMount: () => {} },
  });
  let machineControls = 0;
  const dependencies = {
    './AuthGate.svelte': { default: gate },
    './BackendConnectionStatus.svelte': { default: () => { machineControls++; } },
    get './ChatLayout.svelte'(): never { throw new Error('Anonymous session imported the layout'); },
  };
  const app = renderedComponent('./App.svelte', dependencies);
  assert.match(render(app).body, /Checking authentication/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(machineControls, 1, 'machine selection stays outside authentication');
});

test('Voice Settings VAD releases capture resources and rejects cancelled or late results', async () => {
  const script = read('./VoiceSettings.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const source = ts.createSourceFile('VoiceSettings.ts', script, ts.ScriptTarget.Latest, true);
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const recorders: Recorder[] = [];
  let clock = 0, sequence = 0, volume = 180, tracksStopped = 0, contextsClosed = 0;
  let destroyed!: () => void;
  let permission: () => Promise<unknown> = async () => stream;
  let transcribe: (init: RequestInit) => Promise<Response> = async () => Response.json({ transcript: 'Complete fixture speech' });
  const uploads: RequestInit[] = [];
  const stream = { getTracks: () => [{ stop() { tracksStopped++; } }] };
  class Recorder {
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: (event: { error: Error }) => void;
    constructor(readonly stream: { getTracks: () => { stop(): void }[] }) { recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      assert.equal(this.state, 'recording', 'each recorder stops once');
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) });
        this.ondataavailable?.({ data: new Blob([new Uint8Array([2, 3])]) });
        this.onstop?.();
      });
    }
  }
  class Context {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { frequencyBinCount: 1024, fftSize: 2048,
      getByteFrequencyData(data: Uint8Array) { data.fill(volume); } }; }
    async close() { contextsClosed++; }
  }
  const state = vm.createContext({ AbortController, Blob, MediaRecorder: Recorder, AudioContext: Context,
    Date: { now: () => clock }, calculateVoiceVolume,
    navigator: { mediaDevices: { getUserMedia: () => permission() } },
    requestAnimationFrame(callback: () => void) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    window: { setTimeout(callback: () => void, delay: number) { const id = ++sequence; timers.set(id, { callback, delay }); return id; } },
    clearTimeout(id: number) { timers.delete(id); },
    apiFetch: async (url: string, init: RequestInit) => {
      assert.equal(url, '/api/stt?format=webm');
      assert.equal(frames.size + timers.size, 0, 'capture scheduling ends before transcription');
      assert.equal(tracksStopped, contextsClosed + 1, 'microphone and audio context released before upload (one late permission had no context)');
      uploads.push(init);
      return transcribe(init);
    },
    useTTS: () => ({ interruptPlaybackRequest() { assert.fail('VAD must not interrupt shared speech'); } }),
    onMount() {}, onDestroy(callback: () => void) { destroyed = callback; }, console,
  });
  vm.runInContext(transpile(source.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(source)).join('\n')), state);
  vm.runInContext('config = { stt: { vad: { voiceThreshold: 24, silenceDelay: 3500, minDuration: 700 } } }', state);
  const field = (name: string) => vm.runInContext(name, state);
  const frame = () => {
    assert.equal(frames.size, 1);
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id); callback();
  };
  const silence = () => {
    volume = 180; frame();
    assert.equal(field('vadTestSpeaking'), true);
    volume = 0; frame();
    assert.equal(timers.size, 1);
    const [id, timer] = timers.entries().next().value!;
    assert.equal(timer.delay, 3500, 'uses the unsaved draft silence setting');
    timers.delete(id); timer.callback();
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  await state.startVADTest();
  frame(); volume = 0; frame();
  assert.equal(timers.size, 1);
  state.cancelVADTest(); state.cancelVADTest();
  assert.equal(frames.size + timers.size, 0, 'cancellation releases the frame and pending silence callback');
  assert.equal(tracksStopped, 1); assert.equal(contextsClosed, 1);
  await settle(); assert.equal(uploads.length, 0);

  let grant!: (value: unknown) => void;
  permission = () => new Promise(resolve => { grant = resolve; });
  const latePermission = state.startVADTest();
  destroyed(); grant(stream); await latePermission;
  assert.equal(tracksStopped, 2, 'late permission after unmount immediately releases its track');
  assert.equal(contextsClosed, 1, 'late permission creates no audio context');
  assert.equal(recorders.length, 1);

  permission = async () => stream;
  await state.startVADTest(); clock += 1000; silence(); await settle();
  assert.deepEqual([...new Uint8Array(uploads[0]!.body as ArrayBuffer)], [1, 2, 3], 'uploads every recorded chunk');
  assert.equal(field('vadTestTranscription'), 'Complete fixture speech');
  assert.equal(field('vadTestError'), null);

  let finishOld!: (response: Response) => void;
  transcribe = () => new Promise(resolve => { finishOld = resolve; });
  await state.startVADTest(); clock += 1000; silence(); await settle();
  const oldSignal = uploads[1]!.signal!;
  await state.startVADTest();
  assert.equal(oldSignal.aborted, true, 'replacement cancels the old upload');
  finishOld(Response.json({ transcript: 'Stale transcription' })); await settle();
  assert.equal(field('vadTestRecording'), true, 'old completion cannot end the replacement recording');
  assert.equal(field('vadTestTranscription'), '');
  destroyed(); assert.equal(frames.size + timers.size, 0);

  permission = async () => { throw new Error('Permission denied'); };
  await state.startVADTest();
  assert.match(field('vadTestError'), /Permission denied/);
  permission = async () => stream;
  await state.startVADTest(); silence(); await settle();
  assert.match(field('vadTestError'), /Recording too short/);
  assert.equal(uploads.length, 2, 'short capture does not transcribe');
  await state.startVADTest();
  recorders.at(-1)!.onerror?.({ error: new Error('Recorder failed') });
  await settle();
  assert.equal(field('vadTestError'), 'Recorder failed');
  assert.equal(frames.size + timers.size, 0);
  assert.equal(tracksStopped, contextsClosed + 1, 'only the late permission lacked an audio context');
});

test('Voice Settings previews preserve draft options, failed saves and request ownership', async () => {
  const script = read('./VoiceSettings.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const source = ts.createSourceFile('VoiceSettings.ts', script, ts.ScriptTarget.Latest, true);
  const spoken: { text: string; options: Record<string, unknown> }[] = [];
  const stopped: string[] = [];
  const events: string[] = [];
  const saved: { kokoro: { voice: string; useCustomVoicepack: boolean } }[] = [];
  let destroyed!: () => void;
  let save: () => Promise<Response> = async () => Response.json({ error: 'Save failed' }, { status: 500 });
  let playback: () => Promise<string> = async () => 'completed';
  let nextId = 0;
  const state = vm.createContext({ AbortController, crypto: { randomUUID: () => String(++nextId) },
    window: { dispatchEvent: (event: { type: string }) => events.push(event.type) }, CustomEvent,
    useTTS: () => ({ speak: async (text: string, options: Record<string, unknown>) => {
      spoken.push({ text, options }); return playback();
    }, interruptPlaybackRequest: (id: string) => stopped.push(id) }),
    onMount() {}, onDestroy(callback: () => void) { destroyed = callback; },
    apiFetch: async (url: string, init: RequestInit) => {
      assert.equal(url, '/api/voice-settings'); assert.equal(init.method, 'POST');
      saved.push(JSON.parse(String(init.body))); return save();
    },
  });
  vm.runInContext(transpile(source.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(source)).join('\n')), state);
  vm.runInContext(`config = {provider: 'kokoro', outputTarget: 'local',
    piper: {voices: [{id: 'draft', modelPath: '/draft.onnx'}], currentVoice: 'draft', speakingRate: 1.3},
    kokoro: {voice: 'custom_import', langCode: 'a', speed: 1.2}}`, state);
  await state.testVoice();
  assert.equal(spoken.length, 0, 'a failed custom voicepack save must not preview the old saved voice');
  assert.equal(saved.at(-1)!.kokoro.useCustomVoicepack, true, 'selected imported voice derives custom mode at the API boundary');
  assert.match(vm.runInContext('error', state), /Save failed/);
  assert.equal(vm.runInContext('testingVoice', state), false);
  await state.testVoice('piper');
  assert.deepEqual(JSON.parse(JSON.stringify(spoken.at(-1))), {
    text: 'Hello! This is a test of the text to speech system.', options: {
      streaming: false, provider: 'piper', requestId: 'voice-preview-2', voice: '/draft.onnx', speed: 1.3,
    },
  });
  save = async () => Response.json({ success: true });
  await state.testVoice('kokoro');
  assert.deepEqual(JSON.parse(JSON.stringify(spoken.at(-1)!.options)), {
    streaming: true, provider: 'kokoro', requestId: 'voice-preview-3', langCode: 'a', speed: 1.2,
  });
  assert.deepEqual(events, ['voice-settings-updated']);
  vm.runInContext("config.kokoro.voice = 'af_heart'; config.kokoro.useCustomVoicepack = true", state);
  await state.saveSettings();
  assert.equal(saved.at(-1)!.kokoro.useCustomVoicepack, false, 'switching to built-in voice clears stale custom mode from the loaded response');
  vm.runInContext("config.kokoro.voice = 'custom_import'", state);

  let finishPlayback!: (value: string) => void;
  playback = () => new Promise(resolve => { finishPlayback = resolve; });
  const activePreview = state.testVoice('piper');
  destroyed();
  assert.deepEqual(stopped, ['voice-preview-4'], 'navigation interrupts only this component’s correlated preview');
  finishPlayback('failed'); await activePreview;
  assert.equal(vm.runInContext('error', state), null, 'late preview failure cannot mutate a destroyed view');

  let finishSave!: (value: Response) => void;
  save = () => new Promise(resolve => { finishSave = resolve; });
  const pendingPreview = state.testVoice('kokoro');
  const previousCount = spoken.length;
  destroyed(); finishSave(Response.json({ success: true })); await pendingPreview;
  assert.equal(spoken.length, previousCount, 'navigation during custom-save preparation must not start later speech');
  save = async () => Response.json({ error: 'Authentication required' }, { status: 401 });
  assert.equal(await state.saveSettings(), false);
  assert.equal(vm.runInContext('error', state), 'Error: Authentication required', 'expired authentication is not relabeled as a guest role');
  save = async () => Response.json({ success: true });
  assert.equal(await state.saveSettings(), true, 'the preserved draft can be saved after authentication recovers');
});

test('Voice Settings preserves the loaded draft and controls when an action fails', () => {
  const { render } = componentRequire('svelte/server');
  const config = { provider: 'piper', outputTarget: 'local',
    piper: { voices: [{ id: 'fixture', name: 'Fixture', language: 'en', quality: 'medium', modelPath: '/fixture.onnx' }],
      currentVoice: 'fixture', speakingRate: 1.3 },
    stt: { model: 'base.en', device: 'cpu', computeType: 'int8', language: 'en', useServer: true,
      vad: { voiceThreshold: 24, silenceDelay: 3500, minDuration: 700 } } };
  const component = renderedComponent('./VoiceSettings.svelte', {
    '../lib/client/composables/useTTS': { useTTS: () => ({}) },
    '../lib/client/api-config': { apiFetch() { throw new Error('Rendering must not request or synthesize speech'); } },
  }, {}, { config, loading: false, error: 'Voice preferences could not be saved' });
  const body = render(component).body;
  assert.match(body, /Voice preferences could not be saved/);
  assert.match(body, /id="piper-voice"/);
  assert.match(body, /1\.30x/);
  assert.match(body, /id="speech-output-target"/);
  assert.match(body, /Save Settings/);
  assert.match(body, /Start VAD Test/);
  assert.match(body, /3\.5 seconds/);
  assert.doesNotMatch(body, /guest|Guest/);
  const failedLoad = renderedComponent('./VoiceSettings.svelte', {
    '../lib/client/composables/useTTS': { useTTS: () => ({}) },
    '../lib/client/api-config': { apiFetch() { throw new Error('Rendering must not fetch'); } },
  }, {}, { loading: false, error: 'Failed to load voice settings' });
  const loadErrorBody = render(failedLoad).body;
  assert.match(loadErrorBody, /Failed to load voice settings/);
  assert.match(loadErrorBody, />Retry<\/button>/);
  assert.doesNotMatch(loadErrorBody, /id="piper-voice"/);
});

test('Server Status renders independent services, unavailable reads and stale backend snapshots', () => {
  const { render } = componentRequire('svelte/server');
  const dependencies = { '../lib/client/api-config': { apiFetch() { throw new Error('Rendering must not issue a request'); } } };
  const state = { loading: false, llmBackend: null,
    bigBrother: { sessionOpen: true, running: true, healthy: true, provider: 'codex', phase: 'running' },
    eventBus: { running: true, healthy: true, endpoint: 'http://telemetry.example.test:7777', eventCount: 9, subscribers: 2 } };
  let component = renderedComponent('./ServerStatus.svelte', dependencies, {}, state);
  let body = render(component).body;
  assert.match(body, /Big Brother/);
  assert.match(body, /Event Bus/);
  assert.match(body, /9 events/);
  assert.match(body, /2 subscribers/);
  component = renderedComponent('./ServerStatus.svelte', dependencies, {}, { ...state, bigBrother: null, eventBus: null });
  body = render(component).body;
  assert.equal(body.match(/Status unavailable/g)?.length, 2);
  assert.doesNotMatch(body, /Starts when Terminal|http:\/\/localhost:3100/);
  assert.match(body, />Start<\/button>/, 'unavailable observation adds no new control restriction');
  component = renderedComponent('./ServerStatus.svelte', dependencies, {}, { ...state,
    llmBackend: { activeBackend: 'llama-cpp', llamaCpp: { configured: true, running: true, model: 'fixture-model',
      endpoint: 'http://inference.example.test' }, ollama: { installed: false, running: false, endpoint: 'http://ollama.example.test' } },
    statusErrors: { 'LLM backend': 'LLM backend: diagnostic failed' } });
  body = render(component).body;
  assert.match(body, /fixture-model/);
  assert.match(body, /Last known status/);
  assert.match(body, /LLM backend: diagnostic failed/);
});

test('shared voice service controls preserve native readiness, errors and start/stop contracts', async () => {
  const source = ts.createSourceFile('servers.ts', read('./ServerStatus.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const selected = ['normalizeServerState', 'fetchStatusEndpoint', 'reportStatusFetchFailure', 'fetchVoiceServiceStatus', 'fetchServerStatus', 'controlServer', 'setVoiceServiceTarget', 'getStatusIcon', 'getStatusText'];
  const code = source.statements.filter(statement =>
    (ts.isFunctionDeclaration(statement) && selected.includes(statement.name!.text))
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
      ['serverConfigs', 'STATUS_FETCH_TIMEOUT_MS'].includes(declaration.name.getText(source)))))
    .map(statement => statement.getText(source)).join('\n');
  let unavailable = false;
  let otherServicesAvailable = false;
  let deferStatus = false;
  let finishStatus!: () => void;
  let rejectAction = false;
  let deferActions = false;
  const completeActions: (() => void)[] = [];
  const requests: { endpoint: string; method: string; action?: string; target?: string; remoteUrl?: string }[] = [];
  const alerts: string[] = [];
  const state = vm.createContext({ servers: [], llmBackend: null, bigBrother: null, eventBus: null,
    loading: true, statusFetchInProgress: false, voiceActions: {}, voiceRemoteUrlInputs: {}, AbortController, DOMException, setTimeout, clearTimeout,
    console: { log() {}, debug() {}, error() {} }, alert: (message: string) => alerts.push(message),
    apiFetch: async (endpoint: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const parsedBody = options?.body ? JSON.parse(String(options.body)) : undefined;
      const action = parsedBody?.action;
      requests.push({ endpoint, method, action, target: parsedBody?.target, remoteUrl: parsedBody?.remoteUrl });
      if (method === 'POST') {
        assert.ok(action === 'start' || action === 'stop' || action === 'set-target');
        if (deferActions) await new Promise<void>(resolve => completeActions.push(resolve));
        return Response.json(rejectAction ? { success: false, message: 'Stop denied' } : { success: true },
          { status: rejectAction ? 500 : 200 });
      }
      if (!['/api/whisper-server', '/api/kokoro-server'].includes(endpoint)) {
        if (!otherServicesAvailable) return Response.json({ error: 'Service read unavailable' }, { status: 404 });
        if (endpoint === '/api/llm-backend/status') {
          if (deferStatus) await new Promise<void>(resolve => { finishStatus = resolve; });
          return Response.json({ config: { activeBackend: 'llama-cpp',
          llamaCpp: { endpoint: 'http://inference.example.test' }, ollama: { endpoint: 'http://ollama.example.test' } },
          available: { llamaCpp: { configured: true, running: true }, ollama: { installed: false, running: false } } });
        }
        return Response.json({ running: false, sessionOpen: false, healthy: false, provider: null, phase: 'stopped',
          endpoint: 'http://telemetry.example.test' });
      }
      if (unavailable) return Response.json({ error: 'Status unavailable' }, { status: 503 });
      return Response.json({ installed: true, running: true, healthy: false, readiness: 'loading', pid: 1234,
        url: 'http://voice.example.test:9001', health: { model: 'fixture', device: 'cpu' } });
    },
  });
  vm.runInContext(transpile(code), state);
  await state.fetchServerStatus();
  assert.match(state.statusErrors['LLM backend'], /LLM backend: Service read unavailable/);
  assert.equal(state.servers.length, 2);
  for (const server of state.servers) {
    assert.equal(state.getStatusText(server), 'Starting...');
    assert.equal(server.details.pid, 1234);
    assert.equal(server.details.url, 'http://voice.example.test:9001');
    assert.equal(server.details.health.device, 'cpu');
    assert.equal(state.getStatusText({ ...server, details: { readiness: 'error' } }), 'Error');
    for (const action of ['start', 'stop']) {
      await state.controlServer(server, action);
      assert.equal(Object.keys(state.voiceActions).length, 0);
      assert.ok(requests.some(request => request.endpoint === server.endpoint && request.action === action));
    }
    await state.setVoiceServiceTarget(server, 'remote', 'http://dndiy:9882');
    assert.equal(Object.keys(state.voiceActions).length, 0);
    assert.ok(requests.some(request => request.endpoint === server.endpoint && request.action === 'set-target' && request.target === 'remote' && request.remoteUrl === 'http://dndiy:9882'));
  }
  deferActions = true;
  const whisper = state.controlServer(state.servers[0], 'start');
  const kokoro = state.controlServer(state.servers[1], 'stop');
  assert.equal(state.voiceActions['whisper-start'], true);
  assert.equal(state.voiceActions['kokoro-stop'], true);
  assert.equal(completeActions.length, 2, 'different services admit commands independently');
  completeActions.forEach(complete => complete());
  await Promise.all([whisper, kokoro]);
  assert.equal(Object.keys(state.voiceActions).length, 0);
  deferActions = false;
  rejectAction = true;
  await state.controlServer(state.servers[0], 'stop');
  assert.match(alerts[0], /Stop denied/);
  assert.equal(Object.keys(state.voiceActions).length, 0);
  unavailable = true;
  await state.fetchServerStatus();
  assert.equal(state.getStatusText(state.servers[0]), 'Unknown');
  assert.equal(state.servers[0].details.error, 'Status unavailable');
  unavailable = false;
  await state.fetchServerStatus();
  assert.equal(state.getStatusText(state.servers[0]), 'Starting...');
  assert.equal(state.servers[0].details.error, undefined);
  assert.equal(state.loading, false);
  assert.equal(state.statusFetchInProgress, false);
  otherServicesAvailable = true;
  deferStatus = true;
  const recovery = state.fetchServerStatus();
  assert.match(state.statusErrors['LLM backend'], /Service read unavailable/, 'retrying does not erase the previous failed read');
  finishStatus();
  await recovery;
  assert.equal(Object.keys(state.statusErrors).length, 0, 'successful refresh releases previous status-read errors');
});

test('main-site monitor links override saved sidebar preferences and survive history, reload and HMR', () => {
  const compiled = ts.transpileModule(read('../stores/navigation.ts'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const code = `(() => { ${compiled} })()`;
  const target = 'https://desktop.example.invalid/#view=chat&sidebar=monitor&section=body-connection';
  const stored = new Map([['mh_active_view', 'voice'], ['rightSidebarOpen', 'false'], ['mh_right_sidebar_tab', 'queue']]);
  function load(url: string) {
    const history = { state: null, replaceState(_state: unknown, _title: string, next: string) {
      window.location = new URL(next, window.location.href);
    } };
    const window = Object.assign(new EventTarget(), { location: new URL(url), history });
    const state = vm.createContext({ exports: {}, require: componentRequire, window, history, URLSearchParams,
      localStorage: { getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value) },
    });
    vm.runInContext(code, state);
    return { window, state, navigation: state.exports };
  }
  for (let reload = 0; reload < 2; reload++) {
    const { window, state, navigation } = load(target);
    assert.equal(get(navigation.activeView), 'chat');
    assert.equal(get(navigation.rightSidebarOpen), true);
    assert.equal(get(navigation.rightSidebarTab), 'monitor');
    assert.equal(get(navigation.rightSidebarSection), 'body-connection');
    assert.equal(window.location.href, target);
    const sidebar = navigation.rightSidebarTab;
    const listeners = getEventListeners(window, 'hashchange').length;
    vm.runInContext(code, state);
    assert.equal(state.exports.rightSidebarTab, sidebar);
    assert.equal(getEventListeners(window, 'hashchange').length, listeners);

    navigation.rightSidebarSection.set(null);
    navigation.rightSidebarTab.set('servers');
    assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('sidebar'), 'servers');
    assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('section'), false);
    navigation.rightSidebarOpen.set(false);
    assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('sidebar'), false);

    window.location = new URL(target);
    window.dispatchEvent(new Event('hashchange'));
    assert.equal(get(navigation.rightSidebarOpen), true);
    assert.equal(get(navigation.rightSidebarTab), 'monitor');
    assert.equal(get(navigation.rightSidebarSection), 'body-connection');
    window.location.hash = '#view=persona';
    window.dispatchEvent(new Event('hashchange'));
    assert.equal(get(navigation.activeView), 'persona');
    assert.equal(get(navigation.rightSidebarOpen), false);
    assert.equal(get(navigation.rightSidebarSection), null);
  }
});

test('Active Operator renders the shared status, configuration and stream failures', async () => {
  const { render } = await import('svelte/server');
  const stores = { coordinatorSnapshot: writable<any>(null), coordinatorConnection: writable('connecting'),
    coordinatorError: writable(''), useWorkCoordinator: () => () => {} };
  const settings = renderedComponent('./ActiveOperatorSettings.svelte', {
    '../lib/stores/work-coordinator': stores,
    '../stores/security-policy': { isOwner: writable(true) },
    '../lib/client/api-config': { apiFetch() { throw new Error('Rendering must not fetch'); } },
    '../lib/client/active-operator-modes': await import('../lib/client/active-operator-modes'),
  });
  const dashboard = renderedComponent('./ActiveOperatorDashboard.svelte', {
    '../lib/stores/work-coordinator': stores, './ActiveOperatorSettings.svelte': { default: settings },
  });
  assert.match(render(dashboard).body, /Connecting to Active Operator/);
  stores.coordinatorError.set('Connection unavailable');
  let html = render(dashboard).body;
  assert.match(html, /Connection unavailable/);
  assert.match(html, /Active Operator status is unavailable/);
  assert.doesNotMatch(html, /Loading status/);
  stores.coordinatorError.set('');
  stores.coordinatorSnapshot.set({ activeOperator: {
    configuration: { autonomyMode: 'semi', semiAssessmentMinutes: 7 }, mode: 'semi', health: 'healthy',
    operations: [{ id: 'observe', name: 'Look around', activation: 65, description: 'Inspect surroundings',
      lastAssessment: { assessedAt: '2026-11-04T09:00:00Z', mode: 'semi', reason: 'Recorded assessment', instruction: 'Recorded assessment instruction' },
      recordedActivity: [] }], assessments: [], queue: { length: 0, tasks: [] },
    robotOperator: { runtime: { lifecycle: 'running', reason: 'Fixture ready' }, episodes: [] },
  } });
  html = render(dashboard).body;
  assert.match(html, /Look around/);
  assert.match(html, /65%/);
  assert.match(html, /Recorded assessment instruction/);
  assert.match(html, /value="7"/);
  assert.match(html, /Fixture ready/);
  assert.doesNotMatch(html, /Connecting to Active Operator/);
  // Work history can exist before the first model assessment for an operation.
  stores.coordinatorSnapshot.update(snapshot => ({ ...snapshot, activeOperator: { ...snapshot.activeOperator,
    operations: [{ ...snapshot.activeOperator.operations[0], activation: 0, lastAssessment: null,
      recordedActivity: [{ id: 'manual-work', state: 'completed', createdAt: '2026-11-04T10:00:00Z',
        result: { executions: [{ executionId: 'fixture-execution', status: 'waiting' }] } }] }],
  } }));
  html = render(dashboard).body;
  assert.match(html, /Not yet assessed/);
  assert.match(html, /Admission: completed/);
  assert.match(html, /Execution: waiting/, 'an admission receipt must not be presented as execution completion');
  stores.coordinatorConnection.set('reconnecting');
  assert.match(render(dashboard).body, /displayed status may be out of date/);
});


test('Dashboard renders the shared snapshot and errors without inventing agent activity or storage usage', async () => {
  const { render } = await import('svelte/server');
  const statusStore = writable<{ data: unknown; error: string | null; receivedAt?: number }>({ data: { identity: { name: 'Shared profile', role: 'Companion', trustLevel: 'suggest' },
    tasks: { active: 17, byStatus: { in_progress: 9, blocked: 4 } }, values: [], goals: [],
    systemHealth: { resolvedBackend: 'llama-cpp', llmBackend: 'connected', auditLogSize: 2048 },
    memoryStats: { totalFiles: 12, totalIndexed: 11, indexAvailable: true }, lastUpdated: '2026-01-02T03:04:05Z' },
    error: null, receivedAt: 1793800000000 });
  const component = renderedComponent('./Dashboard.svelte', {
    '../stores/navigation': { statusStore, currentUserStore: writable({ username: 'fixture' }), statusRefreshTrigger: writable(0), openAgentCatalogDashboard() {} },
    './TriggerManagerOverviewCard.svelte': { default: () => {} },
    '../lib/client/api-config': { apiFetch() { throw new Error('Rendering the overview must not fetch'); } },
    svelte: { ...componentRequire('svelte'), onMount() {} },
  });
  let html = render(component).body;
  assert.match(html, /Shared profile/);
  assert.match(html, /Model Backend/);
  assert.match(html, /llama-cpp/);
  assert.match(html, /connected/);
  assert.match(html, /2 KB/);
  for (const name of ['Memory System', 'Core Values &amp; Goals', 'Agent Catalog']) assert.ok(html.includes(name), name);
  assert.doesNotMatch(html, /Storage Used|Agent Activity|Ollama|Run: .*init/);
  statusStore.update(value => ({ ...value, error: 'Backend snapshot unavailable' }));
  html = render(component).body;
  assert.match(html, /Backend snapshot unavailable/);
  assert.match(html, /Shared profile/, 'a read failure must retain the last real snapshot');
  statusStore.set({ data: null, error: 'Initial read failed' });
  html = render(component).body;
  assert.match(html, /Initial read failed/);
  assert.doesNotMatch(html, /Shared profile/);
});


test('Dashboard voice snapshots follow profile, foreground and user refresh; navigation cancels and releases reads', async () => {
  const source = ts.createSourceFile('Dashboard.ts', read('./Dashboard.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isLabeledStatement(node)).map(node => node.getText(source)).join('\n');
  const currentUserStore = writable({ username: 'first' });
  const statusRefreshTrigger = writable(0);
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  let mount!: () => () => void;
  const state = vm.createContext({ AbortController, console, currentUserStore, statusRefreshTrigger,
    window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: false }),
    onMount: (callback: typeof mount) => { mount = callback; },
    setInterval() { throw new Error('Dashboard must not poll'); },
    apiFetch: (url: string, options: RequestInit) => {
      assert.equal(url, '/api/voice-status', 'portal status has one existing owner');
      return new Promise<Response>(resolve => requests.push({ signal: options.signal!, resolve }));
    },
  });
  vm.runInContext(transpile(code), state);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const value = (name: string) => vm.runInContext(name, state);
  const unmount = mount();
  assert.equal(requests.length, 1);
  currentUserStore.set({ username: 'second' });
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(Response.json({ username: 'second', tts: { provider: 'kokoro', available: true } })); await settle();
  requests[0].resolve(Response.json({ username: 'first' })); await settle();
  assert.equal(value('voiceStatus.username'), 'second', 'the previous profile cannot overwrite the new snapshot');
  assert.equal(typeof value('voiceCheckedAt'), 'number');
  state.document.hidden = true;
  state.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 2);
  state.document.hidden = false;
  state.window.dispatchEvent(new Event('focus'));
  requests[2].resolve(Response.json({ error: 'Voice backend unavailable' }, { status: 503 })); await settle();
  assert.equal(value('voiceStatus.username'), 'second');
  assert.equal(value('voiceError'), 'Voice backend unavailable');
  state.refreshSnapshot();
  assert.equal(get(statusRefreshTrigger), 1);
  assert.equal(requests.length, 4);
  unmount();
  assert.equal(requests[3].signal.aborted, true);
  currentUserStore.set({ username: 'third' });
  state.window.dispatchEvent(new Event('focus'));
  state.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 4);
});

test('Trigger Manager overview distinguishes unavailable state, errors, reconnect and actual ordered schedule', async () => {
  const { render } = await import('svelte/server');
  const triggerManagerSnapshot = writable<unknown>(null);
  const triggerManagerConnection = writable('connecting');
  const triggerManagerError = writable('');
  const isOwner = writable(true);
  const component = renderedComponent('./TriggerManagerOverviewCard.svelte', {
    '../stores/navigation': { openTriggerManagerDashboard() {} },
    '../stores/security-policy': { isOwner },
    '../lib/stores/trigger-manager': { triggerManagerSnapshot, triggerManagerConnection, triggerManagerError, useTriggerManager() {} },
    '../lib/client/active-operator-modes': componentRequire('../lib/client/active-operator-modes.ts'),
    svelte: { ...componentRequire('svelte'), onMount() {}, onDestroy() {} },
  });
  let html = render(component).body;
  assert.match(html, /Waiting for Trigger Manager snapshot/);
  assert.doesNotMatch(html, /Reactive|Suppressed|No scheduled trigger|starting/);
  triggerManagerConnection.set('live');
  assert.match(render(component).body, /snapshot unavailable/);
  triggerManagerError.set('Coordinator unavailable');
  assert.match(render(component).body, /Coordinator unavailable/);
  triggerManagerSnapshot.set({ autonomyMode: 'semi', lifecycle: 'running', admissionPaused: false,
    admissionEnabled: true, timezone: 'UTC', triggers: [
      { enabled: false, displayName: 'Disabled earliest', nextRun: '2030-01-01T00:00:00Z' },
      { enabled: true, displayName: 'Earliest enabled', nextRun: '2030-01-02T00:00:00Z' },
      { enabled: true, displayName: 'Later enabled', nextRun: '2030-01-03T00:00:00Z' },
    ] });
  triggerManagerError.set('');
  html = render(component).body;
  for (const text of ['Semi-autonomous', 'running', 'Enabled', 'Earliest enabled', '2030']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Later enabled|Disabled earliest/);
  triggerManagerConnection.set('reconnecting');
  html = render(component).body;
  assert.match(html, /Last received snapshot/);
  assert.match(html, /reconnecting/);
  assert.match(html, /Earliest enabled/);
  isOwner.set(false);
  html = render(component).body;
  assert.match(html, /Owner access/);
  assert.doesNotMatch(html, /Earliest enabled|Semi-autonomous/);
});

function catalogSettingsHandlers(fetch: (url: string, options?: RequestInit) => Promise<Response>) {
  const text = read('./AgentCatalogSettings.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const ast = ts.createSourceFile('AgentCatalogSettings.ts', text, ts.ScriptTarget.Latest, true);
  let mount!: () => (() => void);
  let users = 0;
  const context = vm.createContext({ AbortController, Error, apiFetch: fetch,
    onMount: (callback: typeof mount) => { mount = callback; },
    useAgentCatalog: () => { users++; return () => { users--; }; },
    patchTriggerConfig: async () => { throw new Error('Trigger update failed'); },
    window: { confirm: () => true }, $agentCatalogSnapshot: null,
    agent: { id: 'psychoanalyzer', displayName: 'Psychotherapist' },
  });
  vm.runInContext(transpile(ast.statements.filter(statement => !ts.isImportDeclaration(statement))
    .map(statement => statement.getText(ast)).join('\n')), context);
  return { mount: () => mount(), users: () => users,
    run: (expression: string) => vm.runInContext(expression, context) };
}

test('Catalog Settings releases pending persona observation and its shared stream on navigation', async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const settings = catalogSettingsHandlers(async (url, options) => {
      assert.equal(url, '/api/psychoanalyzer-config'); signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const unmount = settings.mount();
    assert.equal(settings.users(), 1);
    unmount();
    assert.equal(settings.users(), 0);
    assert.equal(signal?.aborted, true);
    finish(new Response(JSON.stringify({ config: { updateStrategy: { preserveUserEdits: true } } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settings.run('preserveManualPersonaEdits'), false);
  }
});

test('Catalog Settings failures replace earlier success feedback for run and enable actions', async () => {
  const settings = catalogSettingsHandlers(async () => new Response(JSON.stringify({ error: 'Run failed' }), { status: 500 }));
  for (const [action, message] of [['runNow(agent)', 'Run failed'], ['toggleEnabled(agent, true)', 'Trigger update failed']]) {
    settings.run("feedback = 'Old successful action'");
    await settings.run(action);
    assert.equal(settings.run('feedback'), '');
    assert.equal(settings.run('localError'), message);
    assert.equal(settings.run('busy'), '');
  }
});

test('Catalog Settings keeps the loaded persona value until its save is acknowledged', async () => {
  let finish!: (response: Response) => void;
  const settings = catalogSettingsHandlers(async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { updateStrategy: { preserveUserEdits: true } });
    return new Promise(resolve => { finish = resolve; });
  });
  settings.run("feedback = 'Old successful action'");
  const saving = settings.run('updateManualEditProtection(true)');
  assert.equal(settings.run('preserveManualPersonaEdits'), false);
  finish(new Response(JSON.stringify({ error: 'Config write failed' }), { status: 500 }));
  await saving;
  assert.equal(settings.run('preserveManualPersonaEdits'), false);
  assert.equal(settings.run('psychoanalyzerConfigError'), 'Config write failed');
  assert.equal(settings.run('feedback'), '');
  assert.equal(settings.run('psychoanalyzerConfigLoading'), false);
  const retry = settings.run('updateManualEditProtection(true)');
  finish(new Response(JSON.stringify({ config: { updateStrategy: { preserveUserEdits: true } } })));
  await retry;
  assert.equal(settings.run('preserveManualPersonaEdits'), true);
});


test('retired operator proposal records retain source attribution through the existing read-only reflection renderer', async () => {
  const { render } = await import('svelte/server');
  const { getCardComponent, formatTimestamp } = await import('./chat/message-discriminator');
  const base = renderedComponent('./chat/cards/BaseMessageCard.svelte', {
    '../../../stores/navigation': { personaNameStore: writable('Fixture Persona'), userDisplayNameStore: writable('Fixture Owner') },
    '../message-discriminator': { formatTimestamp },
  });
  const reflection = renderedComponent('./chat/cards/ReflectionCard.svelte', { './BaseMessageCard.svelte': { default: base },
    '../message-discriminator': componentRequire('./chat/message-discriminator.ts') });
  for (const role of ['reflection', 'system'] as const) {
    const message = { role, content: '**Task:** custom\nOriginal operator proposal history', timestamp: 1,
      meta: { type: 'operator_proposal', dialogueSource: 'operator-policy' } };
    assert.equal(getCardComponent(message), 'ReflectionCard');
    const html = render(reflection, { props: { message, index: 0 } }).body;
    assert.match(html, /Operator Policy/);
    assert.match(html, /Original operator proposal history/);
    assert.doesNotMatch(html, /Approve|Reject|Modify|Awaiting your approval/);
    assert.equal(getCardComponent({ ...message, meta: { ...message.meta, bufferSource: 'system' } }), 'SystemMessageCard');
    assert.equal(getCardComponent({ ...message, meta: { ...message.meta, bufferSource: 'robot' } }), 'SystemMessageCard');
  }
});

test('message card keyboard selection leaves native child controls and editing alone', () => {
  const script = read('./chat/cards/BaseMessageCard.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const source = ts.createSourceFile('BaseMessageCard.ts', script, ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n');
  const message = { role: 'assistant', content: 'Speak this exact message', timestamp: 1, relPath: 'fixture.json' };
  const events: Array<{ name: string; detail: unknown }> = [];
  const owner = vm.createContext({ message, index: 4,
    dispatch: (name: string, detail: unknown) => events.push({ name, detail }),
  });
  vm.runInContext(transpile(code), owner);
  const card = { tagName: 'DIV', isContentEditable: false };
  for (const key of ['Enter', ' ']) {
    for (const tagName of ['BUTTON', 'SUMMARY', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SPAN']) {
      for (const isContentEditable of [false, true]) {
        let prevented = false;
        owner.handleKeydown({ key, target: { tagName, isContentEditable }, currentTarget: card,
          preventDefault() { prevented = true; } });
        assert.equal(prevented, false, `${key} on ${tagName} must retain native activation/editing`);
        assert.equal(events.length, 0, 'a child key event cannot select the message');
      }
    }
    let prevented = false;
    owner.handleKeydown({ key, target: card, currentTarget: card, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(structuredClone(events.splice(0).map(event => [event.name, event.detail])), [['messageClick', { message, index: 4 }]]);
  }
  let prevented = false;
  owner.handleKeydown({ key: 'Tab', target: card, currentTarget: card, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(events.length, 0);
  owner.handleSpeak({ stopPropagation() {} });
  owner.handleDelete({ stopPropagation() {} });
  owner.handleValidate({ stopPropagation() {} }, 'correct');
  assert.deepEqual(structuredClone(events.map(event => [event.name, event.detail])), [
    ['speakMessage', { content: message.content }], ['deleteMessage', { relPath: message.relPath }],
    ['validateMessage', { relPath: message.relPath, status: 'correct' }],
  ]);
});

test('message list retains filtered indexes and reasoning labels while showing progress once', async () => {
  const { render } = await import('svelte/server');
  const presentation = await import('./chat/message-discriminator');
  const thinking = renderedComponent('./Thinking.svelte', {});
  const base = renderedComponent('./chat/cards/BaseMessageCard.svelte', {
    '../../../stores/navigation': { personaNameStore: writable('Fixture Persona'), userDisplayNameStore: writable('Fixture Owner') },
    '../message-discriminator': presentation,
  });
  const assistant = renderedComponent('./chat/cards/AssistantMessageCard.svelte', {
    './BaseMessageCard.svelte': { default: base }, '../../Thinking.svelte': { default: thinking }, '../message-discriminator': presentation,
  });
  const reflection = renderedComponent('./chat/cards/ReflectionCard.svelte', { './BaseMessageCard.svelte': { default: base },
    '../message-discriminator': componentRequire('./chat/message-discriminator.ts') });
  const system = renderedComponent('./chat/cards/SystemMessageCard.svelte', { './BaseMessageCard.svelte': { default: base } });
  const reasoning = renderedComponent('./chat/cards/ReasoningCard.svelte', {
    '../../Thinking.svelte': { default: thinking }, '../message-discriminator': presentation,
  });
  const list = renderedComponent('./chat/MessageList.svelte', {
    '../Thinking.svelte': { default: thinking }, '../../stores/navigation': { personaNameStore: writable('Fixture Persona') },
    './message-discriminator': presentation,
    './cards/index': { cardComponents: { AssistantMessageCard: assistant, ReflectionCard: reflection,
      SystemMessageCard: system, ReasoningCard: reasoning } },
  });
  const messages = [
    { role: 'reflection', content: 'Inner history', timestamp: 1 },
    { role: 'assistant', content: 'Conversation history', timestamp: 1 },
    { role: 'reasoning', content: 'Persisted reasoning', timestamp: 1, meta: { stage: { round: 2, stage: 'plan_review' } } },
    { role: 'system', content: 'Canonical source history', timestamp: 1, meta: { bufferSource: 'system' } },
  ];
  const html = (props: Record<string, unknown>) => render(list, { props: { messages, ...props } }).body;
  const conversation = html({ mode: 'conversation', selectedMessageIndex: 1 });
  assert.match(conversation, /Conversation history/);
  assert.match(conversation, /card-selected/);
  assert.doesNotMatch(conversation, /Inner history|Persisted reasoning|Canonical source history/);
  const inner = html({ mode: 'inner', selectedMessageIndex: 2 });
  assert.match(inner, /Inner history/);
  assert.match(inner, /reasoning-card[^\"]*selected/);
  assert.match(inner, /Round 2: Plan Review/);
  assert.doesNotMatch(inner, /Conversation history|Canonical source history/);
  assert.match(html({ mode: 'conversation', showSystemMessages: true }), /System Buffer/);
  assert.match(html({ mode: 'combined' }), /Inner history[\s\S]*Conversation history[\s\S]*Persisted reasoning[\s\S]*Canonical source history/);
  const stages = [{ round: 3, stage: 'memory_review', content: 'Live stage content', timestamp: 2 }];
  const staged = html({ messages: [], reasoningStages: stages });
  assert.match(staged, /Round 3: Memory Review/);
  assert.match(staged, /Live stage content/);
  const progress = html({ messages: [], loading: true, showThinkingIndicator: true,
    thinkingSteps: 'Original task progress', thinkingStatusLabel: 'Currently processing' });
  assert.match(progress, /Original task progress/);
  assert.match(progress, /Currently processing/);
  assert.doesNotMatch(progress, /typing-indicator/);
});

test('Thinking preserves the initial expanded and collapsed rendering contract', async () => {
  const { render } = await import('svelte/server');
  const thinking = renderedComponent('./Thinking.svelte', {});
  for (const initiallyOpen of [false, true]) {
    const html = render(thinking, { props: { steps: 'Original attributed detail', label: 'Original reasoning label', initiallyOpen } }).body;
    assert.equal(/<details\b[^>]*\bopen(?:\s|>)/.test(html), initiallyOpen);
    assert.match(html, /Original attributed detail/);
    assert.match(html, /Original reasoning label/);
  }
});

test('Agency summaries and legacy notices use the existing read-only renderer while System notices retain their source', async () => {
  const { render } = await import('svelte/server');
  const presentation = await import('./chat/message-discriminator');
  const base = renderedComponent('./chat/cards/BaseMessageCard.svelte', {
    '../../../stores/navigation': { personaNameStore: writable('Fixture Persona'), userDisplayNameStore: writable('Fixture Owner') },
    '../message-discriminator': presentation,
  });
  const reflection = renderedComponent('./chat/cards/ReflectionCard.svelte', {
    './BaseMessageCard.svelte': { default: base }, '../message-discriminator': presentation,
  });
  const system = renderedComponent('./chat/cards/SystemMessageCard.svelte', { './BaseMessageCard.svelte': { default: base } });
  for (const type of ['desire_generation', 'desire_checkin_start', 'desire_checkin_status', 'desire_checkin_complete',
    'approval_request', 'plan_generated', 'desire_planning_start', 'desire_approved', 'desire_executing']) {
    for (const role of ['reflection', 'assistant', 'system'] as const) {
      const message = { role, content: 'Original attributed Agency content', timestamp: 1, relPath: 'original.json',
        meta: { dialogueSource: 'agency-system', type, desireId: 'legacy-desire' } };
      assert.equal(presentation.getCardComponent(message), 'ReflectionCard');
      const html = render(reflection, { props: { message, index: 3, isSelected: true } }).body;
      assert.ok(html.includes(presentation.getGoalLabelConfig(type).label));
      assert.match(html, /Original attributed Agency content/);
      assert.match(html, /#f59e0b/);
      assert.match(html, /card-selected/);
      assert.match(html, /Listen to message/);
      assert.match(html, /title="Delete"/);
      assert.match(html, /title="Mark correct"/);
      assert.doesNotMatch(html, />\s*(Approve|Reject|Feedback|Execute Now|Confirm Complete|Request Revision|Ready to Plan)\s*</);
    }
  }
  const currentSummary = { role: 'reflection' as const, content: 'Current generator review', timestamp: 2,
    meta: { bufferSource: 'inner', dialogueSource: 'agency-system', type: 'desire_generation', displayColor: '#10b981' } };
  const summary = render(reflection, { props: { message: currentSummary, index: 0 } }).body;
  assert.match(summary, /Agency/);
  assert.match(summary, /#10b981/);
  const notice = { role: 'system' as const, content: 'Current approval notice', timestamp: 3,
    meta: { bufferSource: 'system', dialogueSource: 'agency-system', source: 'agency', type: 'approval_request', desireId: 'current-desire' } };
  assert.equal(presentation.getCardComponent(notice), 'SystemMessageCard');
  const canonical = render(system, { props: { message: notice, index: 0 } }).body;
  assert.match(canonical, /System Buffer/);
  assert.match(canonical, /Current approval notice/);
  assert.doesNotMatch(canonical, /Approve|Listen to message/);
  assert.equal(presentation.getCardComponent({ role: 'assistant', content: 'Legacy', timestamp: 4,
    meta: { isAgencyMessage: true } }), 'ReflectionCard');
});

test('input touch gestures emit one action and release timers on movement, cancellation and destruction', () => {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const vibrations: number[] = [];
  let timerId = 0;
  const ui = editorFixture('chat/InputArea', async () => { throw new Error('Input gestures must not request HTTP'); }, {
    afterUpdate() {},
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    navigator: { vibrate: (duration: number) => vibrations.push(duration) },
  });
  ui.run('event = { preventDefault() {}, touches: [{ clientX: 20, clientY: 20 }] }');
  const gesture = (code: string) => ui.run(`${code}(event)`);
  gesture('handleMicTouchStart');
  assert.equal([...timers.values()][0].delay, 500);
  const timer = [...timers.values()][0]; timers.clear(); timer.callback();
  gesture('handleMicTouchEnd');
  assert.deepEqual(ui.events.map(event => event.name), ['micLongPress']);
  assert.deepEqual(vibrations, [50]);
  assert.equal(timers.size, 0);
  ui.events.length = 0;
  gesture('handleMicTouchStart'); gesture('handleMicTouchEnd');
  assert.deepEqual(ui.events.map(event => event.name), ['micClick']);
  assert.equal(timers.size, 0);
  ui.events.length = 0;
  ui.run('ttsIsPlaying = true'); gesture('handleMicTouchStart'); gesture('handleMicTouchEnd');
  assert.deepEqual(ui.events.map(event => event.name), ['ttsStopAndListen']);
  ui.events.length = 0;
  gesture('handleMicTouchStart'); ui.run('event.touches[0].clientX += 10'); gesture('handleMicTouchMove');
  assert.equal(timers.size, 1, 'the existing ten-pixel tolerance is inclusive');
  ui.run('event.touches[0].clientX += 1'); gesture('handleMicTouchMove'); gesture('handleMicTouchEnd');
  assert.equal(timers.size, 0); assert.equal(ui.events.length, 0);
  gesture('handleMicTouchStart'); ui.run('cancelMicTouch()'); gesture('handleMicTouchEnd');
  assert.equal(timers.size, 0); assert.equal(ui.events.length, 0);
  gesture('handleMicTouchStart'); ui.unmount();
  assert.equal(timers.size, 0);
  assert.equal(ui.requests.length, 0);
});

test('feedback preserves rejected and newer drafts, reports failures and releases its success timer', async () => {
  let finish!: (response: Response) => void;
  let reject!: (error: Error) => void;
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const ui = editorFixture('chat/FeedbackButtons', () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }), {
    setTimeout(callback: () => void, delay: number) { timers.set(++nextId, { callback, delay }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  ui.run("handleRatingClick(-1); comment = ' rejected draft '");
  const failed = ui.run('submitFeedback()');
  finish(Response.json({ error: 'Feedback rejected' }, { status: 400 })); await failed;
  assert.equal(ui.run('error'), 'Feedback rejected');
  assert.equal(ui.run('comment'), ' rejected draft ');
  assert.equal(ui.run('currentRating'), -1); assert.equal(ui.run('showSuccess'), false);
  assert.deepEqual(JSON.parse(String(ui.requests[0].options?.body)), { rating: -1, comment: 'rejected draft', targetType: 'conversation' });
  const networkFailed = ui.run('submitFeedback()'); reject(new Error('Feedback connection lost')); await networkFailed;
  assert.equal(ui.run('error'), 'Feedback connection lost');
  assert.equal(ui.run('comment'), ' rejected draft ');
  const saving = ui.run('submitFeedback()'); ui.run("comment = 'newer draft'");
  finish(Response.json({ success: true })); await saving;
  assert.equal(ui.run('showSuccess'), true);
  const [firstId, timer] = [...timers][0]; timers.delete(firstId);
  assert.equal(timer.delay, 1500); timer.callback();
  assert.equal(ui.run('comment'), 'newer draft'); assert.equal(ui.run('currentRating'), -1);
  assert.equal(ui.run('showSuccess'), false); assert.equal(ui.run('showInput'), true);
  const finalSave = ui.run('submitFeedback()'); finish(Response.json({ success: true })); await finalSave;
  const [secondId, finalTimer] = [...timers][0]; timers.delete(secondId); finalTimer.callback();
  assert.equal(ui.run('comment'), ''); assert.equal(ui.run('currentRating'), 0); assert.equal(ui.run('showInput'), false);
  ui.run('handleRatingClick(1)'); const leaving = ui.run('submitFeedback()');
  finish(Response.json({ success: true })); await leaving;
  assert.equal(timers.size, 1);
  const lateResponse = ui.run('submitFeedback()');
  ui.unmount(); assert.equal(timers.size, 0);
  finish(Response.json({ success: true })); await lateResponse;
  assert.equal(timers.size, 0, 'a response received after destruction must not create a UI timer');
  assert.equal(ui.events.length, 0, 'the sole consumer has no feedback completion event');
  const { render } = await import('svelte/server');
  const component = renderedComponent('./chat/FeedbackButtons.svelte', {
    svelte: { onDestroy() {} },
    '../../lib/client/api-config': { apiFetch() { throw new Error('Rendering feedback must not fetch'); } },
  }, {}, { error: 'Feedback rejected' });
  assert.match(render(component).body, /role="alert"[^>]*>Feedback rejected/);
});

test('curiosity status follows the current question and associates skip acknowledgements with the submitted ID', async () => {
  let finish!: (response: Response) => void;
  const ui = editorFixture('chat/cards/CuriosityCard', () => new Promise(resolve => { finish = resolve; }));
  const script = read('./chat/cards/CuriosityCard.svelte').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const source = ts.createSourceFile('curiosity.ts', script, ts.ScriptTarget.Latest, true);
  const derive = () => ui.run(transpile(source.statements.filter(ts.isLabeledStatement).map(node => node.getText(source)).join('\n')));
  ui.run("message = { meta: { questionId: 'q1', answered: true } }"); derive();
  assert.equal(ui.run('hasResponded'), true);
  ui.run("message = { meta: { questionId: 'q2' } }"); derive();
  assert.equal(ui.run('hasResponded'), false);
  const skipping = ui.run('handleSkip()');
  ui.run("message = { meta: { questionId: 'q3' } }"); derive();
  finish(Response.json({ success: true })); await skipping; derive();
  assert.deepEqual(JSON.parse(String(ui.requests[0].options?.body)), { questionId: 'q2' });
  assert.equal(ui.run('hasResponded'), false, 'an older receipt cannot resolve a different question');
  ui.run("message = { meta: { questionId: 'q2' } }"); derive();
  assert.equal(ui.run('wasSkipped'), true);
  ui.run("message = { meta: { questionId: 'q3' } }"); derive();
  const failed = ui.run('handleSkip()');
  finish(Response.json({ error: 'Question already answered' }, { status: 409 })); await failed; derive();
  assert.equal(ui.run('skipError.message'), 'Question already answered');
  assert.equal(ui.run('hasResponded'), false); assert.equal(ui.run('isSkipping'), false);
  const retry = ui.run('handleSkip()'); finish(Response.json({ success: true })); await retry; derive();
  assert.equal(ui.run('hasResponded'), true); assert.equal(ui.run('wasSkipped'), true);
  assert.equal(ui.events.length, 0);
});

test('Center memory browser refreshes the saved document and removes acknowledged deletions from every displayed memory category', async () => {
  let content = 'Original full reflection';
  const memory = { id: 'memory-one', relPath: 'profile:memory/episodic/reflections/one.json', content: 'Preview', timestamp: '2026-11-05T00:00:00Z' };
  const requests: string[] = [];
  const ui = editorFixture('CenterContent', async (url) => {
    requests.push(url);
    if (url.startsWith('/api/memory-content')) return Response.json({ success: true, content });
    if (url.startsWith('/api/memories_all')) return Response.json({ episodic: [memory], reflections: [memory], dreams: [memory], aiIngestor: [memory], audio: [memory], tasks: [{ relPath: 'profile:task.json' }], curated: [{ relPath: 'profile:curated.json' }] });
    if (url === '/api/memories/validate') return Response.json({ success: true });
    if (url === '/api/memories/delete') return Response.json({ success: true });
    throw new Error(`Unexpected request ${url}`);
  }, { $activeView: 'persona', window: new EventTarget(), alert(message: string) { throw new Error(message); } });
  ui.run("personaTab = 'memory'"); await ui.run('loadEvents()');
  ui.run(`expanded = { '${memory.relPath}': true, 'profile:task.json': true, 'profile:curated.json': true }`);
  await ui.run(`loadMemoryContent('${memory.relPath}')`);
  await ui.run("loadMemoryContent('profile:task.json')");
  await ui.run("loadMemoryContent('profile:curated.json')");
  await ui.run('loadEvents()');
  assert.equal(ui.run("expanded['profile:task.json']"), true, 'refresh retains task expansion');
  assert.equal(ui.run("memoryContent['profile:curated.json'].status"), 'ready', 'refresh retains curated content');
  content = 'Saved full reflection';
  await ui.run(`handleEditorSaved({ detail: { relPath: '${memory.relPath}' } })`);
  assert.equal(ui.run(`memoryContent['${memory.relPath}'].content`), content);
  assert.equal(requests.filter(url => url.includes(encodeURIComponent(memory.relPath))).length, 2);
  await ui.run(`setValidation(${JSON.stringify(memory)}, 'correct')`);
  for (const category of ['events', 'reflectionMemories', 'dreamMemories', 'aiIngestorMemories', 'audioTranscriptMemories']) {
    assert.equal(ui.run(`${category}[0].validation.status`), 'correct');
  }
  await ui.run(`deleteMemory(${JSON.stringify(memory)})`);
  for (const category of ['events', 'reflectionMemories', 'dreamMemories', 'aiIngestorMemories', 'audioTranscriptMemories']) {
    assert.equal(ui.run(`${category}.length`), 0, category);
  }
  assert.equal(ui.run(`memoryContent['${memory.relPath}']`), undefined);
  assert.equal(ui.run(`expanded['${memory.relPath}']`), undefined);
});

test('Center memory list ignores superseded and closed-view reads without cancelling writes or erasing the last snapshot', async () => {
  const pending: Array<{ finish: (response: Response) => void; signal?: AbortSignal }> = [];
  const ui = editorFixture('CenterContent', (_url, options) => new Promise(resolve => pending.push({ finish: resolve, signal: options?.signal as AbortSignal })), {
    $activeView: 'persona', window: new EventTarget(),
  });
  ui.run("personaTab = 'memory'");
  const first = ui.run('loadEvents()'); const second = ui.run('loadEvents()');
  assert.equal(pending[0].signal?.aborted, true);
  assert.equal(pending[1].signal?.aborted, false);
  pending[1].finish(Response.json({ episodic: [{ id: 'new', content: 'New snapshot', relPath: 'profile:new.json' }] })); await second;
  pending[0].finish(Response.json({ episodic: [{ id: 'old', content: 'Old snapshot', relPath: 'profile:old.json' }] })); await first;
  assert.equal(ui.run('events[0].id'), 'new'); assert.equal(ui.run('loadingEvents'), false);
  const leaving = ui.run('loadEvents()'); ui.run('cancelEventsRead()');
  assert.equal(pending[2].signal?.aborted, true);
  pending[2].finish(Response.json({ error: 'Old rejected read' }, { status: 500 })); await leaving;
  assert.equal(ui.run('eventsError'), null); assert.equal(ui.run('events[0].id'), 'new');
  const closing = ui.run('loadEvents()'); ui.unmount();
  assert.equal(pending[3].signal?.aborted, true);
  pending[3].finish(Response.json({ episodic: [] })); await closing;
  assert.equal(ui.run('events[0].id'), 'new');
});

test('Center memory mutation acknowledgements retire older reads so deleted rows and stale validation cannot return', async () => {
  let finishRead!: (response: Response) => void;
  let finishWrite!: (response: Response) => void;
  let readSignal: AbortSignal | undefined;
  const ui = editorFixture('CenterContent', (url, options) => new Promise(resolve => {
    if (url.startsWith('/api/memories_all')) { finishRead = resolve; readSignal = options?.signal as AbortSignal; }
    else finishWrite = resolve;
  }), { $activeView: 'persona', window: new EventTarget(), alert(message: string) { throw new Error(message); } });
  const item = { id: 'one', relPath: 'profile:memory/episodic/one.json', content: 'Before mutation' };
  ui.run(`personaTab = 'memory'; events = [${JSON.stringify(item)}]`);
  const oldRead = ui.run('loadEvents()');
  const deleting = ui.run(`deleteMemory(${JSON.stringify(item)})`);
  finishWrite(Response.json({ success: true })); await deleting;
  assert.equal(readSignal?.aborted, true);
  finishRead(Response.json({ episodic: [item] })); await oldRead;
  assert.equal(ui.run('events.length'), 0);
  ui.run(`events = [${JSON.stringify(item)}]`);
  const anotherRead = ui.run('loadEvents()');
  const validating = ui.run(`setValidation(${JSON.stringify(item)}, 'correct')`);
  finishWrite(Response.json({ success: true })); await validating;
  assert.equal(readSignal?.aborted, true);
  finishRead(Response.json({ episodic: [item] })); await anotherRead;
  assert.equal(ui.run('events[0].validation.status'), 'correct');
  assert.equal(ui.run(`saving['${item.relPath}']`), undefined);
  assert.equal(ui.run(`deleting['${item.relPath}']`), undefined);
});
