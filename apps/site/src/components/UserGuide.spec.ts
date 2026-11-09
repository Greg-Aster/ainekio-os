import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the component script with fixture HTTP/browser APIs and invoke its
// registered mount callback. This checks lifecycle handlers, not rendered DOM.
const component = readFileSync(new URL('./UserGuide.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('UserGuide.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function guideFixture(fetcher: (url: string, options?: RequestInit) => Promise<Response>, windowFixture = Object.assign(new EventTarget(), { location: { hash: '' } })) {
  let mounted!: () => (() => void);
  const requests: { url: string; options?: RequestInit }[] = [];
  const hashes: string[] = [];
  const state = vm.createContext({
    AbortController, Error, console,
    onMount: (callback: typeof mounted) => { mounted = callback; },
    apiFetch: (url: string, options?: RequestInit) => { requests.push({ url, options }); return fetcher(url, options); },
    window: windowFixture,
    history: { replaceState(_state: unknown, _title: string, hash: string) { hashes.push(hash); windowFixture.location.hash = hash; } },
    document: { querySelector: () => null },
  });
  vm.runInContext(code, state);
  return { requests, hashes, window: windowFixture, run: (expression: string) => vm.runInContext(expression, state),
    mount: () => mounted() };
}

for (const outcome of ['success', 'failure', 'unmount while loading'] as const) {
  test(`guide releases hash navigation on ${outcome} and repeated mount`, async () => {
    const windowFixture = Object.assign(new EventTarget(), { location: { hash: '' } });
    for (let cycle = 0; cycle < 2; cycle++) {
      let finish!: (response: Response) => void;
      windowFixture.location.hash = '';
      assert.equal(getEventListeners(windowFixture, 'hashchange').length, 0);
      const ui = guideFixture(url => url === '/api/user-guide'
        ? new Promise(resolve => { finish = resolve; })
        : Promise.resolve(new Response(JSON.stringify({ chapter: { id: 'second' }, prev: null, next: null }))), windowFixture);
      const unmount = ui.mount();
      assert.equal(typeof unmount, 'function', 'Svelte requires synchronous registration of cleanup');
      assert.equal(getEventListeners(windowFixture, 'hashchange').length, 1);
      if (outcome === 'unmount while loading') {
        unmount();
        assert.equal(getEventListeners(windowFixture, 'hashchange').length, 0, 'navigation releases the listener before the pending read finishes');
      }
      finish(new Response(JSON.stringify({ categories: [] }), { status: outcome === 'failure' ? 500 : 200 }));
      await new Promise(resolve => setImmediate(resolve));
      if (outcome !== 'unmount while loading') {
        assert.equal(ui.run('loading'), false);
        assert.equal(ui.run('error'), outcome === 'failure' ? 'Failed to load user guide' : '');
      }
      windowFixture.location.hash = '#second';
      windowFixture.dispatchEvent(new Event('hashchange'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(ui.requests.length, outcome === 'unmount while loading' ? 1 : 2);
      if (outcome !== 'unmount while loading') {
        assert.equal(ui.run('currentChapter?.id'), 'second');
        unmount();
      }
      assert.equal(getEventListeners(windowFixture, 'hashchange').length, 0);
      const count = ui.requests.length;
      windowFixture.location.hash = '#third';
      windowFixture.dispatchEvent(new Event('hashchange'));
      assert.equal(ui.requests.length, count, 'unmounted guide must not request another chapter');
    }
  });
}

test('guide commits only the latest chapter selection and cannot change the hash after unmount', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = guideFixture(url => url === '/api/user-guide' ? Promise.resolve(new Response('{"categories":[]}'))
    : new Promise(resolve => finishes.push(resolve)));
  const unmount = ui.mount(); await new Promise(resolve => setImmediate(resolve));
  const first = ui.run("loadChapter('first')"); const second = ui.run("loadChapter('second')");
  finishes[1](new Response('{"chapter":{"id":"second","content":"new chapter"},"prev":null,"next":null}')); await second;
  finishes[0](new Response('{"chapter":{"id":"first","content":"old chapter"},"prev":null,"next":null}')); await first;
  assert.equal(ui.run('currentChapter.id'), 'second'); assert.deepEqual(ui.hashes, ['#second']);
  assert.equal(ui.requests[1].options?.signal?.aborted, true);
  const closing = ui.run("loadChapter('closing')"); unmount();
  finishes[2](new Response('{"chapter":{"id":"closing"},"prev":null,"next":null}')); await closing;
  assert.equal(ui.run('currentChapter.id'), 'second'); assert.deepEqual(ui.hashes, ['#second']);
});

test('guide exposes chapter read failure, retains the received chapter and retries the selected chapter', async () => {
  let fail = false;
  const ui = guideFixture(async url => url === '/api/user-guide' ? new Response('{"categories":[]}')
    : fail ? new Response('{"error":"Fixture chapter unavailable"}', { status: 500 })
      : new Response(JSON.stringify({ chapter: { id: url.split('/').at(-1), content: 'retained' }, prev: null, next: null })));
  const unmount = ui.mount(); await new Promise(resolve => setImmediate(resolve));
  await ui.run("loadChapter('readable')"); fail = true;
  await ui.run("loadChapter('missing')");
  assert.equal(ui.run('chapterError'), 'Fixture chapter unavailable');
  assert.equal(ui.run('currentChapter.content'), 'retained'); assert.deepEqual(ui.hashes, ['#readable']);
  fail = false;
  await ui.run('loadChapter(selectedChapterId)');
  assert.equal(ui.requests.at(-1)?.url, '/api/user-guide/missing');
  assert.equal(ui.run('chapterError'), '');
  assert.equal(ui.run('currentChapter.id'), 'missing');
  assert.deepEqual(ui.hashes, ['#readable', '#missing']);
  unmount();
});

test('guide replacing, clearing and leaving search releases old results and preserves existing validation', async () => {
  const finishes: Array<(response: Response) => void> = [];
  const ui = guideFixture(url => url === '/api/user-guide' ? Promise.resolve(new Response('{"categories":[]}'))
    : new Promise(resolve => finishes.push(resolve)));
  const unmount = ui.mount(); await new Promise(resolve => setImmediate(resolve));
  ui.run("searchQuery = 'first'"); const first = ui.run('searchGuide()');
  ui.run("searchQuery = 'second'"); const second = ui.run('searchGuide()');
  finishes[1](new Response('{"results":[{"id":"second"}]}')); await second;
  finishes[0](new Response('{"results":[{"id":"first"}]}')); await first;
  assert.equal(ui.run('searchResults[0].id'), 'second');
  ui.run("searchQuery = 'cleared'"); const clearing = ui.run('searchGuide()'); ui.run('clearSearch()');
  assert.equal(ui.run('searching'), false); assert.equal(ui.run('searchAttempted'), false);
  finishes[2](new Response('{"results":[{"id":"cleared"}]}')); await clearing;
  assert.equal(ui.run('searchResults.length'), 0);
  ui.run("searchQuery = 'x'"); const count = ui.requests.length; await ui.run('searchGuide()');
  assert.equal(ui.requests.length, count); assert.equal(ui.run('searchError'), 'Enter at least two characters.');
  ui.run("searchQuery = 'closing'"); const closing = ui.run('searchGuide()'); unmount();
  finishes[3](new Response('{"results":[{"id":"closing"}]}')); await closing;
  assert.equal(ui.run('searchResults.length'), 0);
  assert.equal(ui.requests.at(-1)?.options?.signal?.aborted, true);
});

test('guide does not start a chapter from a discarded index or repeat a hash selection when the index arrives', async () => {
  let finish!: (response: Response) => void;
  const ui = guideFixture(url => url === '/api/user-guide' ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(new Response('{"chapter":{"id":"selected"},"prev":null,"next":null}')));
  const unmount = ui.mount();
  ui.window.location.hash = '#selected'; ui.window.dispatchEvent(new Event('hashchange'));
  await new Promise(resolve => setImmediate(resolve));
  finish(new Response('{"categories":[{"id":"main","chapters":[{"id":"first"}]}]}'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.requests.length, 2, 'the index must not issue the selected chapter request again');
  unmount();
  const closed = guideFixture(() => new Promise(resolve => { finish = resolve; }));
  closed.window.location.hash = '#first'; const close = closed.mount(); close();
  finish(new Response('{"categories":[{"id":"main","chapters":[{"id":"first"}]}]}'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed.requests.length, 1, 'an unmounted index must not request its initial chapter');
});
