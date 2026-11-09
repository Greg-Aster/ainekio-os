import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readServerEvents } from '../lib/client/sse';

const text = readFileSync(new URL('./ProfileLocation.svelte', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ProfileLocation.ts', text.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function handlers(apiFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const state: vm.Context = vm.createContext({ JSON, Error, readServerEvents, apiFetch, disposed: false,
    reads: { config: 0, devices: 0, veraCrypt: 0, validation: 0 }, profileConfig: null, devices: [], devicePaths: {},
    loading: false, devicesLoading: false, checkingVeraCrypt: false, configError: '', devicesError: '', veraCryptError: '', veracryptStatus: null,
    error: '', success: '', validation: null, validating: false, customPath: '', migrationTarget: '', migrationProgress: [], migrationSuccess: true,
    migrating: false, showMigrationModal: false, encryptionType: 'none', keepSourceFiles: true, overwriteExisting: false, encryptionPassword: '', encryptionPasswordConfirm: '', useMigrationLoginPassword: false,
    encryptInPlaceReady: true, encryptInPlaceType: 'aes256', encryptInPlacePassword: 'fixture-password', encryptInPlacePasswordConfirm: 'fixture-password', useLoginPassword: false,
    encryptInPlaceProgress: [], decryptInPlaceProgress: [], encryptingInPlace: false, decryptingInPlace: false, decryptPassword: 'fixture-password', console: { error() {} } });
  vm.runInContext(code, state); return state;
}
const progress = (step: string, status: string, message = step) => ({ progress: { step, status, message } });
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(event => typeof event === 'string' ? `data: ${event}\r\n\r\n` : `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('profile reads expose independent failures without inventing no devices or missing VeraCrypt', async () => {
  let failure = true;
  const state = handlers(async url => failure ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(url.endsWith('/devices') ? { devices: [{ id: 'drive', suggestedPath: '/drive/profile' }] } : url.includes('veracrypt') ? { installed: true, platform: 'linux' } : { currentPath: '/profile', usingCustomPath: true }));
  await Promise.all([state.loadProfileConfig(), state.loadDevices(), state.checkVeraCryptStatus()]);
  assert.equal(state.configError, 'Unavailable'); assert.equal(state.devicesError, 'Unavailable'); assert.equal(state.veraCryptError, 'Unavailable'); assert.equal(Object.is(state.veracryptStatus, null), true);
  failure = false; await Promise.all([state.loadProfileConfig(), state.loadDevices(), state.checkVeraCryptStatus()]);
  assert.equal(state.profileConfig.usingCustomPath, true); assert.equal(state.veracryptStatus.installed, true); assert.equal(state.devicePaths.drive, '/drive/profile');
  state.devicePaths.drive = '/edited'; state.error = 'Operation failure';
  await state.loadDevices(); await state.loadProfileConfig();
  assert.equal(state.devicePaths.drive, '/edited'); assert.equal(state.error, 'Operation failure');
});

test('superseded and closed profile reads cannot publish; validation belongs to the requested path', async () => {
  const replies: Array<(response: Response) => void> = [];
  const state = handlers(() => new Promise(resolve => replies.push(resolve)));
  for (const [method, key, data] of [['loadProfileConfig', 'profileConfig', { currentPath: '/new' }], ['loadDevices', 'devices', { devices: [{ id: 'new' }] }], ['checkVeraCryptStatus', 'veracryptStatus', { installed: true }]] as const) {
    const index = replies.length; const old = state[method](); const current = state[method]();
    replies[index + 1](Response.json(data)); await current;
    const expected = JSON.stringify(state[key]); replies[index](Response.json({ error: 'Old failure' }, { status: 503 })); await old;
    assert.equal(JSON.stringify(state[key]), expected);
    const closed = state[method](); state.disposed = true;
    replies[index + 2](Response.json({ error: 'Closed failure' }, { status: 503 })); await closed;
    assert.equal(JSON.stringify(state[key]), expected); state.disposed = false;
  }
  state.customPath = '/first'; let index = replies.length; const validation = state.handleValidateCustomPath();
  state.customPath = '/second'; state.clearValidation();
  replies[index](Response.json({ valid: true, resolvedPath: '/first', errors: [], warnings: [] })); await validation;
  assert.equal(Object.is(state.validation, null), true);
  index = replies.length; const current = state.handleValidateCustomPath(); replies[index](Response.json({ valid: true, resolvedPath: '/second', errors: [], warnings: [] })); await current;
  assert.equal(state.validation.resolvedPath, '/second');
});

test('migration consumes real progress across chunks, surfaces malformed updates and resets completion on repeated runs', async () => {
  const calls: { url: string; init?: RequestInit }[] = []; let fail = false;
  const state = handlers(async (url, init) => { calls.push({ url, init }); return init ? stream(fail ? [progress('error', 'failed', 'Move failed')] : [progress('copy', 'running', 'Copy é'), '{bad json', progress('complete', 'completed')]) : Response.json({ currentPath: '/moved' }); });
  await state.startMigration('/destination');
  assert.equal(state.migrationSuccess, true); assert.equal(state.migrating, false); assert.equal(state.migrationProgress[0].message, 'Copy é'); assert.match(state.error, /Unable to read operation update/);
  assert.equal(state.profileConfig.currentPath, '/moved');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { path: '/destination', keepSource: true, overwrite: false });
  fail = true; await state.startMigration('/another');
  assert.equal(state.migrationSuccess, false); assert.equal(state.success, ''); assert.equal(state.error, 'Move failed'); assert.equal(state.migrationProgress.length, 1);
});

test('encryption and decryption use terminal results and independent progress, preserving actual request options', async () => {
  const calls: { url: string; body: any }[] = [];
  const state = handlers(async (url, init) => { calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return init ? stream([progress('complete', 'completed'), { result: { success: url.endsWith('/encrypt'), filesProcessed: 7, error: 'Decrypt failed' } }]) : Response.json({ currentPath: '/profile' }); });
  await state.encryptProfileInPlace();
  assert.match(state.success, /7 files/); assert.equal(state.encryptInPlacePassword, ''); assert.equal(state.encryptInPlaceProgress.length, 1);
  await state.decryptProfileInPlace();
  assert.equal(state.success, ''); assert.equal(state.error, 'Decrypt failed'); assert.equal(state.decryptPassword, '');
  assert.equal(state.encryptInPlaceProgress.length, 1); assert.equal(state.decryptInPlaceProgress.length, 1);
  assert.deepEqual(calls[0].body, { password: 'fixture-password', type: 'aes256', useLoginPassword: false });
  assert.deepEqual(calls.find(call => call.url.endsWith('/decrypt'))?.body, { password: 'fixture-password' });
});

test('closing the view does not cancel an admitted migration or publish its later profile read', async () => {
  let finish!: (response: Response) => void;
  let options: RequestInit | undefined;
  const state = handlers(async (_url, init) => {
    if (init) { options = init; return new Promise(resolve => { finish = resolve; }); }
    return Response.json({ currentPath: '/committed-after-close' });
  });
  const pending = state.startMigration('/destination');
  state.disposed = true;
  finish(stream([progress('complete', 'completed')])); await pending;
  assert.equal(options?.signal, undefined);
  assert.equal(state.migrationProgress[0].step, 'complete');
  assert.equal(state.migrating, false);
  assert.equal(Object.is(state.profileConfig, null), true);
});

test('EOF without the owner terminal event makes no success claim and does not invent an execution gate', async () => {
  const state = handlers(async (_url, init) => init ? stream([progress('copy', 'running')]) : Response.json({}));
  await state.startMigration('/destination');
  assert.equal(state.migrationSuccess, false); assert.equal(state.success, ''); assert.equal(state.migrating, false);
  await state.encryptProfileInPlace();
  assert.equal(state.success, ''); assert.equal(state.encryptingInPlace, false);
  await state.decryptProfileInPlace();
  assert.equal(state.success, ''); assert.equal(state.decryptingInPlace, false);
});

test('reset and existing-directory switch retain their actual methods, confirmation and write/read error separation', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let readFailure = true;
  const state = handlers(async (url, init) => {
    calls.push({ url, init });
    return init ? Response.json({ success: true }) : readFailure ? Response.json({ error: 'Refresh failed' }, { status: 503 }) : Response.json({ currentPath: '/existing' });
  });
  let prompt = ''; state.confirm = (message: string) => { prompt = message; return false; };
  await state.resetToDefault(); assert.equal(calls.length, 0);
  assert.equal(prompt, 'Reset profile location to default? This will only update the configuration, not move any files.');
  state.confirm = () => true; await state.resetToDefault();
  assert.equal(calls[0].init?.method, 'DELETE'); assert.equal(state.success, 'Profile location reset to default'); assert.equal(state.configError, 'Refresh failed');
  readFailure = false; await state.switchToLocation('/existing');
  const switched = calls.find(call => call.init?.method === 'PUT');
  assert.deepEqual(JSON.parse(String(switched?.init?.body)), { path: '/existing', type: 'external' });
  assert.equal(state.success, 'Switched to /existing'); assert.equal(state.profileConfig.currentPath, '/existing'); assert.equal(state.configError, '');
});
