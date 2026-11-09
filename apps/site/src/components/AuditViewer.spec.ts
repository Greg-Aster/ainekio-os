import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';

const file = new URL('./AuditViewer.svelte', import.meta.url);
const component = readFileSync(file, 'utf8');
const source = ts.createSourceFile('AuditViewer.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const script = ts.transpileModule(source.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

// Same script-boundary and compiled-template approach as the existing component suites.
function screen() {
  let mount!: () => (() => void);
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const document = Object.assign(new EventTarget(), { hidden: false });
  const context = vm.createContext({ AbortController, URLSearchParams, document,
    onMount: (callback: typeof mount) => { mount = callback; },
    apiFetch: (url: string, options: RequestInit) => new Promise<Response>(resolve => {
      requests.push({ url, signal: options.signal as AbortSignal, resolve });
    }),
  });
  vm.runInContext(script, context);
  return { requests, document, mount: () => mount(), run: (expression: string) => vm.runInContext(expression, context) };
}

const page = (event: string, nextCursor: number | null = null, summary = true) => ({
  date: '2026-11-04', entries: [{ event, timestamp: '2026-11-04T00:00:00Z', category: 'system', level: 'info', details: { text: '🤖'.repeat(18000) } }], nextCursor,
  ...(summary ? { summary: { total: 2, byLevel: { info: 2 }, byCategory: { system: 2 } }, matched: 2 } : {}),
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('date, filters and refresh render without a successful history response', () => {
  const require = createRequire(import.meta.url);
  const compiled = compile(component, { filename: file.pathname, generate: 'server' }).js.code;
  const code = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, require: (id: string) => id === '../lib/client/api-config'
    ? { apiFetch() { throw new Error('Server rendering must not fetch history'); } } : require(id) });
  vm.runInContext(code, context);
  const html = require('svelte/server').render(context.exports.default).body;
  for (const id of ['audit-date', 'audit-category', 'audit-level']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, />Refresh</);
  assert.doesNotMatch(html, /Load older entries/);
});

test('latest filters own the response and older pages retain complete records and their original summary', async () => {
  const ui = screen();
  const first = ui.run('loadAudit()');
  ui.run("selectedCategory = 'security'; selectedLevel = 'error'");
  const filtered = ui.run('loadAudit()');
  assert.equal(ui.requests[0].signal.aborted, true);
  const query = new URL(ui.requests[1].url, 'http://fixture').searchParams;
  assert.equal(query.get('category'), 'security'); assert.equal(query.get('level'), 'error');
  ui.requests[1].resolve(reply(page('newest', 123))); await filtered;
  ui.requests[0].resolve(reply(page('stale'))); await first;
  assert.equal(ui.run('entries[0].event'), 'newest');
  const older = ui.run('loadAudit(true)');
  assert.equal(new URL(ui.requests[2].url, 'http://fixture').searchParams.get('before'), '123');
  ui.requests[2].resolve(reply(page('older', null, false))); await older;
  assert.equal(ui.run('entries.map(entry => entry.event).join(",")'), 'newest,older');
  assert.equal(ui.run('entries[1].details.text'), '🤖'.repeat(18000));
  assert.equal(ui.run('summary.total'), 2); assert.equal(ui.run('matched'), 2);
  assert.equal(ui.run('nextCursor'), null); assert.equal(ui.run('loading'), false);
});

test('failed reads release loading and can be retried without losing an older-page cursor', async () => {
  const ui = screen();
  const failed = ui.run('loadAudit()'); ui.requests[0].resolve(reply({ error: 'History unavailable' }, 500)); await failed;
  assert.equal(ui.run('error'), 'History unavailable'); assert.equal(ui.run('loading'), false);
  const retry = ui.run('loadAudit()'); ui.requests[1].resolve(reply(page('first', 42))); await retry;
  assert.equal(ui.run('error'), '');
  const more = ui.run('loadAudit(true)'); ui.requests[2].resolve(reply({ error: 'Page unavailable' }, 500)); await more;
  assert.equal(ui.run('entries.length'), 1); assert.equal(ui.run('nextCursor'), 42);
  assert.equal(ui.run('error'), 'Page unavailable'); assert.equal(ui.run('loading'), false);
  const retryPage = ui.run('loadAudit(true)'); ui.requests[3].resolve(reply(page('older', null, false))); await retryPage;
  assert.equal(ui.run('entries.length'), 2); assert.equal(ui.run('error'), '');
});

test('returning to the tab preserves loaded history; navigation aborts pending observation on repeated mounts', async () => {
  for (let cycle = 0; cycle < 2; cycle++) {
    const ui = screen(); const unmount = ui.mount();
    assert.equal(ui.requests.length, 1);
    assert.equal(getEventListeners(ui.document, 'visibilitychange').length, 0);
    ui.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(ui.requests.length, 1, 'focus must not discard paginated history');
    unmount(); assert.equal(ui.requests[0].signal.aborted, true);
    ui.requests[0].resolve(reply(page('late')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.run('entries.length'), 0);
  }
});
