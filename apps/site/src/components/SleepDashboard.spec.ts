import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { writable } from 'svelte/store';

const component = readFileSync(new URL('./SleepDashboard.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('SleepDashboard.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const status = () => ({ status: 'awake', phase: 'awake', config: { enabled: true, window: { start: '23:00', end: '06:30' }, minIdleMins: 15 },
  currentSession: null, recentSessions: [], configuredStages: [{ id: 'organize', displayName: 'Organize', handler: 'agent.organizer' }], lastChecked: '2026-11-05T12:00:00Z' });

function view(store: unknown) {
  const require = createRequire(import.meta.url);
  const compiled = ts.transpileModule(compile(component, { filename: 'SleepDashboard.svelte', generate: 'server' }).js.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id.includes('sleep-status') ? { sleepStatus: store }
    : id.includes('api-config') ? { apiFetch() { assert.fail('Rendering must not trigger Sleep'); } } : require(id) });
  vm.runInContext(compiled, context);
  return () => require('svelte/server').render(context.exports.default).body;
}

test('Sleep distinguishes loading, failed read, last-known status and configuration from admitted stages', () => {
  const store = writable<any>({ data: null, error: '' }); const render = view(store);
  assert.match(render(), /Loading sleep status/);
  store.set({ data: null, error: 'Runtime read failed' }); let html = render();
  assert.match(html, /Runtime read failed/); assert.doesNotMatch(html, /Loading sleep status|AWAKE/);
  store.set({ data: status(), error: '' }); html = render();
  assert.match(html, /Organize/); assert.match(html, /configured/); assert.doesNotMatch(html, /pending/);
  assert.match(html, /Runtime phase: awake/);
  store.set({ data: status(), error: 'Latest status unavailable' }); html = render();
  assert.match(html, /Latest status unavailable/); assert.match(html, /last received sleep status/); assert.match(html, /Organize/);
});

test('Sleep presents recorded stage errors, attempts and terminal review without changing the manual-run conditions', () => {
  const stage = { id: 'dream', displayName: 'Dream stage', handler: 'agent.dreamer', state: 'running', attempt: 1, maxAttempts: 3 };
  const session = { id: 'sleep-session', parentTaskId: 'sleep-parent', username: 'fixture', reason: 'Manual test', state: 'running',
    startedAt: '2026-11-05T11:00:00Z', stages: [stage] };
  const store = writable<any>({ data: { ...status(), status: 'dreaming', phase: 'sleeping', currentSession: session,
    recentSessions: [{ ...session, state: 'cancelled', completedAt: '2026-11-05T11:05:00Z', stages: [{ ...stage, state: 'cancelled', error: 'Recorded failure detail' }] }] }, error: '' });
  const render = view(store); let html = render();
  assert.match(html, /Sleep in progress/); assert.match(html, /Attempt 2 of 3/); assert.match(html, /5 minutes/); assert.match(html, /cancelled/);
  assert.match(html, /Problems: 1/);
  store.update(value => ({ ...value, data: { ...value.data, currentSession: { ...session, stages: [{ ...stage, state: 'failed', error: 'Full recorded failure detail' }] } } }));
  html = render(); assert.match(html, /Full recorded failure detail/); assert.doesNotMatch(html, /truncate/);
  store.set({ data: { ...status(), config: { ...status().config, enabled: false } }, error: '' });
  assert.match(render(), /disabled/);
});

test('Run Sleep preserves the current HTTP admission contract and trigger request without retry', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const state = vm.createContext({ Error, Date, running: false, notice: '', error: '', apiFetch: async (url: string, init: RequestInit) => {
    calls.push({ url, init }); return Response.json({ success: false, error: 'Owner permission required' }, { status: 403 }); } });
  vm.runInContext(code, state);
  await state.runNow(); assert.equal(state.error, 'Owner permission required'); assert.equal(state.notice, ''); assert.equal(state.running, false);
  assert.equal(calls[0].url, '/api/unified-queue/trigger/sleep-workflow'); assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { args: [] });
  state.apiFetch = async () => Response.json({ success: true, taskId: 'admitted-task' }); await state.runNow();
  assert.equal(state.notice, 'Sleep Workflow queued as admitted-task'); assert.equal(state.error, ''); assert.equal(state.running, false);
  assert.doesNotMatch(state.notice, /completed|sleeping|running/);
});
