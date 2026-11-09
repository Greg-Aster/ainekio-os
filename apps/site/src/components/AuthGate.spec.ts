import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { apiFetch, getApiBaseUrl, isHostedUi, isMobileApp, setBackendUrl } from '../lib/client/api-config.js';

// Execute the component's handlers with its real transport owner, without
// starting an Ainekio OS runtime or accessing installation accounts and data.
const component = readFileSync(new URL('./AuthGate.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('AuthGate.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const handlers = ['storeSession', 'selectLoginMachine', 'openAccountView', 'reloadApp', 'handleLogin', 'continueAsGuest'];
const statements = source.statements.filter(statement =>
  (ts.isFunctionDeclaration(statement) && handlers.includes(statement.name!.text))
  || (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(source) === 'onMount'));
const code = ts.transpileModule(statements.map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function authHandlers(names: string[], globals: Record<string, unknown>, componentSource = source) {
  const selected = componentSource.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name!.text));
  const state = vm.createContext({ Error, console: { log() {}, warn() {}, error() {} }, ...globals });
  vm.runInContext(ts.transpileModule(selected.map(statement => statement.getText(componentSource)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, state);
  return state;
}

test('unified login routes credentials to the chosen machine, while local login stays same-origin', async () => {
  const keys = ['window', 'localStorage', '__METAHUMAN_STATIC_UI__', 'fetch'] as const;
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stored = new Map<string, string>();
  const requests: { url: string; options?: RequestInit }[] = [];
  let acceptLogin = false;
  let mounted!: () => () => void;
  let authChecks = 0;
  let reloads = 0;
  const location = { href: 'https://mh.ainek.io/?login', reload: () => { reloads++; } };
  const windowFixture = Object.assign(new EventTarget(), {
    location,
    history: { state: null, replaceState: (_state: unknown, _title: string, url: URL) => { location.href = url.href; } },
  });
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  };
  try {
    Object.assign(globalThis, {
      window: windowFixture, localStorage: storage, __METAHUMAN_STATIC_UI__: true,
      fetch: async (url: string, options?: RequestInit) => {
        requests.push({ url, options });
        const payload = url.endsWith('/persona-core') ? { persona: { identity: { name: 'Fixture' } } }
          : acceptLogin ? { success: true, user: { username: 'fixture' }, sessionId: 'fixture-session' }
          : { error: 'Wrong password' };
        return new Response(JSON.stringify(payload), { status: acceptLogin ? 200 : 401 });
      },
    });
    const state = vm.createContext({
      apiFetch, getApiBaseUrl, isHostedUi, isMobileApp, setBackendUrl,
      window: windowFixture, localStorage: storage, URL,
      console: { log() {}, error() {} },
      canSyncOnLogin: async () => false,
      onMount: (callback: typeof mounted) => { mounted = callback; },
      setTimeout: () => { throw new Error('Login must not defer reload on an unmanaged timer'); }, clearTimeout() {},
      checkAuth: () => { authChecks++; state.isAuthenticated = acceptLogin; }, handleApiAuthFailure() {}, handleApiAction() {}, apiActionNoticeTimer: null,
      machineInput: { reportValidity: () => true }, machineAddress: 'https://desktop.ainek.io/',
      username: 'fixture', password: 'fixture-password', error: '', loading: false,
      successMessage: '', showSyncHint: false, isAuthenticated: false, isCheckingAuth: true,
      view: 'login', guestSessionError: '', showProfileSelector: false,
    });
    vm.runInContext(code, state);
    setBackendUrl('https://old.ainek.io');
    mounted()();
    assert.equal(authChecks, 0, 'Change machine must show login even when the previous machine has a session');
    assert.equal(location.href, 'https://mh.ainek.io/');
    mounted()();
    assert.equal(authChecks, 1, 'ordinary reload still restores the selected machine session');

    await state.handleLogin({ preventDefault() {} });
    assert.equal(requests[0].url, 'https://desktop.ainek.io/api/auth/login');
    assert.equal(requests[0].options?.credentials, 'include');
    assert.deepEqual(JSON.parse(String(requests[0].options?.body)), { username: 'fixture', password: 'fixture-password' });
    assert.equal(state.error, 'Wrong password');
    assert.equal(state.loading, false);

    acceptLogin = true;
    state.machineAddress = 'https://q6a.ainek.io';
    await state.handleLogin({ preventDefault() {} });
    assert.equal(requests[1].url, 'https://q6a.ainek.io/api/auth/login');
    assert.equal(requests[2].url, 'https://q6a.ainek.io/api/persona-core');
    assert.equal(state.error, '');
    assert.deepEqual([...stored], [['mh_backend_url', 'https://q6a.ainek.io']], 'web stores only the backend address');
    assert.equal(reloads, 0, 'normal login reuses the verified session publisher without reloading');
    assert.equal(authChecks, 2);

    state.machineAddress = 'https://desktop.ainek.io';
    state.openAccountView('forgot-password');
    assert.equal(state.view, 'forgot-password');
    assert.equal(getApiBaseUrl(), 'https://desktop.ainek.io');
    await state.continueAsGuest();
    assert.equal(requests.at(-1)?.url, 'https://desktop.ainek.io/api/auth/guest');
    assert.equal(state.showProfileSelector, true);

    const count = requests.length;
    state.machineInput.reportValidity = () => false;
    await state.handleLogin({ preventDefault() {} });
    assert.equal(requests.length, count, 'an incomplete machine field must use normal form validation');

    Object.assign(globalThis, { __METAHUMAN_STATIC_UI__: false });
    state.machineInput = undefined; // The local form has no machine input.
    const checksBeforeLocalLogin = authChecks;
    await state.handleLogin({ preventDefault() {} });
    assert.equal(requests[count].url, '/api/auth/login');
    assert.equal(requests[count].options?.credentials, 'same-origin');
    assert.equal(stored.get('mh_backend_url'), 'https://desktop.ainek.io', 'local login ignores saved hosted selection');
    location.href = 'http://localhost:4321/?login';
    mounted()();
    assert.equal(authChecks, checksBeforeLocalLogin + 2, 'login and local remount use the same server verification');
  } finally {
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('session restoration publishes the verified user and clears it on expiry or failed restoration', async () => {
  const { get } = await import('svelte/store');
  const { currentUserStore, statusStore, userDisplayNameStore } = await import('../stores/navigation.js');
  const selected = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ['clearSessionState', 'checkAuth', 'handleApiAuthFailure', 'clearStoredSession', 'clearServerSessionCookie'].includes(statement.name!.text));
  const handlerCode = ts.transpileModule(selected.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let user: unknown = { id: 'owner', username: 'fixture', role: 'owner', metadata: { displayName: 'Fixture' } };
  const requests: string[] = [];
  let policyLoads = 0;
  let policyClears = 0;
  let encryptionLocked = false;
  let networkFailure = false;
  const state = vm.createContext({
    currentUserStore, statusStore,
    apiFetch: async (url: string) => {
      requests.push(url);
      if (networkFailure) throw new Error('Connection lost');
      return new Response(JSON.stringify(encryptionLocked ? { data: { encryptionLocked: true, username: 'fixture' } } : { user }), { status: user ? 200 : 401 });
    },
    fetchSecurityPolicy: async () => { policyLoads++; }, clearSecurityPolicy() { policyClears++; },
    localStorage: { removeItem() {} }, console: { log() {}, warn() {} },
    isAuthenticated: false, isCheckingAuth: true, handlingAuthFailure: false,
    error: '', view: 'login', username: '',
  });
  vm.runInContext(handlerCode, state);
  await state.checkAuth();
  assert.deepEqual(get(currentUserStore), user);
  assert.equal(get(userDisplayNameStore), 'Fixture');
  assert.equal(policyLoads, 1);
  assert.deepEqual(requests, ['/api/auth/me']);
  assert.equal(state.isAuthenticated, true);

  statusStore.set({ identity: { name: 'Fixture' } });
  await state.handleApiAuthFailure({ detail: { status: 401 } });
  assert.equal(get(statusStore), null);
  assert.equal(get(currentUserStore), null);
  assert.equal(state.isAuthenticated, false);

  user = { id: 'guest', username: 'visitor', role: 'anonymous', metadata: { sourceProfile: 'fixture' } };
  await state.checkAuth();
  assert.deepEqual(get(currentUserStore), user, 'guest restoration uses the same published session');
  assert.equal(get(userDisplayNameStore), 'Guest: fixture');
  user = null;
  statusStore.set({ identity: { name: 'Previous profile' } });
  await state.checkAuth();
  assert.equal(get(currentUserStore), null, 'failed restoration must not retain the previous user');
  assert.equal(state.isAuthenticated, false);
  assert.equal(get(statusStore), null, 'failed restoration must not retain the previous status');
  encryptionLocked = true;
  statusStore.set({ identity: { name: 'Previous profile' } });
  const clearedBefore = policyClears;
  await state.checkAuth();
  assert.match(state.error, /encrypted storage is locked/);
  assert.equal(get(currentUserStore), null);
  assert.equal(get(statusStore), null);
  assert.equal(policyClears, clearedBefore + 1, 'locked profiles must clear the previous policy too');
  networkFailure = true;
  await state.checkAuth();
  assert.equal(get(currentUserStore), null);
  assert.equal(state.isCheckingAuth, false);
});

test('optional login sync failure remains visible through the existing notice owner after verified app admission', async () => {
  let restored = true;
  const notices: { delay: number; authenticated: boolean }[] = [];
  const state = authHandlers(['clearSessionState', 'checkAuth', 'storeSession', 'handleApiAction', 'handleLogin'], {
    apiFetch: async (url: string) => url === '/api/auth/login'
      ? Response.json({ success: true, user: { username: 'fixture' } })
      : url === '/api/persona-core' ? Response.json({ persona: { identity: { name: 'Fixture' } } })
        : Response.json({ user: restored ? { username: 'fixture', role: 'owner' } : null }, { status: restored ? 200 : 401 }),
    fetchSecurityPolicy: async () => {}, clearSecurityPolicy() {}, currentUserStore: { set() {} }, statusStore: { set() {} },
    selectLoginMachine: () => true, isMobileApp: () => false, canSyncOnLogin: async () => true,
    getRemoteSyncConfig: async () => { throw new Error('Sync configuration unavailable'); },
    setTimeout: (_callback: () => void, delay: number) => { notices.push({ delay, authenticated: state.isAuthenticated }); return notices.length; },
    clearTimeout() {}, CustomEvent,
    window: { location: { reload() { throw new Error('Normal login must retain its notice owner'); } } },
    username: 'fixture', password: 'fixture-password', error: '', loading: false, isAuthenticated: false, isCheckingAuth: false,
    successMessage: '', showSyncHint: false, apiActionNotice: null, apiActionNoticeTimer: null,
  });
  await state.handleLogin({ preventDefault() {} });
  assert.equal(state.isAuthenticated, true);
  assert.equal(state.apiActionNotice.state, 'error');
  assert.match(state.apiActionNotice.message, /Sync configuration unavailable/);
  assert.match(state.apiActionNotice.message, /Use Sync Manager to retry/);
  assert.deepEqual(notices, [{ delay: 6000, authenticated: true }], 'the existing notice lifetime begins after app admission');
  restored = false;
  await state.handleLogin({ preventDefault() {} });
  assert.equal(state.isAuthenticated, false);
  assert.equal(state.successMessage, '');
  assert.match(state.error, /session could not be restored/);
  assert.match(state.error, /Sync configuration unavailable/);
});

test('both reachable registration flows use Core and persist sessions only for mobile', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const stored: string[] = [];
  let mobile = false;
  let reject = false;
  let reloads = 0;
  const state = authHandlers(['storeSession', 'reloadApp', 'createAccount', 'handleRegister', 'handleOfflineLogin'], {
    apiFetch: async (url: string, options: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(options.body)) });
      return Response.json(reject ? { success: false, error: 'Username already exists' }
        : { success: true, sessionId: 'fixture-session', user: { username: 'fixture' } }, { status: reject ? 409 : 201 });
    },
    isMobileApp: () => mobile,
    localStorage: { setItem: (_key: string, value: string) => { stored.push(value); } },
    window: { location: { reload() { reloads++; } } },
    username: 'fixture', password: 'fixture-password', confirmPassword: 'fixture-password', displayName: 'Fixture', email: 'fixture@example.invalid',
    agreeToTerms: true, agreeToEthicalUse: true, error: '', loading: false, isAuthenticated: false, view: 'register',
  });
  await state.handleRegister({ preventDefault() {} });
  assert.equal(requests[0].url, '/api/auth/register');
  assert.deepEqual(requests[0].body, { username: 'fixture', password: 'fixture-password', displayName: 'Fixture', email: 'fixture@example.invalid' });
  assert.equal(state.view, 'post-register');
  assert.equal(reloads, 0, 'normal registration keeps the onboarding choice');
  assert.deepEqual(stored, [], 'web sessions remain in the server cookie');

  mobile = true;
  state.isAuthenticated = false;
  state.view = 'register';
  await state.handleRegister({ preventDefault() {} });
  assert.equal(JSON.parse(stored[0]).sessionId, 'fixture-session', 'post-registration mobile onboarding needs the same session persistence');
  state.view = 'sync-prompt';
  state.isAuthenticated = false;
  await state.handleOfflineLogin();
  assert.equal(requests.at(-1)!.body.email, undefined);
  assert.equal(reloads, 1);
  assert.equal(state.isAuthenticated, false, 'the reloaded Core session check owns app admission');

  reject = true;
  await state.handleOfflineLogin();
  assert.equal(state.error, 'User already exists locally. Try logging in normally.');
  assert.equal(state.view, 'login');
  assert.equal(reloads, 1);
  assert.equal(state.loading, false);
  const before = requests.length;
  state.agreeToTerms = false;
  await state.handleRegister({ preventDefault() {} });
  assert.equal(requests.length, before, 'the existing registration agreement checks remain');
});

test('profile bootstrap retains its finite sync owner and cannot claim success before the memory result', async () => {
  const calls: string[] = [];
  let complete = false;
  let reloads = 0;
  const state = authHandlers(['storeSession', 'reloadApp', 'handleSyncFromServer'], {
    apiFetch: async (url: string, options: RequestInit) => {
      calls.push(url);
      assert.equal(JSON.parse(String(options.body)).serverUrl, 'https://source.example.invalid');
      return Response.json({ success: true, sessionId: 'fixture-session' });
    },
    normalizeUrl: (url: string) => url.replace(/\/$/, ''), isMobileApp: () => false,
    runProfileSyncAgent: async (args: string[], progress: (value: { message: string }) => void) => {
      assert.equal(args.join(','), '--full,--skip-config');
      progress({ message: 'Importing memory' });
      return { success: complete, error: complete ? undefined : 'Memory transfer incomplete' };
    },
    window: { location: { reload() { reloads++; } } },
    username: 'fixture', password: 'fixture-password', syncServerUrl: 'https://source.example.invalid/',
    syncLoading: false, isAuthenticated: false, error: '', successMessage: '',
  });
  await state.handleSyncFromServer();
  assert.equal(calls[0], '/api/auth/sync-user');
  assert.match(state.error, /PROFILE IMPORTED, BUT SYNC INCOMPLETE/);
  assert.equal(reloads, 0);
  assert.equal(state.syncLoading, false);
  complete = true;
  await state.handleSyncFromServer();
  assert.equal(reloads, 1);
  assert.match(state.successMessage, /completed memory sync/);
  assert.equal(state.isAuthenticated, false);
});

test('password recovery preserves its validation and reports the Core result without a delayed callback', async () => {
  const requests: Record<string, unknown>[] = [];
  const notices: string[] = [];
  const state = authHandlers(['handlePasswordReset'], {
    apiFetch: async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)));
      return Response.json({ success: true });
    },
    alert: (message: string) => notices.push(message),
    setTimeout() { throw new Error('Password-reset feedback must not outlive the view on a timer'); },
    username: 'fixture', recoveryCode: ' code-123 ', newPassword: 'new-password', confirmNewPassword: 'new-password', loading: false, error: '', view: 'forgot-password',
  });
  await state.handlePasswordReset({ preventDefault() {} });
  assert.deepEqual(requests[0], { username: 'fixture', recoveryCode: 'CODE-123', newPassword: 'new-password' });
  assert.equal(state.view, 'login');
  assert.equal(state.username, '');
  assert.equal(state.loading, false);
  assert.equal(notices.length, 1);
});

test('expired authentication still clears Core and UI state when browser session storage is unavailable', async () => {
  const requests: string[] = [];
  const cleared: string[] = [];
  const state = authHandlers(['clearSessionState', 'clearStoredSession', 'clearServerSessionCookie', 'handleApiAuthFailure'], {
    currentUserStore: { set(value: unknown) { assert.equal(value, null); cleared.push('user'); } },
    statusStore: { set(value: unknown) { assert.equal(value, null); cleared.push('status'); } },
    clearSecurityPolicy() { cleared.push('policy'); },
    localStorage: { removeItem() { throw new Error('Storage denied'); } },
    apiFetch: async (url: string) => { requests.push(url); return Response.json({ success: true }); },
    isAuthenticated: true, isCheckingAuth: false, handlingAuthFailure: false, error: '', view: 'login',
  });
  await state.handleApiAuthFailure();
  assert.deepEqual(cleared, ['user', 'status', 'policy']);
  assert.deepEqual(requests, ['/api/auth/logout']);
  assert.equal(state.isAuthenticated, false);
  assert.equal(state.handlingAuthFailure, false);
  assert.match(state.error, /saved browser session could not be removed/);
});

test('mount owns auth/action listeners and its feedback timer through repeated teardown', () => {
  const windowFixture = Object.assign(new EventTarget(), {
    location: { href: 'http://localhost:4321/' }, history: { state: null, replaceState() {} },
  });
  const timers = new Map<number, () => void>();
  let mounted!: () => () => void;
  let timerId = 0;
  let authChecks = 0;
  const state = authHandlers(['handleApiAction'], {
    window: windowFixture, apiActionNotice: null, apiActionNoticeTimer: null,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  Object.assign(state, { onMount: (callback: typeof mounted) => { mounted = callback; }, URL,
    isHostedUi: () => false, getApiBaseUrl: () => '', checkAuth: () => { authChecks++; }, handleApiAuthFailure() {},
  });
  const hook = source.statements.filter(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(source) === 'onMount');
  vm.runInContext(ts.transpileModule(hook.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, state);
  for (let cycle = 0; cycle < 2; cycle++) {
    const release = mounted();
    assert.equal(getEventListeners(windowFixture, 'mh:api-auth-failure').length, 1);
    assert.equal(getEventListeners(windowFixture, 'mh:api-action').length, 1);
    windowFixture.dispatchEvent(new CustomEvent('mh:api-action', { detail: { state: 'success', message: 'Saved' } }));
    assert.equal(timers.size, 1);
    release();
    assert.equal(getEventListeners(windowFixture, 'mh:api-auth-failure').length, 0);
    assert.equal(getEventListeners(windowFixture, 'mh:api-action').length, 0);
    assert.equal(timers.size, 0);
  }
  assert.equal(authChecks, 2);
});

// The guest chooser is AuthGate's immediate child and shares this handler suite.
const selector = readFileSync(new URL('./ProfileSelector.svelte', import.meta.url), 'utf8');
const selectorSource = ts.createSourceFile('ProfileSelector.ts', selector.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);

// Reuse MemoryControls/PersonaEditor's compiled render approach. Only initial
// fixture data changes; the actual template, branches and handlers stay intact.
function renderProfileSelector(values: Record<string, unknown>): string {
  let component = selector;
  const offset = selector.indexOf(selectorSource.text);
  const declarations = selectorSource.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
  for (const node of declarations.reverse()) {
    const name = node.name.getText(selectorSource);
    if (node.initializer && Object.hasOwn(values, name)) {
      component = component.slice(0, offset + node.initializer.getStart(selectorSource)) + JSON.stringify(values[name])
        + component.slice(offset + node.initializer.end);
    }
  }
  const componentRequire = createRequire(import.meta.url);
  const code = ts.transpileModule(compile(component, { filename: 'ProfileSelector.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id === 'svelte' ? { onMount() {} }
    : id === '../lib/client/api-config' ? { apiFetch() { assert.fail('Rendering must not issue requests'); } } : componentRequire(id) });
  vm.runInContext(code, context);
  return componentRequire('svelte/server').render(context.exports.default).body;
}

test('guest selection errors render alongside known choices, while failed listing cannot claim an empty result', () => {
  const html = renderProfileSelector({ loading: false, error: 'Profile is not public', profiles: [
    { username: 'public-fixture', displayName: 'Public fixture' },
    { username: 'second-fixture', displayName: 'Second fixture' },
  ] });
  assert.match(html, /Profile is not public/);
  assert.match(html, /Public fixture/);
  assert.match(html, /Second fixture/);
  assert.doesNotMatch(html, /No Public Profiles/);
  const failure = renderProfileSelector({ loading: false, error: 'Storage unavailable' });
  assert.match(failure, /Storage unavailable/);
  assert.doesNotMatch(failure, /No Public Profiles/);
  assert.match(renderProfileSelector({ loading: false }), /No Public Profiles/);
});

test('guest profile listing preserves Core data and reports HTTP and transport failures', async () => {
  const profiles = [{ username: 'public-fixture', displayName: 'Public fixture' },
    { username: 'mutant-super-intelligence', displayName: 'Mutant Super Intelligence' }];
  for (const { result, expectedProfiles, error } of [
    { result: Response.json({ success: true, profiles }), expectedProfiles: profiles, error: '' },
    { result: Response.json({ success: true, profiles: [] }), expectedProfiles: [], error: '' },
    { result: Response.json({ error: 'Storage unavailable' }, { status: 503 }), expectedProfiles: [], error: 'Storage unavailable' },
    { result: new Error('Connection lost'), expectedProfiles: [], error: 'Connection lost' },
  ]) {
    const state = authHandlers(['fetchProfiles', 'getInitials'], {
      apiFetch: async (url: string) => {
        assert.equal(url, '/api/profiles/list');
        if (result instanceof Error) throw result;
        return result;
      }, profiles: [], loading: true, error: '',
    }, selectorSource);
    await state.fetchProfiles();
    assert.equal(state.loading, false);
    assert.equal(state.getInitials('Public fixture'), 'PF');
    assert.equal(state.error, error);
    assert.deepEqual(Array.from(state.profiles), expectedProfiles);
  }
});

test('guest selection retains its choices on failure and navigates only after one acknowledged selection', async () => {
  const calls: string[] = [];
  let finish!: (response: Response) => void;
  const profiles = [{ username: 'public-fixture', displayName: 'Public fixture' },
    { username: 'mutant-super-intelligence', displayName: 'Mutant Super Intelligence' }];
  const state = authHandlers(['selectProfile'], {
    apiFetch: async (url: string, options: RequestInit) => {
      assert.equal(url, '/api/profiles/select');
      assert.equal(options.method, 'POST');
      calls.push(JSON.parse(String(options.body)).username);
      return new Promise<Response>(resolve => { finish = resolve; });
    }, profiles, selecting: false, error: '', window: { location: { href: '/login' } },
  }, selectorSource);
  const failed = state.selectProfile('public-fixture');
  await state.selectProfile('mutant-super-intelligence');
  assert.equal(calls.length, 1, 'the existing selection exclusion must cover another row');
  assert.equal(state.window.location.href, '/login');
  finish(Response.json({ error: 'Profile is not public' }, { status: 403 }));
  await failed;
  assert.equal(state.error, 'Profile is not public');
  assert.equal(state.selecting, false);
  assert.equal(state.profiles, profiles);
  const httpFailure = state.selectProfile('public-fixture');
  finish(Response.json({ success: true, error: 'Selection failed' }, { status: 500 }));
  await httpFailure;
  assert.equal(state.window.location.href, '/login', 'an HTTP failure cannot acknowledge a selection');
  assert.equal(state.error, 'Selection failed');
  const success = state.selectProfile('mutant-super-intelligence');
  finish(Response.json({ success: true }));
  await success;
  assert.equal(calls.at(-1), 'mutant-super-intelligence');
  assert.equal(state.window.location.href, '/');
  assert.equal(state.selecting, true, 'successful selection stays excluded until document navigation');
  assert.equal(state.error, '');
});


test('restoration releases the previous mounted session before awaiting and publishing its verified replacement', async () => {
  const { get, writable } = await import('svelte/store');
  const currentUserStore = writable<unknown>({ id: 'old-user', username: 'old', role: 'owner' });
  const statusStore = writable<unknown>({ identity: 'old status' });
  let finish!: (response: Response) => void;
  const state = authHandlers(['clearSessionState', 'checkAuth'], { currentUserStore, statusStore,
    isAuthenticated: true, isCheckingAuth: true, error: '',
    clearSecurityPolicy() {}, fetchSecurityPolicy: async () => {},
    apiFetch: async () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = state.checkAuth();
  assert.equal(get(currentUserStore), null);
  assert.equal(get(statusStore), null);
  assert.equal(state.isAuthenticated, false, 'the previous app subtree is released while verification is pending');
  const replacement = { id: 'new-user', username: 'new', role: 'standard' };
  finish(Response.json({ success: true, user: replacement }));
  await pending;
  assert.deepEqual(get(currentUserStore), replacement);
  assert.equal(state.isAuthenticated, true);
});
