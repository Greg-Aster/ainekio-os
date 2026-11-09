import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { get, writable } from 'svelte/store';

// Reuse the established actual-handler and compiled-render component tests.
function handlers(file: string, extra: Record<string, unknown> = {}) {
  const component = readFileSync(new URL(file, import.meta.url), 'utf8');
  const source = ts.createSourceFile(file, component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const state = vm.createContext({ Error, console: { error() {} }, loading: false, error: '', success: '',
    currentUser: { id: 'fixture-id', username: 'fixture', role: 'owner', metadata: { displayName: 'Old', email: 'old@example.invalid' } },
    currentUserStore: { update(update: (user: unknown) => unknown) { state.sharedUser = update(state.currentUser); } }, statusRefreshTrigger: { update() {} },
    newDisplayName: '', newEmail: '', showChangeProfile: true, profileChanging: false, newUsername: 'renamed', usernamePassword: 'fixture-password',
    showChangeUsername: true, usernameChanging: false, window: { location: { href: '', assign(value: string) { state.destination = value; } } },
    setTimeout() { assert.fail('Account receipts must not trigger unowned timers'); }, ...extra });
  vm.runInContext(code, state);
  return state;
}

test('profile update uses canonical PUT, clears explicit empty fields and keeps failed drafts for retry', async () => {
  const requests: RequestInit[] = [];
  let fail = true;
  const state = handlers('./SecuritySettings.svelte', { async apiFetch(url: string, options: RequestInit) {
    assert.equal(url, '/api/auth/update-profile'); requests.push(options);
    if (options.method !== 'PUT') return Response.json({ error: 'Wrong method' }, { status: 404 });
    return Response.json(fail ? { error: 'Profile unavailable' } : { success: true, user: { ...state.currentUser, metadata: { displayName: '', email: '' } } }, { status: fail ? 503 : 200 });
  } });
  await state.handleChangeProfile();
  assert.equal(state.error, 'Profile unavailable');
  assert.equal(state.showChangeProfile, true);
  fail = false; await state.handleChangeProfile();
  assert.equal(state.showChangeProfile, false);
  assert.equal(state.currentUser.metadata.email, '');
  assert.equal(state.sharedUser.metadata.displayName, '');
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.body)), { displayName: '', email: '' });
});

test('username submits the password already required by Core and clears it only after acknowledgement/cancel', async () => {
  const requests: any[] = [];
  let fail = true;
  const state = handlers('./SecuritySettings.svelte', { async apiFetch(url: string, options: RequestInit) {
    requests.push(JSON.parse(String(options.body)));
    if (!requests.at(-1).password) return Response.json({ error: 'New username and password are required' }, { status: 400 });
    return Response.json(fail ? { error: 'Password is incorrect' } : { success: true, username: 'renamed' }, { status: fail ? 401 : 200 });
  } });
  await state.handleChangeUsername();
  assert.equal(state.error, 'Password is incorrect');
  assert.equal(state.usernamePassword, 'fixture-password');
  fail = false; await state.handleChangeUsername();
  assert.equal(state.currentUser.username, 'renamed');
  assert.equal(state.usernamePassword, '');
  assert.equal(state.sharedUser.username, 'renamed');
  assert.deepEqual(requests[0], { newUsername: 'renamed', password: 'fixture-password' });
  state.usernamePassword = 'another draft'; state.cancelChangeUsername();
  assert.equal(state.usernamePassword, '');
});


test('settings consume the verified mounted account without restoring authentication independently', async () => {
  const calls: string[] = [];
  const state = handlers('./SecuritySettings.svelte', { currentUser: null, async apiFetch(url: string) {
    calls.push(url);
    if (url === '/api/profiles/visibility') return Response.json({ success: true, visibility: 'private' });
    if (url === '/api/recovery-codes') return Response.json({ success: true, codes: [] });
    assert.fail('A standard account has no owner settings to load: ' + url);
  } });
  await state.loadSettings(); assert.deepEqual(calls, []);
  state.currentUser = { id: 'fixture-id', username: 'fixture', role: 'standard' };
  await state.loadSettings();
  assert.deepEqual(calls, ['/api/profiles/visibility', '/api/recovery-codes']);
  assert.equal(state.profileVisibility, 'private');
});

test('failed settings reads remain unknown with their actual errors, and explicit retries load actual values', async () => {
  let fail = true;
  const state = handlers('./SecuritySettings.svelte', { profileVisibility: null, recoveryCodes: null, trustLevel: null,
    includePersonaSummary: null, trustCoupled: null, async apiFetch(url: string) {
      if (fail) return Response.json({ error: 'Read unavailable: ' + url }, { status: 503 });
      if (url === '/api/profiles/visibility') return Response.json({ success: true, visibility: 'public' });
      if (url === '/api/recovery-codes') return Response.json({ success: true, codes: ['dummy-only-code'] });
      if (url === '/api/trust') return Response.json({ level: 'bounded_auto', available: ['observe', 'bounded_auto'] });
      if (url === '/api/agent-config') return Response.json({ success: true, config: { includePersonaSummary: false } });
      return Response.json({ success: true, coupled: false, mappings: { environment: 'bounded_auto' }, descriptions: { environment: 'Configured description' } });
    } });
  const cases = [['fetchVisibility', 'profileVisibility', 'visibilityError'], ['loadRecoveryCodes', 'recoveryCodes', 'recoveryError'],
    ['loadTrustLevel', 'trustLevel', 'trustError'], ['loadAgentConfig', 'includePersonaSummary', 'personaSummaryError'], ['loadTrustCoupling', 'trustCoupled', 'couplingError']];
  for (const [load, value, error] of cases) { await state[load](); assert.equal(state[value], null); assert.match(state[error], /Read unavailable/); }
  fail = false;
  for (const [load, , error] of cases) { await state[load](); assert.equal(state[error], ''); }
  assert.equal(state.trustLevel, 'bounded_auto'); assert.equal(state.includePersonaSummary, false); assert.equal(state.trustCoupled, false);
  assert.equal(state.couplingMappings.environment, 'bounded_auto');
});

test('rejected native trust, visibility and checkbox changes revert to the last acknowledged setting', async () => {
  let fail = true;
  let refreshes = 0;
  const state = handlers('./SecuritySettings.svelte', { trustLevel: 'observe', profileVisibility: 'private', trustCoupled: true,
    includePersonaSummary: true, statusRefreshTrigger: { update() { refreshes++; } }, async apiFetch(url: string, options: RequestInit) {
      if (fail) return Response.json({ error: 'Setting rejected' }, { status: 403 });
      const body = JSON.parse(String(options.body));
      if (url === '/api/trust') return Response.json({ ok: true, level: 'bounded_auto' });
      if (url === '/api/profiles/visibility') return Response.json({ success: true, visibility: body.visibility });
      if (url === '/api/agent-config') return Response.json({ success: true, config: { includePersonaSummary: body.includePersonaSummary } });
      return Response.json({ success: true, coupled: body.coupled, mappings: { environment: 'suggest' } });
    } });
  const trust = { target: { value: 'adaptive_auto' } }, visibility = { target: { value: 'public' } };
  const coupling = { target: { checked: false } }, persona = { target: { checked: false } };
  await state.handleTrustLevelChange(trust); await state.saveVisibility(visibility);
  await state.handleCouplingToggle(coupling); await state.handlePersonaSummaryToggle(persona);
  assert.equal(trust.target.value, 'observe'); assert.equal(visibility.target.value, 'private');
  assert.equal(coupling.target.checked, true); assert.equal(persona.target.checked, true); assert.equal(refreshes, 0);
  fail = false; trust.target.value = 'adaptive_auto'; visibility.target.value = 'public'; coupling.target.checked = false; persona.target.checked = false;
  await state.handleTrustLevelChange(trust); await state.saveVisibility(visibility);
  await state.handleCouplingToggle(coupling); await state.handlePersonaSummaryToggle(persona);
  assert.equal(state.trustLevel, 'bounded_auto', 'display the actual response level rather than a predicted value');
  assert.equal(state.profileVisibility, 'public'); assert.equal(state.trustCoupled, false); assert.equal(state.includePersonaSummary, false);
  assert.equal(refreshes, 3);
});

test('password and recovery/reset confirmation preserve their canonical request contracts', async () => {
  const calls: { url: string; body: any }[] = [];
  let fail = true;
  const state = handlers('./SecuritySettings.svelte', { currentPassword: 'old-password', newPassword: '12345', confirmPassword: '12345',
    passwordChanging: false, showChangePassword: true, regeneratingCodes: false, showRegenerateConfirm: true, recoveryCodes: ['previous-dummy-code'],
    resettingFactory: false, resetUsername: 'wrong', resetError: '', resetComplete: false,
    async apiFetch(url: string, options: RequestInit) {
      calls.push({ url, body: options.body ? JSON.parse(String(options.body)) : undefined });
      return Response.json(fail ? { error: 'Action unavailable' } : { success: true, codes: ['new-dummy-code'] }, { status: fail ? 503 : 200 });
    } });
  await state.handleChangePassword(); assert.equal(calls.length, 0); assert.match(state.error, /at least 6/);
  state.newPassword = state.confirmPassword = 'new-password'; await state.handleChangePassword();
  assert.equal(state.currentPassword, 'old-password'); assert.equal(state.showChangePassword, true);
  await state.handleRegenerateCodes(); assert.deepEqual(Array.from(state.recoveryCodes), ['previous-dummy-code']);
  await state.resetFactorySettings(); assert.equal(calls.length, 2, 'unconfirmed reset is not sent');
  state.resetUsername = 'fixture'; await state.resetFactorySettings(); assert.equal(state.resetComplete, false);
  assert.deepEqual(calls.at(-1)!.body, { confirmToken: 'CONFIRM_FACTORY_RESET', confirmUsername: 'fixture' });
  fail = false; await state.handleChangePassword(); await state.handleRegenerateCodes(); await state.resetFactorySettings();
  assert.equal(state.currentPassword, ''); assert.equal(state.newPassword, ''); assert.equal(state.confirmPassword, '');
  assert.deepEqual(Array.from(state.recoveryCodes), ['new-dummy-code']); assert.equal(state.showRecoveryCodes, true);
  assert.equal(state.resetComplete, true); assert.equal(state.resetUsername, '');
});

const profile = (username: string, role = 'standard') => ({ username, role, displayName: username, visibility: 'private' });

test('Danger Zone retains deletion policy, confirmation and standard-account filtering without a second auth reader', async () => {
  const calls: string[] = [];
  const state = handlers('./ProfileDangerZone.svelte', { profiles: [], currentUser: { username: 'fixture', role: 'standard' },
    async apiFetch(url: string) { calls.push(url); return Response.json({ success: true, profiles: [profile('fixture'), profile('someone'), profile('mutant-super-intelligence', 'guest')] }); } });
  await state.loadProfiles(); assert.deepEqual(calls, ['/api/profiles/list']); assert.deepEqual(Array.from(state.profiles, (p: any) => p.username), ['fixture']);
  assert.equal(state.getDeleteDisabledReason(profile('fixture')), null);
  assert.match(state.getDeleteDisabledReason(profile('someone')), /own account/);
  state.currentUser = { username: 'owner', role: 'owner' };
  assert.match(state.getDeleteDisabledReason(profile('owner', 'owner')), /owner/);
  assert.match(state.getDeleteDisabledReason(profile('guest', 'guest')), /guest/);
  assert.equal(state.getDeleteDisabledReason(profile('someone')), null);
  state.currentUser = { username: 'guest', role: 'guest' }; assert.match(state.getDeleteDisabledReason(profile('someone')), /Guests/);
  state.openDeleteModal(profile('someone')); state.confirmUsername = 'different'; await state.handleDelete();
  assert.equal(calls.length, 1); assert.equal(state.showDeleteModal, true); assert.match(state.error, /does not match/);
  state.closeDeleteModal(); assert.equal(state.confirmUsername, ''); assert.equal(state.profileToDelete, null);
});

test('deletion acknowledgement retires its row and keeps refresh failure visible alongside success', async () => {
  let fail = true;
  const calls: string[] = [];
  const state = handlers('./ProfileDangerZone.svelte', { profiles: [profile('someone'), profile('retained')], deleting: false,
    async apiFetch(url: string, options: RequestInit) {
      calls.push(url);
      if (url.endsWith('/list')) return Response.json({ error: 'Refresh unavailable' }, { status: 503 });
      assert.deepEqual(JSON.parse(String(options.body)), { username: 'someone', confirmUsername: 'someone' });
      return Response.json(fail ? { error: 'Delete unavailable' } : { success: true, details: { username: 'someone', sessionsDeleted: 2 } }, { status: fail ? 503 : 200 });
    } });
  state.openDeleteModal(profile('someone')); state.confirmUsername = 'someone'; await state.handleDelete();
  assert.equal(state.showDeleteModal, true); assert.equal(state.confirmUsername, 'someone'); assert.equal(state.profiles.length, 2);
  fail = false; await state.handleDelete();
  assert.equal(state.showDeleteModal, false); assert.equal(state.profileToDelete, null);
  assert.deepEqual(Array.from(state.profiles, (p: any) => p.username), ['retained']);
  assert.match(state.success, /someone.*2 session/); assert.equal(state.error, 'Refresh unavailable');
  assert.deepEqual(calls, ['/api/profiles/delete', '/api/profiles/delete', '/api/profiles/list']);
});

test('acknowledged standard self deletion navigates immediately without reloading profiles or scheduling work', async () => {
  const calls: string[] = [];
  const state = handlers('./ProfileDangerZone.svelte', { currentUser: { username: 'fixture', role: 'standard' }, profiles: [profile('fixture')],
    async apiFetch(url: string) { calls.push(url); return Response.json({ success: true, details: { username: 'fixture', sessionsDeleted: 1 } }); } });
  state.openDeleteModal(profile('fixture')); state.confirmUsername = 'fixture'; await state.handleDelete();
  assert.equal(state.destination, '/'); assert.equal(state.profiles.length, 0); assert.deepEqual(calls, ['/api/profiles/delete']);
});

function render(file: string, locals: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  function component(url: URL, initial: Record<string, unknown> = {}) {
    let source = readFileSync(url, 'utf8');
    for (const [name, value] of Object.entries(initial)) {
      source = source.replace(new RegExp(`(let ${name}(?:\\s*:[^=;]+)? = )[^;]+;`), `$1${JSON.stringify(value)};`);
    }
    const output = ts.transpileModule(compile(source, { filename: url.pathname, generate: 'server' }).js.code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const ownerRequire = createRequire(url);
    const context = vm.createContext({ exports: {}, require(id: string) {
      if (id.endsWith('stores/navigation')) return { ...ownerRequire(id), currentUserStore: writable(initial.currentUser ?? null) };
      if (id.includes('api-config')) return { apiFetch() { assert.fail('Rendering must not perform account operations'); } };
      if (id.endsWith('.svelte')) return { default: component(new URL(id, url)) };
      return ownerRequire(id);
    } });
    vm.runInContext(output, context);
    return context.exports.default;
  }
  return createRequire(import.meta.url)('svelte/server').render(component(new URL(file, import.meta.url), locals), { props }).body;
}

test('compiled signed-out/settings-failure views follow the session owner without presenting fabricated settings', () => {
  const failed = render('./SecuritySettings.svelte');
  assert.match(failed, /Authentication Required/); assert.match(failed, /Go to Login/);
  assert.doesNotMatch(failed, /Account Information|Retry loading account/);
  const owner = render('./SecuritySettings.svelte', { loading: false, currentUser: { id: 'fixture-id', username: 'fixture', role: 'owner' },
    visibilityLoading: false, recoveryCodesLoading: false, trustLoading: false, personaSummaryLoading: false, couplingLoading: false,
    visibilityError: 'Visibility unavailable', recoveryError: 'Codes unavailable', trustError: 'Trust unavailable',
    personaSummaryError: 'Summary unavailable', couplingError: 'Coupling unavailable' });
  for (const label of ['visibility', 'recovery codes', 'trust level', 'persona summary', 'trust coupling']) assert.match(owner, new RegExp('Retry loading ' + label));
  assert.match(owner, /Regenerate All Codes/);
  assert.doesNotMatch(owner, /0 of 10 codes|No Recovery Codes Available|id="trustLevel"/);
  assert.match(owner, /Open Network settings/); assert.doesNotMatch(owner, /Enable Tunnel|Checking tunnel/);
  assert.match(owner, /Clearing this browser’s cookies signs out this browser/);
});

test('compiled Danger view keeps committed deletion and refresh error visible together with retained profiles and retry', () => {
  const html = render('./ProfileDangerZone.svelte', { loading: false, error: 'Refresh unavailable',
    success: "Profile 'deleted' has been deleted successfully. 2 session(s) terminated.", profiles: [profile('retained')] },
    { currentUser: { username: 'fixture', role: 'owner' } });
  assert.match(html, /Refresh unavailable/); assert.match(html, /deleted successfully/); assert.match(html, /retained/);
  assert.match(html, /Retry loading profiles/); assert.doesNotMatch(html, /setTimeout/);
});


test('late username/metadata receipts cannot replace a logged-out or newly authenticated user', async () => {
  for (const action of ['username', 'metadata']) for (const replacement of ['logout', 'other', 'same-account-new-session']) {
    const account = { id: 'original-id', username: 'original', role: 'owner', metadata: { displayName: 'Original' } };
    const store = writable<typeof account | null>(account);
    let finish!: (response: Response) => void;
    const state = handlers('./SecuritySettings.svelte', { currentUser: account, currentUserStore: store,
      async apiFetch() { return new Promise(resolve => { finish = resolve; }); } });
    const pending = action === 'username' ? state.handleChangeUsername() : state.handleChangeProfile();
    const next = replacement === 'logout' ? null : { id: replacement === 'other' ? 'other-id' : account.id,
      username: 'fresh-session', role: 'standard', metadata: { displayName: 'Fresh session' } };
    const expected = structuredClone(next);
    store.set(next); state.currentUser = next;
    finish(Response.json({ success: true, username: 'late-name', user: { ...account, metadata: { displayName: 'Late metadata' } } }));
    await pending;
    assert.equal(get(store), next);
    assert.deepEqual(get(store), expected, 'a completed old-session write must not publish its captured account');
  }
});

test('concurrent account-field acknowledgements preserve both changes without replacing the verified session object', async () => {
  for (const first of ['username', 'metadata']) {
    const account = { id: 'fixture-id', username: 'fixture', role: 'owner', metadata: { displayName: 'Old' } };
    const store = writable(account);
    const finish: Record<string, (response: Response) => void> = {};
    const state = handlers('./SecuritySettings.svelte', { currentUser: account, currentUserStore: store,
      async apiFetch(url: string) { return new Promise(resolve => { finish[url.endsWith('/change-username') ? 'username' : 'metadata'] = resolve; }); } });
    const username = state.handleChangeUsername(), metadata = state.handleChangeProfile();
    const complete = (action: string) => finish[action](Response.json(action === 'username' ? { success: true, username: 'renamed' }
      : { success: true, user: { id: account.id, username: 'fixture', role: account.role, metadata: { displayName: 'Updated' } } }));
    complete(first); await (first === 'username' ? username : metadata);
    complete(first === 'username' ? 'metadata' : 'username'); await Promise.all([username, metadata]);
    assert.equal(get(store), account);
    assert.equal(get(store).username, 'renamed'); assert.equal(get(store).metadata.displayName, 'Updated');
  }
});


test('clipboard success and unavailable/denied clipboard report their actual outcome without clearing codes or scheduling notices', async () => {
  let copied = '';
  const state = handlers('./SecuritySettings.svelte', { recoveryCodes: ['dummy-one', 'dummy-two'], navigator: {
    clipboard: { async writeText(value: string) { copied = value; } } } });
  await state.copyAllCodesToClipboard(state.recoveryCodes);
  assert.equal(copied, 'dummy-one\ndummy-two'); assert.match(state.success, /copied/);
  state.navigator.clipboard.writeText = async () => { throw new Error('Clipboard permission denied'); };
  await state.copyAllCodesToClipboard(state.recoveryCodes);
  assert.equal(state.success, ''); assert.equal(state.error, 'Clipboard permission denied');
  state.navigator = {};
  await state.copyAllCodesToClipboard(state.recoveryCodes);
  assert.ok(state.error); assert.equal(state.success, '');
  assert.deepEqual(Array.from(state.recoveryCodes), ['dummy-one', 'dummy-two']);
});
