import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';

const source = readFileSync(new URL('./MemoryControls.svelte', import.meta.url), 'utf8');
const scriptText = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
const script = ts.createSourceFile('MemoryControls.ts', scriptText, ts.ScriptTarget.Latest, true);
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const componentRequire = createRequire(import.meta.url);
const ready = { exists: true, model: 'fixture-embedder', provider: 'fixture', items: 12, createdAt: '2026-11-04T12:00:00Z' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function fixture() {
  const requests: Array<{ method: string; body?: unknown }> = [];
  const admissions: Array<{ name: string; args: string[] }> = [];
  let mount: () => Promise<void>;
  const context = vm.createContext({ onMount: (callback: () => Promise<void>) => { mount = callback; },
    apiFetch: async (url: string, options?: RequestInit) => {
      assert.equal(url, '/api/index');
      requests.push({ method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined });
      return json(options?.method === 'POST' ? { success: true, queued: true, taskId: 'index-task', status: ready } : ready, options?.method === 'POST' ? 202 : 200);
    },
    runTriggerNow: async (name: string, args: string[] = []) => { admissions.push({ name, args: [...args] }); return `${name}-task`; },
    console: { error() {} },
  });
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(script)).join('\n')), context);
  return { context, requests, admissions, mount: () => mount(), run: (code: string) => vm.runInContext(code, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

function renderState(values: Record<string, unknown>): { html: string; requests: number } {
  let component = source;
  const offset = source.indexOf(scriptText);
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
  for (const node of declarations.reverse()) {
    if (node.initializer && Object.hasOwn(values, node.name.getText(script))) {
      component = component.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[node.name.getText(script)])
        + component.slice(offset + node.initializer.end);
    }
  }
  let requests = 0;
  const code = ts.transpileModule(compile(component, { filename: 'MemoryControls.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id === 'svelte' ? { onMount() {} }
    : id === '../lib/client/api-config' ? { apiFetch: async () => { requests++; return json(ready); } }
    : id === '../lib/stores/trigger-manager' ? { runTriggerNow() { assert.fail('rendering must not admit work'); } } : componentRequire(id) });
  vm.runInContext(code, context);
  return { html: componentRequire('svelte/server').render(context.exports.default).body, requests };
}

test('the initial index read belongs to mount, and server rendering does not issue a request', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  await f.mount();
  assert.deepEqual(f.requests, [{ method: 'GET', body: undefined }]);
  assert.deepEqual(f.snapshot('indexStatus'), ready);
  assert.equal(renderState({}).requests, 0);
});

test('curator and organizer use their registered triggers and retain admission identities and temperature arguments', async () => {
  const f = fixture();
  for (const temperature of [0, 0.3, 1]) {
    f.run(`curatorTemperature = ${temperature}`);
    await f.run('runCurator()');
    assert.deepEqual(f.admissions.at(-1), { name: 'curator', args: ['--temperature', String(temperature)] });
    assert.equal(f.snapshot('curatorTaskId'), 'curator-task');
  }
  await f.run('runOrganizer()');
  assert.deepEqual(f.admissions.at(-1), { name: 'organizer', args: [] });
  assert.equal(f.snapshot('organizerTaskId'), 'organizer-task');
  assert.equal(f.snapshot('curatorRunning || organizerRunning'), false);
  const html = renderState({ curatorTaskId: 'curator-task', organizerTaskId: 'organizer-task' }).html;
  assert.match(html, /Curator queued as curator-task/);
  assert.match(html, /Organizer queued as organizer-task/);
  assert.doesNotMatch(html, /Curator started|Organizer started/);
});

test('trigger rejection preserves the actual backend cause and permits a later successful admission', async () => {
  const f = fixture();
  for (const [operation, prefix] of [['runCurator()', 'curator'], ['runOrganizer()', 'organizer']]) {
    f.context.runTriggerNow = async () => { throw new Error('Admission paused for this profile'); };
    await f.run(operation);
    assert.equal(f.snapshot(`${prefix}Error`), 'Admission paused for this profile');
    assert.equal(f.snapshot(`${prefix}TaskId`), null);
    assert.equal(f.snapshot(`${prefix}Running`), false);
    f.context.runTriggerNow = async () => `${prefix}-retry`;
    await f.run(operation);
    assert.equal(f.snapshot(`${prefix}Error`), null);
    assert.equal(f.snapshot(`${prefix}TaskId`), `${prefix}-retry`);
  }
});

test('index rebuild submits once, reports the admission rather than completion, and retains failure details', async () => {
  const f = fixture();
  await f.mount();
  await f.run('buildIndex()');
  assert.deepEqual(f.requests, [{ method: 'GET', body: undefined }, { method: 'POST', body: { action: 'build' } }]);
  assert.equal(f.snapshot('indexNotice'), 'Rebuild queued as index-task');
  assert.deepEqual(f.snapshot('indexStatus'), ready);
  f.context.apiFetch = async () => json({ success: false, error: 'Index storage unavailable' }, 503);
  await f.run('buildIndex()');
  assert.equal(f.snapshot('indexError'), 'Index storage unavailable');
  assert.equal(f.snapshot('indexNotice'), null);
  assert.equal(f.snapshot('buildingIndex'), false);
  assert.deepEqual(f.snapshot('indexStatus'), ready);
  await f.run('loadIndexStatus()');
  assert.equal(f.snapshot('indexError'), 'Index storage unavailable');
  assert.equal(f.snapshot('loadingIndex'), false);
});

test('ready, missing, legacy and corrupt index diagnostics remain visible with the existing help and refresh controls', () => {
  for (const [status, label] of [[ready, 'Ready'], [{ exists: false, reason: 'missing' }, 'Missing index'],
    [{ exists: false, reason: 'legacy', legacyIndexes: [{ fileName: 'retired.index', model: 'old-model' }] }, 'Legacy index'],
    [{ exists: false, reason: 'corrupt' }, 'Corrupt index']] as const) {
    const html = renderState({ indexStatus: status }).html;
    assert.match(html, new RegExp(label));
    assert.match(html, /href="\/user-guide#memory-system"/);
    assert.match(html, />Refresh<\/button>/);
    assert.match(html, />Queue rebuild<\/button>/);
    if ('reason' in status && status.reason === 'legacy') assert.match(html, /old-model/);
    if ('reason' in status && status.reason === 'corrupt') assert.match(html, /only be replaced after a successful build/);
  }
});
