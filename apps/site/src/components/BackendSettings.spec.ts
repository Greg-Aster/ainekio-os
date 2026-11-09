import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute actual component scripts; HTTP, media and lifecycle are test boundaries.
function component(name: string, apiFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const source = readFileSync(new URL(`./${name}.svelte`, import.meta.url), 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
  let mount = () => {}, destroy = () => {};
  const context = vm.createContext({ apiFetch, AbortController, AbortSignal, console,
    DEFAULT_OLLAMA_CHAT_MODEL: 'fixture-default', statusRefreshTrigger: { update() {} },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    onMount(callback: () => void) { mount = callback; }, onDestroy(callback: () => void) { destroy = callback; },
  });
  vm.runInContext(ts.transpileModule(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, field: (code: string) => vm.runInContext(code, context), mount: () => mount(), destroy: () => destroy() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const config = { activeBackend: 'ollama', llamaCpp: { model: 'saved-brain' }, ollama: { defaultModel: 'saved-motion' } };
const live = { active: { resolvedBackend: 'ollama' }, available: { ollama: { installed: true, running: true } }, config, sharedArtifacts: [] };

test('backend observation never reloads drafts or adapters and settings save preserves other drafts', async () => {
  const requests: string[] = [];
  const { context, field } = component('BackendSettings', async (url, init) => {
    requests.push(url);
    return Response.json(url.includes('loras') ? { success: true, available: [] } : init?.method === 'PUT' ? { success: true, config } : url.endsWith('/config') ? config : live);
  });
  await context.loadBackendSettings();
  field("llamaModel='unsaved brain';ollamaModel='unsaved motion'");
  await context.loadStatus();
  assert.equal(field('llamaModel'), 'unsaved brain');
  assert.equal(field('ollamaModel'), 'unsaved motion');
  assert.equal(requests.filter(url => url.includes('loras')).length, 1, 'only config load reads adapters; telemetry does not');
  await context.saveLlamaConfig();
  assert.equal(field('ollamaModel'), 'unsaved motion');
  assert.equal(field('configuredActiveBackend'), 'llama-cpp');
});

test('backend model reads surface failure and release replaced or destroyed observations', async () => {
  const pending: { signal: AbortSignal; finish: (response: Response) => void }[] = [];
  const { context, field, destroy } = component('BackendSettings', async (_url, init) => new Promise(resolve => {
    pending.push({ signal: init!.signal!, finish: resolve });
  }));
  const old = context.loadOllamaLoras('old-model');
  const current = context.loadOllamaLoras('new-model');
  assert.equal(pending[0].signal.aborted, true);
  pending[1].finish(Response.json({ success: true, available: [{ name: 'current' }] })); await current;
  pending[0].finish(Response.json({ success: true, available: [{ name: 'obsolete' }] })); await old;
  assert.equal(field('ollamaLoraAdapters')[0].name, 'current');
  const failed = context.loadOllamaLoras('new-model');
  pending[2].finish(Response.json({ error: 'Read failed' }, { status: 503 })); await failed;
  assert.equal(field('loraError'), 'Read failed');
  assert.equal(field('ollamaLoraAdapters')[0].name, 'current', 'failure does not invent an empty catalog');
  const oldModel = context.loadOllamaLoras('old-model');
  field("ollamaModelSelection='__custom__';selectOllamaModel()");
  assert.equal(pending[3].signal.aborted, true);
  pending[3].finish(Response.json({ success: true, available: [{ name: 'old custom result' }] })); await oldModel;
  assert.equal(field('ollamaLoraAdapters').length, 0, 'selecting Custom releases the previous model catalog');
  const status = context.loadStatus(); destroy();
  assert.equal(pending[4].signal.aborted, true);
  pending[4].finish(Response.json(live)); await status;
  assert.equal(field('available'), null);
  assert.equal(await context.loadStatus(), false);
});

test('Big Brother submits only visible settings and restores acknowledged fields after failed write', async () => {
  const writes: Record<string, unknown>[] = [];
  let fail = false;
  const saved = { provider: 'codex', model: 'acknowledged', reasoningEffort: 'high', maxRetries: 8, escalateOnStuck: false };
  const { context, field } = component('BackendSettings', async (_url, init) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      return fail ? Response.json({ error: 'Native provider stop failed' }, { status: 500 })
        : Response.json({ success: true, config: saved });
    }
    return Response.json({ success: true, config: saved });
  });
  await context.loadBigBrotherConfig();
  fail = true; field("bigBrotherProvider='claude-code';bigBrotherModel='new draft'");
  await context.saveBigBrotherConfig();
  assert.equal(field('bigBrotherProvider'), 'codex');
  assert.equal(field('bigBrotherModel'), 'acknowledged');
  assert.match(field('error'), /Native provider stop failed/);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['model', 'provider', 'reasoningEffort']);
  fail = false; await context.saveBigBrotherConfig();
  assert.equal(field('bigBrotherConfig').maxRetries, 8);
});

test('GPU observation is finite, superseded reads cannot overwrite and unmount releases its request', async () => {
  const pending: { signal: AbortSignal; finish: (response: Response) => void }[] = [];
  const { context, field, mount, destroy } = component('GPUMonitor', async (url, init) => {
    assert.equal(url, '/api/gpu-status');
    return new Promise(resolve => pending.push({ signal: init!.signal!, finish: resolve }));
  });
  mount(); assert.equal(pending.length, 1);
  const current = context.loadGPUStatus();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].finish(Response.json({ available: true, gpus: [{ name: 'current' }] })); await current;
  pending[0].finish(Response.json({ error: 'Superseded GPU query failed' }, { status: 500 })); await settle();
  assert.equal(field('status').gpus[0].name, 'current');
  const last = context.loadGPUStatus(); destroy();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].finish(Response.json({ error: 'Superseded GPU query failed' }, { status: 500 })); await last;
  assert.equal(field('status').available, true);
});

test('registered options save the admitted model and preserve current selection and newer draft', async () => {
  let finish!: (response: Response) => void;
  const writes: Record<string, any>[] = [];
  const first = { id: 'brain', provider: 'llama-cpp', model: 'brain', source: 'user-registry', options: { maxImageBytes: 1.5 * 1024 * 1024, contextWindow: 16384 } };
  const second = { ...first, id: 'motion', model: 'motion' };
  const { context, field } = component('ModelRegistrySettings', async (_url, init) => {
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return new Promise(resolve => { finish = resolve; });
    }
    return Response.json({ success: true, availableModels: [first, second, { ...first, id: 'runtime', source: 'runtime-discovery' }] });
  });
  await context.loadRegistry();
  assert.equal(field('maxImageMb'), 1.5, 'existing byte capacity is not rounded on load');
  assert.equal(field('models').length, 2);
  const saving = context.saveModelOptions();
  field("selectedModelId='motion';loadSelectedOptions();contextWindow=32768");
  finish(Response.json({ success: true, model: { id: 'brain', capabilities: ['text'], options: first.options } })); await saving;
  assert.equal(writes[0].modelId, 'brain');
  assert.equal(writes[0].options.maxImageBytes, first.options.maxImageBytes);
  assert.equal(field('selectedModelId'), 'motion');
  assert.equal(field('contextWindow'), 32768);
  assert.match(field('message'), /saved/);
});

test('GPU handler returns measured memory and processes without removed Ollama policy', async () => {
  const source = readFileSync(new URL('../../../../packages/core/src/api/handlers/gpu-status.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('gpu-status.ts', source, ts.ScriptTarget.Latest, true);
  const queries: string[][] = [];
  let failure = '', empty = false;
  const context = vm.createContext({ console, successResponse: (data: unknown) => ({ status: 200, data }),
    execFileSync(command: string, args: string[]) {
      assert.equal(command, 'nvidia-smi'); queries.push(args);
      if (failure && args[0].includes(failure)) throw new Error('Fixture command failed');
      if (empty && args[0].startsWith('--query-compute')) return '';
      return args[0].startsWith('--query-gpu=') ? '0, GPU fixture, 24576, 10000, 14576, 70, 30' : '123, native-worker, 9000 MiB';
    },
  });
  vm.runInContext(ts.transpileModule(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const response = await context.handleGetGpuStatus({});
  assert.equal(response.status, 200);
  assert.equal(response.data.gpus[0].memory.free, 14576);
  assert.equal(response.data.processes[0].pid, 123);
  assert.equal(response.data.processes[0].memory, 9000);
  assert.equal('recommendations' in response.data, false);
  assert.equal('ollama' in response.data, false);
  assert.equal(queries.length, 2);
  empty = true;
  assert.deepEqual(JSON.parse(JSON.stringify((await context.handleGetGpuStatus({})).data.processes)), []);
  for (failure of ['query-gpu', 'query-compute']) {
    const failed = await context.handleGetGpuStatus({});
    assert.equal(failed.status, 500);
    assert.match(failed.error, /Fixture command failed/);
    assert.equal(failed.data, undefined, 'error must reach the shared adapter rather than being hidden by a fabricated data result');
  }
});

test('unavailable backend config stays unavailable and teardown does not start its follow-up reads', async () => {
  let finish!: (response: Response) => void;
  let failed = true;
  const requests: string[] = [];
  const { context, field, mount, destroy } = component('BackendSettings', async url => {
    requests.push(url);
    if (url.endsWith('/config')) return failed ? Response.json({ error: 'Unavailable' }, { status: 503 })
      : new Promise(resolve => { finish = resolve; });
    return Response.json(url.includes('big-brother') ? { config: { provider: 'codex' } } : live);
  });
  await context.loadBackendSettings();
  assert.equal(field('configLoaded'), false);
  failed = false; mount(); await settle(); destroy();
  const count = requests.length;
  finish(Response.json(config)); await settle();
  assert.equal(field('configLoaded'), false);
  assert.equal(requests.length, count, 'a closed initial loader cannot admit its LoRA continuation');
});

test('registry read replacement and teardown cannot replace edits or replay admitted writes', async () => {
  let finishRead!: (response: Response) => void, finishWrite!: (response: Response) => void;
  let signal!: AbortSignal;
  let writes = 0;
  const { context, field, destroy } = component('ModelRegistrySettings', async (_url, init) => {
    if (init?.method === 'PUT') {
      assert.equal(init.signal, undefined, 'view closure does not cancel the admitted persistence request');
      writes++; return new Promise(resolve => { finishWrite = resolve; });
    }
    signal = init!.signal!;
    return new Promise(resolve => { finishRead = resolve; });
  });
  const model = { id: 'brain', source: 'user-registry', provider: 'llama-cpp', model: 'brain', options: { contextWindow: 16384 } };
  const initial = context.loadRegistry(); finishRead(Response.json({ success: true, availableModels: [model] })); await initial;
  const refresh = context.loadRegistry();
  field('contextWindow=32768');
  finishRead(Response.json({ success: true, availableModels: [model] })); await refresh;
  assert.equal(field('contextWindow'), 32768, 'read completion cannot overwrite edits made after the read began');
  const saving = context.saveModelOptions();
  const pending = context.loadRegistry(); destroy(); assert.equal(signal.aborted, true);
  finishRead(Response.json({ success: true, availableModels: [] })); await pending;
  finishWrite(Response.json({ success: true, model })); await saving;
  assert.equal(writes, 1);
  assert.equal(field('models')[0].id, 'brain');
  assert.equal(field('message'), '', 'late write receipt does not update a closed view');
});
