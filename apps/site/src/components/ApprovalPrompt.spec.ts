import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { derived, get, writable } from 'svelte/store';

// Reuse AgencyDashboard.spec.ts's real-handler/lifecycle approach. Only HTTP
// and the mounted Coordinator consumer are fixtures; no approval is executed.
const source = readFileSync(new URL('./ApprovalPrompt.svelte', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ApprovalPrompt.ts', source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node)
  || ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === 'onMount').map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const desire = (id: string, status = 'awaiting_approval') => ({ id, title: id, status });

function prompt(apiFetch: (url: string, options?: RequestInit) => Promise<Response>) {
  const owner = writable(true);
  const user = writable<{ username: string } | null>({ username: 'first-owner' });
  const snapshots = writable<any>(null);
  const connection = writable('live');
  let mounted!: () => () => void;
  let consumers = 0;
  const state = vm.createContext({ apiFetch, AbortController, encodeURIComponent, console, derived, get,
    $isOwner: true, isOwner: owner, currentUserStore: user, coordinatorSnapshot: snapshots, coordinatorConnection: connection,
    pendingDesires: [], processingId: null, loadError: '', actionError: '', expanded: false, expandedDesireId: null,
    observation: new AbortController(), listRead: null,
    onMount: (start: typeof mounted) => { mounted = start; },
    useWorkCoordinator: () => { consumers++; let released = false; return () => { if (!released) { released = true; consumers--; } }; },
    setInterval() { throw new Error('ApprovalPrompt must not poll'); },
    setTimeout() { throw new Error('Approval errors must not disappear on a timer'); },
  });
  vm.runInContext(code, state);
  return { state, user, snapshots, connection, mount: () => mounted(), consumers: () => consumers,
    setOwner(value: boolean) { state.$isOwner = value; owner.set(value); } };
}

test('Desire approvals use committed Agency changes and reconnect, release on navigation and never read trust', async () => {
  const requests: string[] = [];
  const view = prompt(async url => { requests.push(url); return Response.json({ desires: [desire('pending'), desire('done', 'completed')] }); });
  for (let cycle = 0; cycle < 2; cycle++) {
    const release = view.mount();
    await settle();
    assert.equal(view.consumers(), 1);
    assert.equal(view.state.pendingDesires.length, 1);
    const before = requests.length;
    view.snapshots.set({ agencyChange: { revision: `cycle-${cycle}` } });
    await settle();
    assert.equal(requests.length, before + 1);
    view.snapshots.set({ agencyChange: { revision: `cycle-${cycle}` }, tasks: [{ id: 'unrelated' }] });
    await settle();
    assert.equal(requests.length, before + 1, 'ordinary queue traffic does not refresh approvals');
    view.connection.set('reconnecting'); view.connection.set('live');
    await settle();
    assert.equal(requests.length, before + 2);
    release();
    assert.equal(view.consumers(), 0);
    view.snapshots.set({ agencyChange: { revision: `after-${cycle}` } });
    view.connection.set('reconnecting'); view.connection.set('live');
    await settle();
    assert.equal(requests.length, before + 2, 'unmounted approvals must not fetch');
  }
  assert.ok(requests.every(url => url === '/api/agency/desires?status=awaiting_approval'));
});

test('newer reads and profile changes cannot display stale approvals; failures remain visible without dropping known data', async () => {
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const view = prompt((_url, options) => new Promise(resolve => requests.push({ signal: options!.signal as AbortSignal, resolve })));
  const release = view.mount();
  try {
    view.snapshots.set({ agencyChange: { revision: 'newer' } });
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve(Response.json({ desires: [desire('new')] })); await settle();
    requests[0].resolve(Response.json({ desires: [desire('old')] })); await settle();
    assert.equal(view.state.pendingDesires[0].id, 'new');
    view.snapshots.set({ agencyChange: { revision: 'failed' } });
    requests[2].resolve(Response.json({ error: 'Storage locked' }, { status: 423 })); await settle();
    assert.equal(view.state.loadError, 'Storage locked');
    assert.equal(view.state.pendingDesires[0].id, 'new');
    view.snapshots.set({ agencyChange: { revision: 'old-profile' } });
    view.user.set({ username: 'second-owner' });
    assert.equal(requests[3].signal.aborted, true);
    assert.equal(view.state.pendingDesires.length, 0);
    requests[4].resolve(Response.json({ desires: [desire('second-profile')] })); await settle();
    requests[3].resolve(Response.json({ desires: [desire('first-profile')] })); await settle();
    assert.equal(view.state.pendingDesires[0].id, 'second-profile');
    assert.equal(view.state.loadError, '');
    view.setOwner(false);
    assert.equal(view.consumers(), 0);
    assert.equal(view.state.pendingDesires.length, 0);
    const before = requests.length;
    view.snapshots.set({ agencyChange: { revision: 'guest' } }); await settle();
    await view.state.handleDecision('second-profile', 'approve');
    await view.state.handleApproveAll();
    assert.equal(requests.length, before);
  } finally { release(); }
});

test('decisions retain the canonical routes and errors while committed state owns removal', async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  let finish!: (response: Response) => void;
  let remaining = [desire('one'), desire('two')];
  const view = prompt(async (url, options) => {
    requests.push({ url, options });
    if (options?.method === 'POST') return new Promise(resolve => { finish = resolve; });
    return Response.json({ desires: remaining });
  });
  const release = view.mount(); await settle();
  try {
    let stopped = false;
    const first = view.state.handleDecision('one', 'approve', { stopPropagation() { stopped = true; } });
    await view.state.handleDecision('two', 'reject');
    assert.equal(requests.length, 2, 'the existing decision exclusion also covers another row');
    assert.equal(stopped, true);
    assert.equal(requests[1].url, '/api/agency/desires/one/approve');
    finish(Response.json({ success: true })); await first;
    assert.equal(view.state.pendingDesires.length, 2, 'an acknowledgement is not a second inventory owner');
    remaining = [desire('two')];
    view.snapshots.set({ agencyChange: { revision: 'approved' } }); await settle();
    assert.equal(view.state.pendingDesires.length, 1);
    const rejected = view.state.handleDecision('two', 'reject');
    assert.equal(requests.at(-1)!.url, '/api/agency/desires/two/reject');
    assert.equal(JSON.parse(String(requests.at(-1)!.options!.body)).reason, 'User rejected');
    finish(Response.json({ error: 'Current plan changed' }, { status: 409 })); await rejected;
    assert.equal(view.state.actionError, 'Current plan changed');
    assert.equal(view.state.processingId, null);
    assert.equal(view.state.pendingDesires[0].id, 'two');
  } finally { release(); }
});

test('Approve All admits each selected desire once, reports every failure and does not replay on navigation', async () => {
  const posts: string[] = [];
  let pending = [desire('one'), desire('two'), desire('three')];
  const view = prompt(async (url, options) => {
    if (options?.method !== 'POST') return Response.json({ desires: pending });
    posts.push(url);
    return url.includes('/two/') ? Response.json({ success: true }) : Response.json({ error: 'Approval failed' }, { status: 500 });
  });
  let release = view.mount(); await settle();
  const batch = view.state.handleApproveAll();
  await view.state.handleApproveAll();
  await batch;
  assert.equal(posts.length, 3);
  assert.match(view.state.actionError, /one: Approval failed/);
  assert.match(view.state.actionError, /three: Approval failed/);
  assert.equal(view.state.processingId, null);
  release();
  pending = [desire('one'), desire('three')];
  release = view.mount(); await settle();
  assert.equal(posts.length, 3, 'remount only reloads pending state');
  release();
});

test('navigation releases observation while the selected approval batch continues without replay', async () => {
  let finish!: (response: Response) => void;
  let mutations = 0;
  const view = prompt(async (_url, options) => {
    if (options?.method !== 'POST') return Response.json({ desires: [desire('one'), desire('two')] });
    mutations++;
    assert.equal(options.signal, undefined, 'view teardown must not cancel a decision request');
    if (mutations > 1) return Response.json({ success: true });
    return new Promise(resolve => { finish = resolve; });
  });
  const release = view.mount(); await settle();
  const batch = view.state.handleApproveAll();
  release();
  finish(Response.json({ success: true })); await batch;
  assert.equal(mutations, 2, 'Approve All retains its selected work when the view closes');
  assert.equal(view.consumers(), 0);
});

test('a profile switch does not send remaining approvals using another account', async () => {
  let finish!: (response: Response) => void;
  let mutations = 0;
  const view = prompt(async (_url, options) => {
    if (options?.method !== 'POST') return Response.json({ desires: get(view.user)?.username === 'first-owner'
      ? [desire('one'), desire('two')] : [] });
    mutations++;
    return new Promise(resolve => { finish = resolve; });
  });
  const release = view.mount(); await settle();
  try {
    const batch = view.state.handleApproveAll();
    view.user.set({ username: 'second-owner' });
    finish(Response.json({ success: true })); await batch; await settle();
    assert.equal(mutations, 1);
    assert.equal(view.state.pendingDesires.length, 0);
  } finally { release(); }
});
