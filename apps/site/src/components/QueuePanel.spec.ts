import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { get, writable } from 'svelte/store';

const text = readFileSync(new URL('./QueuePanel.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('QueuePanel.ts', text.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const base = () => ({ lifecycle: 'running', tasks: [], executions: [], paused: false, degraded: false, canConfirmRobotStopped: true });

function handlers(apiFetch: (url: string, init: RequestInit) => Promise<Response>) {
  const snapshots = writable<any>(base());
  const state = vm.createContext({ Error, Date, encodeURIComponent, apiFetch, coordinatorSnapshot: snapshots,
    busyAction: '', actionError: '', actionNotice: '', confirm: () => false });
  vm.runInContext(code, state);
  return { state, snapshots };
}

function component(url: URL, overrides: Record<string, unknown>) {
  const require = createRequire(url);
  const compiled = ts.transpileModule(compile(readFileSync(url, 'utf8'), { filename: url.pathname, generate: 'server' }).js.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const state = vm.createContext({ exports: {}, require(id: string) {
    if (id in overrides) return overrides[id];
    if (id.endsWith('.svelte')) return { default: component(new URL(id, url), overrides) };
    return require(id);
  } });
  vm.runInContext(compiled, state);
  return state.exports.default;
}

test('Queue renders actual transport/lifecycle rather than inventing startup or hiding reconnect/errors', () => {
  const stores = { coordinatorSnapshot: writable<any>(null), coordinatorConnection: writable('idle'), coordinatorError: writable(''), useWorkCoordinator: () => () => {} };
  const view = component(new URL('./QueuePanel.svelte', import.meta.url), { '../lib/stores/work-coordinator': stores,
    '../lib/client/api-config': { apiFetch() { assert.fail('Rendering is observation only'); } } });
  const render = () => createRequire(import.meta.url)('svelte/server').render(view).body;
  let html = render(); assert.match(html, /Coordinator state unavailable/); assert.match(html, /idle/);
  assert.doesNotMatch(html, /starting|reconnecting/);
  stores.coordinatorConnection.set('connecting'); assert.match(render(), /connecting/);
  stores.coordinatorError.set('Projection failed'); html = render(); assert.match(html, /Projection failed/);
  assert.match(html, /Coordinator state is unavailable/);
  stores.coordinatorSnapshot.set({ ...base(), lifecycle: 'paused', degraded: true, error: 'Runtime degraded' });
  stores.coordinatorConnection.set('reconnecting'); html = render();
  assert.match(html, /paused/); assert.match(html, /reconnecting/); assert.match(html, /last received coordinator/);
  assert.match(html, /Projection failed/); assert.match(html, /Runtime degraded/);
});

test('Queue keeps action acknowledgements local and leaves authoritative snapshots to the stream, including late responses', async () => {
  let finish!: (response: Response) => void;
  const calls: { url: string; init: RequestInit }[] = [];
  const { state, snapshots } = handlers(async (url, init) => { calls.push({ url, init }); return new Promise(resolve => { finish = resolve; }); });
  const pending = state.mutate('cancel:test', '/api/unified-queue/tasks/test', { method: 'DELETE' });
  assert.equal(state.busyAction, 'cancel:test');
  const streamed = { ...base(), lifecycle: 'paused' }; snapshots.set(streamed);
  finish(Response.json({ success: true, snapshot: { ...base(), lifecycle: 'old reply' } })); await pending;
  assert.equal(get(snapshots), streamed, 'HTTP must not overwrite a newer stream projection');
  const old = state.mutate('candidate:test', '/api/unified-queue/executions/test', { method: 'POST', body: '{}' });
  snapshots.set(null); finish(Response.json({ success: true, status: 'requested', snapshot: base() })); await old;
  assert.equal(get(snapshots), null, 'a late response cannot republish a released profile snapshot');
  assert.match(state.actionNotice, /execution owner must validate/);
  assert.doesNotMatch(state.actionNotice, /completed|movement resumed/);
  assert.equal(state.busyAction, ''); assert.equal(state.actionError, '');
  assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('Queue preserves request paths, candidate identity/readiness and explicit owner stop confirmation exactly', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const { state } = handlers(async (url, init) => { calls.push({ url, init }); return Response.json({ success: true }); });
  const task = { id: 'task / one', robotSessionId: 'body-session' };
  const candidate = { sessionId: 'person-session', candidateFrame: 'frame / one', terminationConfirmed: true,
    frameExpiresAt: new Date(Date.now() + 60_000).toISOString(), windowExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  assert.equal(state.candidateReady(candidate), true);
  assert.equal(state.candidateReady({ ...candidate, terminationConfirmed: false }), false);
  assert.equal(state.candidateReady({ ...candidate, candidateFrame: undefined }), false);
  assert.equal(state.candidateReady({ ...candidate, frameExpiresAt: '2000-01-01T00:00:00Z' }), false);
  assert.equal(state.candidateReady({ ...candidate, windowExpiresAt: '2000-01-01T00:00:00Z' }), false);
  state.cancel(task); state.cancelPending(); state.cancelExecution('execution / one'); state.confirmCandidate('execution / one', candidate);
  assert.deepEqual(calls.map(call => call.url), ['/api/unified-queue/tasks/task%20%2F%20one', '/api/unified-queue/clear',
    '/api/unified-queue/executions/execution%20%2F%20one', '/api/unified-queue/executions/execution%20%2F%20one']);
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { action: 'confirm_person_candidate', sessionId: 'person-session',
    candidateFrame: 'frame / one', confirmCandidate: true, resume: true });
  state.confirmRobotStopped(task); assert.equal(calls.length, 4);
  let prompt = ''; state.confirm = (message: string) => { prompt = message; return true; };
  state.confirmRobotStopped(task);
  assert.equal(prompt, 'Have you checked that the robot for session "body-session" has stopped? This records your confirmation, not a device acknowledgement. Do not confirm while it is moving.');
  assert.equal(calls[4].init.method, 'DELETE'); assert.deepEqual(JSON.parse(String(calls[4].init.body)), { confirmStopped: true });
  state.setPaused(false); state.setPaused(true);
  assert.deepEqual(calls.slice(5).map(call => JSON.parse(String(call.init.body)).action), ['pause', 'resume']);
  await new Promise(resolve => setImmediate(resolve));
});

test('Queue reports malformed JSON and actual rejected requests without swallowing errors or retrying', async () => {
  let calls = 0;
  const { state } = handlers(async () => { calls++; return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }); });
  await state.mutate('pause', '/api/unified-queue/control', { method: 'POST', body: '{}' });
  assert.match(state.actionError, /JSON|Unexpected token/); assert.equal(state.busyAction, ''); assert.equal(calls, 1);
  state.apiFetch = async () => Response.json({ success: false, error: 'Candidate expired' }, { status: 409 });
  await state.mutate('candidate', '/api/unified-queue/executions/test', { method: 'POST', body: '{}' });
  assert.equal(state.actionError, 'Candidate expired'); assert.equal(state.actionNotice, '');
});
