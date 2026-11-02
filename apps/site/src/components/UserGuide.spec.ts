import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real component lifecycle, as in AuthGate.spec.ts. Only the
// browser and HTTP boundary are fixtures; mount and navigation handlers run.
const component = readFileSync(new URL('./UserGuide.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('UserGuide.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const handlers = ['loadGuide', 'handleHashChange', 'loadChapter'];
const code = ts.transpileModule(source.statements.filter(statement =>
  (ts.isFunctionDeclaration(statement) && handlers.includes(statement.name!.text))
  || (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(source) === 'onMount'))
  .map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const outcome of ['success', 'failure', 'unmount while loading'] as const) {
  test(`guide releases hash navigation on ${outcome} and repeated mount`, async () => {
    for (let cycle = 0; cycle < 2; cycle++) {
      let mounted!: () => (() => void);
      let finish!: (response: Response) => void;
      const requests: string[] = [];
      const windowFixture = Object.assign(new EventTarget(), { location: { hash: '' } });
      const state = vm.createContext({
        onMount: (callback: typeof mounted) => { mounted = callback; },
        apiFetch: (url: string) => {
          requests.push(url);
          if (url === '/api/user-guide') return new Promise<Response>(resolve => { finish = resolve; });
          return Promise.resolve(new Response(JSON.stringify({ chapter: { id: 'second' }, prev: null, next: null })));
        },
        window: windowFixture, history: { replaceState() {} },
        document: { querySelector: () => null },
        console: { error() {} },
        categories: [], chapters: [], currentChapter: null, prevChapter: null, nextChapter: null,
        loading: true, error: '',
      });
      vm.runInContext(code, state);
      const unmount = mounted();
      assert.equal(typeof unmount, 'function', 'Svelte requires synchronous registration of cleanup');
      if (outcome === 'unmount while loading') unmount();
      finish(new Response(JSON.stringify({ categories: [] }), { status: outcome === 'failure' ? 500 : 200 }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(state.loading, false);
      assert.equal(state.error, outcome === 'failure' ? 'Failed to load user guide' : '');
      windowFixture.location.hash = '#second';
      windowFixture.dispatchEvent(new Event('hashchange'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.length, outcome === 'unmount while loading' ? 1 : 2);
      unmount();
      const count = requests.length;
      windowFixture.location.hash = '#third';
      windowFixture.dispatchEvent(new Event('hashchange'));
      assert.equal(requests.length, count, 'unmounted guide must not request another chapter');
    }
  });
}
