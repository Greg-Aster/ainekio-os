import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile, parse } from 'svelte/compiler';

const source = fs.readFileSync(new URL('./ChatSettings.svelte', import.meta.url), 'utf8');
const scriptText = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
const script = ts.createSourceFile('ChatSettings.ts', scriptText, ts.ScriptTarget.Latest, true);
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const componentRequire = createRequire(import.meta.url);
const defaults = { contextInfluence: 0.5, historyInfluence: 0.6, facetInfluence: 0.7, temperature: 0.6,
  semanticSearchThreshold: 0.62, maxContextChars: 900, conversationBufferLimit: 30, innerBufferLimit: 80,
  systemBufferLimit: 100, robotBufferLimit: 100, userInputPriority: true, unifiedConsciousness: false };
const globalScope = { scope: 'global', hasUserOverride: false };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
type Call = { method: 'GET' | 'PUT' | 'POST'; body?: any };

function fixture(respond: (call: Call) => Promise<Response> | Response = () => json({ settings: defaults, scope: globalScope })) {
  const calls: Call[] = [];
  let mounted!: () => Promise<void>;
  const context = vm.createContext({ onMount: (callback: () => Promise<void>) => { mounted = callback; },
    apiFetch: async (url: string, options?: RequestInit) => {
      assert.equal(url, '/api/chat-settings');
      const method = options?.method ?? 'GET';
      assert.ok(method === 'GET' || method === 'PUT' || method === 'POST');
      const call: Call = { method, body: options?.body ? JSON.parse(String(options.body)) : undefined };
      calls.push(call);
      return respond(call);
    }, console: { error() {} },
  });
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(script)).join('\n')), context);
  return { calls, mount: () => mounted(), run: (code: string) => vm.runInContext(code, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) };
}

function renderState(values: Record<string, unknown>): string {
  let component = source;
  const offset = source.indexOf(scriptText);
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
  for (const node of declarations.reverse()) {
    if (node.initializer && Object.hasOwn(values, node.name.getText(script))) {
      component = component.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[node.name.getText(script)])
        + component.slice(offset + node.initializer.end);
    }
  }
  const code = ts.transpileModule(compile(component, { filename: 'ChatSettings.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id === 'svelte' ? { onMount() {} }
    : id === '../lib/client/api-config' ? { apiFetch() { throw new Error('Rendering must not fetch'); } } : componentRequire(id) });
  vm.runInContext(code, context);
  return componentRequire('svelte/server').render(context.exports.default).body;
}

function sliderInput(id: string): string {
  let handler = '';
  function visit(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.attributes?.some((attribute: any) => attribute.name === 'id' && attribute.value?.[0]?.data === id)) {
      const input = node.attributes.find((attribute: any) => attribute.type === 'OnDirective' && attribute.name === 'input');
      if (input) handler = source.slice(input.expression.start, input.expression.end);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source, { modern: true }));
  assert.ok(handler, `the actual ${id} slider must record input before change/save`);
  return transpile(`(${handler})();`);
}

test('a single-field UI save reaches the canonical profile owner without rewriting other saved settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-chat-settings-'));
  process.env.METAHUMAN_ROOT = root;
  const { ROOT, registerProfileStorageConfigGetter } = await import('../../../../packages/core/src/path-builder.js');
  assert.equal(ROOT, root);
  const { eventBus } = await import('../../../../packages/core/src/infrastructure/event-bus/client.js');
  eventBus.disconnect();
  const { setAuditEnabled } = await import('../../../../packages/core/src/audit.js');
  setAuditEnabled(false);
  const { withUserContext } = await import('../../../../packages/core/src/context.js');
  const handlers = await import('../../../../packages/core/src/api/handlers/chat-settings.js');
  const username = 'chat-settings-fixture';
  const profile = path.join(root, 'profiles', username);
  fs.mkdirSync(path.join(profile, 'etc'), { recursive: true });
  registerProfileStorageConfigGetter(candidate => candidate === username ? { path: profile, type: 'internal' } : undefined);
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  fs.copyFileSync(new URL('../../../../etc/chat-settings.json', import.meta.url), path.join(root, 'etc', 'chat-settings.json'));
  const profileConfig = JSON.parse(fs.readFileSync(path.join(root, 'etc', 'chat-settings.json'), 'utf8'));
  profileConfig.settings.contextInfluence.value = 0.37;
  profileConfig.settings.temperature.value = 0.23;
  fs.writeFileSync(path.join(profile, 'etc', 'chat-settings.json'), JSON.stringify(profileConfig));
  const user = { isAuthenticated: true, userId: username, username, role: 'owner' as const };
  try {
    const f = fixture(call => withUserContext(user, async () => {
      const req = { path: '/api/chat-settings', method: call.method, body: call.body, user };
      const result = await (call.method === 'GET' ? handlers.handleGetChatSettings(req)
        : call.method === 'PUT' ? handlers.handleUpdateChatSettings(req) : handlers.handleApplyChatPreset(req));
      return json(result.data ?? { error: result.error }, result.status ?? 200);
    }));
    await f.mount();
    f.run('settings.conversationBufferLimit = 45');
    await f.run("saveSettings('conversationBufferLimit')");
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'PUT']);
    assert.deepEqual(f.calls[1].body, { updates: { conversationBufferLimit: 45 } });
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'etc', 'chat-settings.json'), 'utf8'));
    assert.equal(saved.settings.conversationBufferLimit.value, 45);
    assert.equal(saved.settings.contextInfluence.value, 0.37);
    assert.equal(saved.settings.temperature.value, 0.23);
    assert.equal(f.snapshot('scope.hasUserOverride'), true);
    for (const preset of ['focused', 'balanced', 'immersive', 'minimal']) await f.run(`applyPreset('${preset}')`);
    assert.deepEqual(f.calls.slice(2).map(call => call.body.preset), ['focused', 'balanced', 'immersive', 'minimal']);
    assert.equal(f.snapshot('settings.conversationBufferLimit'), 10);
    assert.equal(f.snapshot('settings.unifiedConsciousness'), false);
  } finally { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('concurrent field saves retain newer edits when older HTTP replies arrive', async () => {
  const replies: Array<(response: Response) => void> = [];
  const f = fixture(call => call.method === 'GET' ? json({ settings: defaults, scope: globalScope })
    : new Promise(resolve => replies.push(resolve)));
  await f.mount();
  f.run('settings.conversationBufferLimit = 45');
  const first = f.run("saveSettings('conversationBufferLimit')");
  f.run('settings.innerBufferLimit = 110');
  const second = f.run("saveSettings('innerBufferLimit')");
  replies[1](json({ settings: { ...defaults, innerBufferLimit: 110 }, scope: globalScope }));
  await second;
  replies[0](json({ settings: { ...defaults, conversationBufferLimit: 45 }, scope: globalScope }));
  await first;
  assert.equal(f.snapshot('settings.conversationBufferLimit'), 45);
  assert.equal(f.snapshot('settings.innerBufferLimit'), 110);
  assert.deepEqual(f.calls.slice(1).map(call => call.body.updates), [{ conversationBufferLimit: 45 }, { innerBufferLimit: 110 }]);
});

test('a delayed preset preserves later field edits, including values changed back to their starting value', async () => {
  for (const conversationLimit of [45, 30]) {
    let finishPreset!: (response: Response) => void;
    const f = fixture(call => call.method === 'POST' ? new Promise(resolve => { finishPreset = resolve; })
      : json({ settings: defaults, scope: globalScope }));
    await f.mount();
    const preset = f.run("applyPreset('immersive')");
    f.run('settings.conversationBufferLimit = 45');
    await f.run("saveSettings('conversationBufferLimit')");
    f.run(`settings.conversationBufferLimit = ${conversationLimit}; settings.unifiedConsciousness = true`);
    await f.run("saveSettings('conversationBufferLimit')");
    await f.run("saveSettings('unifiedConsciousness')");
    f.run('settings.unifiedConsciousness = false');
    await f.run("saveSettings('unifiedConsciousness')");
    finishPreset(json({ settings: { ...defaults, conversationBufferLimit: 50, innerBufferLimit: 150, unifiedConsciousness: true }, scope: globalScope }));
    await preset;
    assert.equal(f.snapshot('settings.conversationBufferLimit'), conversationLimit);
    assert.equal(f.snapshot('settings.unifiedConsciousness'), false);
    assert.equal(f.snapshot('settings.innerBufferLimit'), 150, 'unchanged fields still receive the preset');
  }
});

test('slider input keeps its newer draft when a preset replies before the change/save event', async () => {
  for (const [id, key] of [
    ['conversation-buffer-limit', 'conversationBufferLimit'], ['inner-buffer-limit', 'innerBufferLimit'],
    ['system-buffer-limit', 'systemBufferLimit'], ['robot-buffer-limit', 'robotBufferLimit'],
  ]) {
    let finishPreset!: (response: Response) => void;
    const f = fixture(call => call.method === 'POST' ? new Promise(resolve => { finishPreset = resolve; })
      : json({ settings: defaults, scope: globalScope }));
    await f.mount();
    const preset = f.run("applyPreset('immersive')");
    f.run(`settings.${key} = 135`);
    f.run(sliderInput(id));
    finishPreset(json({ settings: { ...defaults, [key]: 200 }, scope: globalScope }));
    await preset;
    assert.equal(f.snapshot(`settings.${key}`), 135);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST'], 'input does not add a save request');
    await f.run(`saveSettings('${key}')`);
    assert.deepEqual(f.calls[2].body, { updates: { [key]: 135 } });
  }
});

test('failed reads display the error instead of editable defaults or a claimed global scope', async () => {
  const f = fixture(() => json({ error: 'Settings unavailable' }, 500));
  await f.mount();
  assert.equal(f.snapshot('loading'), false);
  assert.equal(f.snapshot('settings'), null);
  assert.equal(f.snapshot('error'), 'Settings unavailable');
  const html = renderState({ loading: false, settings: null, error: 'Settings unavailable' });
  assert.match(html, /Settings unavailable/);
  assert.doesNotMatch(html, /type="range"|Quick Presets|Scope:/);
});

test('an initial read failure can be retried through the existing loader without navigating away', async () => {
  let fail = true;
  const f = fixture(() => fail ? json({ error: 'Settings unavailable' }, 500)
    : json({ settings: defaults, scope: globalScope }));
  await f.mount();
  const html = renderState({ loading: false, settings: null, error: 'Settings unavailable' });
  assert.match(html, />Retry<\/button>/);
  assert.match(source, /on:click=\{loadSettings\}>Retry<\/button>/);
  fail = false;
  await f.run('loadSettings()');
  assert.equal(f.snapshot('error'), '');
  assert.equal(f.snapshot('loading'), false);
  assert.equal(f.snapshot('settings.conversationBufferLimit'), 30);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET']);
});

test('failed saves and presets preserve the draft, display the error and release operation state', async () => {
  let fail = true;
  const f = fixture(call => call.method === 'GET' || !fail ? json({ settings: defaults, scope: globalScope })
    : json({ error: 'Write failed' }, 500));
  await f.mount();
  f.run('settings.robotBufferLimit = 130');
  for (const operation of ["saveSettings('robotBufferLimit')", "applyPreset('focused')"]) {
    await f.run(operation);
    assert.equal(f.snapshot('settings.robotBufferLimit'), 130);
    assert.equal(f.snapshot('error'), 'Write failed');
    assert.equal(f.snapshot('Boolean(saving || presetEdits)'), false);
  }
  fail = false;
  await f.run("saveSettings('robotBufferLimit')");
  assert.equal(f.snapshot('error'), '');
  assert.equal(f.snapshot('settings.robotBufferLimit'), 130);
});

test('the rendered settings screen exposes only controls with current execution consumers', () => {
  const html = renderState({ loading: false, settings: defaults, scope: globalScope });
  assert.equal((html.match(/type="range"/g) ?? []).length, 4);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  for (const label of ['Conversation Buffer Messages', 'Inner Buffer Messages', 'System Buffer Messages', 'Robot Buffer Messages', 'Unified Consciousness']) assert.match(html, new RegExp(label));
  for (const label of ['Context Influence', 'History Influence', 'Facet Influence', 'Temperature:', 'Memory Relevance', 'Max Context Size', 'Prioritize User Input']) assert.doesNotMatch(html, new RegExp(label));
});
