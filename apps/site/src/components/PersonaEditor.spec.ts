import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile, parse } from 'svelte/compiler';

const source = readFileSync(new URL('./PersonaEditor.svelte', import.meta.url), 'utf8');
const scriptText = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
const script = ts.createSourceFile('PersonaEditor.ts', scriptText, ts.ScriptTarget.Latest, true);
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const componentRequire = createRequire(import.meta.url);
const persona = { version: 'fixture', identity: { name: 'Fixture Persona', role: 'Fixture role', purpose: '', humanName: '', email: '', icon: '', aliases: [] },
  personality: { communicationStyle: { tone: [], humor: '', formality: '', verbosity: '', vocabularyLevel: '', preferredPronouns: '' }, narrativeStyle: '' },
  values: { boundaries: [] }, notes: 'Preserve this field' };
const facets = { activeFacet: 'default', description: 'Fixture facets', facets: {
  default: { name: 'Default', description: '', personaFile: 'core.json', enabled: true, color: 'violet', usageHints: [] },
} };
const archive = { filename: 'core-2026-11-04T12-00-00-000Z.json', timestamp: 'core-2026-11-04T12-00-00-000Z', createdAt: '2026-11-04T12:00:00.000Z', identity: { name: 'Archived Persona', role: 'Previous role' }, version: 'fixture', size: 123 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
type Call = { url: string; method: string; body?: any };

function fixture(respond?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const alerts: string[] = [];
  let mounted!: () => void;
  const context = vm.createContext({
    onMount: (callback: () => void) => { mounted = callback; },
    apiFetch: async (url: string, options?: RequestInit) => {
      const call = { url, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined };
      calls.push(call);
      if (respond) return respond(call);
      if (call.method === 'POST') return json({ success: true, persona, backupFile: 'backup-fixture.json' });
      if (url === '/api/persona-core-manage') return json({ success: true, persona });
      if (url === '/api/persona-facets-manage') return json({ success: true, facets });
      if (url === '/api/persona-archives') return json({ success: true, archives: [archive] });
      return json({ version: '2.0.0', lastUpdated: null, entries: [] });
    },
    confirm: () => true, alert: (message: string) => alerts.push(message),
    setTimeout: () => 0, console: { error() {} },
  });
  vm.runInContext(transpile(script.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(script)).join('\n')), context);
  return { calls, alerts, context, mount: () => mounted(),
    run: (code: string) => vm.runInContext(code, context),
    snapshot: (expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
  };
}

function facetTabClick(): string {
  let expression = '';
  function visit(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'OnDirective' && node.name === 'click') {
      const text = source.slice(node.expression.start, node.expression.end);
      if (text.includes("editorTab = 'facets'")) expression = text;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source, { modern: true }));
  assert.ok(expression, 'the actual Facets button must have a click handler');
  return transpile(`(${expression})();`);
}

// Render the actual Svelte template with fixture initial data. Only declaration
// initializers change; event handlers, conditions and markup remain untouched.
function renderState(values: Record<string, unknown>): string {
  let component = source;
  const offset = source.indexOf(scriptText);
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
  for (const node of declarations.reverse()) {
    const name = node.name.getText(script);
    if (node.initializer && Object.hasOwn(values, name)) {
      component = component.slice(0, offset + node.initializer.getStart(script)) + JSON.stringify(values[name]) + component.slice(offset + node.initializer.end);
    }
  }
  const code = ts.transpileModule(compile(component, { filename: 'PersonaEditor.svelte', generate: 'server' }).js.code,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id === 'svelte' ? { onMount() {} }
    : id === '../lib/client/api-config' ? { apiFetch() { throw new Error('Rendering must not fetch'); } } : componentRequire(id) });
  vm.runInContext(code, context);
  return componentRequire('svelte/server').render(context.exports.default).body;
}

test('mount reads core and facets once; revisiting Facets preserves the draft until explicit refresh', async () => {
  const f = fixture();
  f.mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => call.url), ['/api/persona-core-manage', '/api/persona-facets-manage']);
  f.run("facetsConfig.facets.default.description = 'Unsaved facet draft'");
  f.run(facetTabClick());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.snapshot('facetsConfig.facets.default.description'), 'Unsaved facet draft');
  assert.equal(f.calls.length, 2);
  await f.run('reloadFacets()');
  assert.equal(f.snapshot('facetsConfig.facets.default.description'), '');
  assert.equal(f.calls.length, 3);
});

test('core collection editing and facet editing save through their existing APIs without dropping other fields', async () => {
  const f = fixture();
  await f.run('loadPersonaData()');
  f.run("addCoreValue(); addDecisionHeuristic(); addGoal('shortTerm'); addProject(); addFacet()");
  assert.equal(f.snapshot('personaCore.values.core.length'), 1);
  assert.equal(f.snapshot('personaCore.decisionHeuristics.length'), 1);
  assert.equal(f.snapshot('personaCore.goals.shortTerm.length'), 1);
  assert.equal(f.snapshot('personaCore.context.projects.length'), 1);
  assert.equal(f.snapshot('Object.keys(facetsConfig.facets).length'), 2);
  f.run("removeCoreValue(0); removeDecisionHeuristic(0); removeGoal('shortTerm', 0); removeProject(0); removeFacet('default')");
  assert.equal(f.snapshot('personaCore.values.core.length'), 0);
  assert.equal(f.snapshot('personaCore.decisionHeuristics.length'), 0);
  assert.equal(f.snapshot('personaCore.goals.shortTerm.length'), 0);
  assert.equal(f.snapshot('personaCore.context.projects.length'), 0);
  assert.deepEqual(f.alerts, ['Cannot remove the default facet']);
  await f.run('savePersonaCore()');
  await f.run('saveFacets()');
  const saves = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(saves.map(call => call.url), ['/api/persona-core-manage', '/api/persona-facets-manage']);
  assert.equal(saves[0].body.persona.notes, persona.notes);
  assert.equal(Object.keys(saves[1].body.facets.facets).length, 2);
  assert.equal(f.snapshot('saving'), false);
});

test('a failed facet refresh preserves the editable draft until a successful refresh replaces it', async () => {
  let fail = true;
  const f = fixture(() => fail
    ? json({ success: false, error: 'Facets temporarily unavailable' }, 500)
    : json({ success: true, facets }));
  f.run(`personaCore = ${JSON.stringify(persona)}; facetsConfig = ${JSON.stringify(facets)}; editorTab = 'facets'`);
  f.run("facetsConfig.facets.default.description = 'Unsaved facet draft'");

  await f.run('reloadFacets()');
  assert.equal(f.snapshot('facetsConfig?.facets.default.description ?? null'), 'Unsaved facet draft');
  assert.equal(f.snapshot('loading'), false);
  assert.equal(f.snapshot('error'), 'Facets temporarily unavailable');
  const html = renderState({ personaCore: persona, editorTab: 'facets', facetsConfig: f.snapshot('facetsConfig'), error: f.snapshot('error') });
  assert.match(html, /Unsaved facet draft/);
  assert.match(html, /Facets temporarily unavailable/);
  assert.doesNotMatch(html, /Persona facets unavailable/);

  fail = false;
  await f.run('reloadFacets()');
  assert.equal(f.snapshot('facetsConfig.facets.default.description'), '');
  assert.equal(f.snapshot('error'), null);
  assert.equal(f.snapshot('loading'), false);
});

test('insights and archive reads retain their owners; archive view, restore and delete keep the action contract', async () => {
  const f = fixture();
  await f.run('loadPersonaData()');
  await f.run('loadInsights()');
  await f.run('loadArchives()');
  assert.equal(f.snapshot('insights.entries.length'), 0);
  assert.equal(f.snapshot('archives[0].filename'), archive.filename);
  await f.run(`viewArchive('${archive.filename}')`);
  assert.equal(f.snapshot('selectedArchive.identity.name'), persona.identity.name);
  f.run('closeArchiveViewer()');
  assert.equal(f.snapshot('selectedArchive'), null);
  f.run("facetsConfig.description = 'Unsaved facets survive a core-only restore'");
  await f.run(`restoreArchive('${archive.filename}')`);
  assert.equal(f.snapshot('facetsConfig.description'), 'Unsaved facets survive a core-only restore');
  await f.run(`deleteArchive('${archive.filename}')`);
  assert.deepEqual(f.calls.filter(call => call.url === '/api/persona-archives' && call.method === 'POST').map(call => call.body.action), ['view', 'restore', 'delete']);
  assert.match(f.snapshot('success'), /Archive deleted successfully/);
  f.context.confirm = () => false;
  const before = f.calls.length;
  await f.run(`restoreArchive('${archive.filename}'); deleteArchive('${archive.filename}')`);
  assert.equal(f.calls.length, before, 'cancelled actions must make no API request');
});

test('request failures leave drafts available and finish the loading or saving state', async () => {
  const f = fixture(() => json({ success: false, error: 'Fixture failure' }, 500));
  await f.run('loadPersonaData()');
  assert.equal(f.snapshot('loading'), false);
  assert.equal(f.snapshot('error'), 'Fixture failure');
  f.run(`personaCore = ${JSON.stringify(persona)}; facetsConfig = ${JSON.stringify(facets)}`);
  for (const operation of ['savePersonaCore()', 'saveFacets()', `viewArchive('${archive.filename}')`, `restoreArchive('${archive.filename}')`, `deleteArchive('${archive.filename}')`]) {
    await f.run(operation);
    assert.equal(f.snapshot('saving'), false);
    assert.equal(f.snapshot('loading'), false);
    assert.equal(f.snapshot('error'), 'Fixture failure');
    assert.equal(f.snapshot('personaCore.notes'), persona.notes);
  }
  await f.run('loadInsights()');
  await f.run('loadArchives()');
  assert.equal(f.snapshot('loadingInsights || loadingArchives'), false);
  assert.equal(f.snapshot('insightsLoaded && archivesLoaded'), true, 'failed lazy reads require explicit refresh rather than an automatic retry loop');
});

test('archive history remains visible when another editor operation reports an error', () => {
  const html = renderState({ personaCore: persona, editorTab: 'archives', archives: [archive], archivesLoaded: true, error: 'Core save failed' });
  assert.match(html, /Core save failed/);
  assert.match(html, /Archived Persona/);
  assert.match(html, /Nov 4, 2026/);
  assert.doesNotMatch(html, /core-2026-11-04T12-00-00-000Z<\/span>/);
  assert.doesNotMatch(html, /Failed to load archives/);
});

test('insight presentation and archive viewing render from their current data owners', () => {
  const entries = ['addition', 'removal', 'update'].map(type => ({ type, timestamp: '2026-11-04T12:00:00Z', category: 'values', items: [`${type} evidence`], memoriesAnalyzed: 2, confidence: 0.8, sessionId: 'fixture-session' }));
  const html = renderState({ personaCore: persona, editorTab: 'insights', insightsLoaded: true, insights: { version: '2.0.0', entries, lastUpdated: null } });
  for (const type of ['addition', 'removal', 'update']) assert.match(html, new RegExp(`${type} evidence`));
  for (const color of ['emerald', 'red', 'amber']) assert.match(html, new RegExp(`bg-${color}-500`));
  const viewer = renderState({ personaCore: persona, editorTab: 'archives', archivesLoaded: true, archives: [archive], selectedArchive: persona });
  assert.match(viewer, /Archive Viewer/);
});
