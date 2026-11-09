import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Reuse AuthGate's actual-handler approach; HTTP is simulated, accounts are not created.
const component = readFileSync(new URL('./ProfileCreation.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('ProfileCreation.ts', component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function form(apiFetch: (url: string, options: RequestInit) => Promise<Response>) {
  const state = vm.createContext({ Error, apiFetch, console: { error() {} }, username: 'fixture', password: 'fixture-password',
    confirmPassword: 'fixture-password', displayName: ' Fixture ', email: ' fixture@example.invalid ', role: 'standard',
    creating: false, error: '', success: '', showForm: true });
  vm.runInContext(code, state);
  return state;
}

test('invalid account details stay editable and cancellation clears the existing draft and notices without a request', async () => {
  let requests = 0;
  const state = form(async () => { requests++; throw new Error('No request expected'); });
  state.confirmPassword = 'different-password';
  await state.handleCreate();
  assert.equal(requests, 0);
  assert.equal(state.error, 'Passwords do not match');
  assert.equal(state.password, 'fixture-password');
  assert.equal(state.showForm, true);
  state.success = 'Previous notice';
  state.handleCancel();
  assert.equal(state.showForm, false);
  assert.equal(state.password, '');
  assert.equal(state.confirmPassword, '');
  assert.equal(state.username, '');
  assert.equal(state.displayName, '');
  assert.equal(state.email, '');
  assert.equal(state.role, 'standard');
  assert.equal(state.error, '');
  assert.equal(state.success, '');
});

test('each role uses the canonical create route, preserves a failed draft, and resets only after acknowledged creation', async () => {
  for (const [role, message] of [['owner', 'owner privileges'], ['standard', 'full access to their own profile'], ['guest', 'read-only guest']]) {
    let finish!: (response: Response) => void;
    const requests: Record<string, unknown>[] = [];
    const state = form(async (url, options) => {
      assert.equal(url, '/api/profiles/create');
      assert.equal(options.method, 'POST');
      requests.push(JSON.parse(String(options.body)));
      return new Promise(resolve => { finish = resolve; });
    });
    state.role = role;
    const failed = state.handleCreate();
    assert.equal(state.creating, true);
    assert.equal(state.username, 'fixture', 'admission alone cannot clear the draft');
    finish(Response.json({ error: 'Profile initialization failed' }, { status: 500 }));
    await failed;
    assert.equal(state.error, 'Profile initialization failed');
    assert.equal(state.success, '');
    assert.equal(state.password, 'fixture-password');
    assert.equal(state.role, role);
    assert.equal(state.showForm, true);
    assert.equal(state.creating, false);

    const created = state.handleCreate();
    assert.deepEqual(requests[1], { username: 'fixture', password: 'fixture-password', displayName: 'Fixture', email: 'fixture@example.invalid', role });
    finish(Response.json({ success: true }, { status: 201 }));
    await created;
    assert.match(state.success, new RegExp(`Profile 'fixture' created successfully!.*${message}`));
    assert.equal(state.username, '');
    assert.equal(state.password, '');
    assert.equal(state.confirmPassword, '');
    assert.equal(state.displayName, '');
    assert.equal(state.email, '');
    assert.equal(state.role, 'standard');
    assert.equal(state.showForm, false);
    assert.equal(state.error, '');
    assert.equal(state.creating, false);
    state.handleCancel();
    assert.equal(state.success, '', 'the shared reset also clears notices on cancellation');
  }
});
