import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const text = readFileSync(new URL('./ProjectDashboard.svelte', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ProjectDashboard.ts', text.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function handlers(apiFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const state: vm.Context = vm.createContext({ JSON, encodeURIComponent, apiFetch, projects: null, actionableTasks: null, blockedTasks: null,
    disposed: false, requests: { projects: 0, actionable: 0, blocked: 0 }, published: { projects: 0, actionable: 0, blocked: 0 }, loading: false, error: '', readErrors: { projects: '', actionable: '', blocked: '' }, selectedProject: null,
    projectTasks: null, projectRead: 0, projectError: '', showCreateModal: true, newProject: { title: 'First', description: '', priority: 'P2', targetDate: '' } });
  vm.runInContext(code, state);
  return state;
}

test('Project reads expose independent failures and preserve known data until successful replacement', async () => {
  let failed = true;
  const state = handlers(async url => failed ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(url === '/api/projects' ? { projects: [{ id: 'one' }] } : { tasks: [{ id: url }] }));
  await state.loadAll();
  assert.equal(Object.is(state.projects, null), true); assert.equal(Object.is(state.actionableTasks, null), true); assert.equal(Object.is(state.blockedTasks, null), true);
  assert.ok(Object.values(state.readErrors).every(Boolean));
  failed = false; await state.loadAll();
  assert.equal(state.projects[0].id, 'one'); assert.ok(Object.values(state.readErrors).every(value => value === ''));
  failed = true; await state.loadAll();
  assert.equal(state.projects[0].id, 'one'); assert.equal(state.actionableTasks.length, 1);
});

test('Project tasks belong only to the currently selected project, including close and read failure', async () => {
  const reads: { url: string; finish: (response: Response) => void }[] = [];
  const state = handlers(url => new Promise(resolve => reads.push({ url, finish: resolve })));
  const one = { id: 'one / first', title: 'One' }, two = { id: 'two', title: 'Two' };
  const first = state.selectProject(one); const second = state.selectProject(two);
  assert.equal(Object.is(state.projectTasks, null), true);
  reads[1].finish(Response.json({ tasks: [{ id: 'second' }] })); await second;
  reads[0].finish(Response.json({ tasks: [{ id: 'old' }] })); await first;
  assert.equal(state.projectTasks[0].id, 'second'); assert.equal(reads[0].url, '/api/projects/one%20%2F%20first');
  const third = state.selectProject(one); reads[2].finish(Response.json({ error: 'Locked' }, { status: 423 })); await third;
  assert.equal(Object.is(state.projectTasks, null), true); assert.match(state.projectError, /Failed to load project/);
  const closed = state.selectProject(two); state.selectedProject = null;
  reads[3].finish(Response.json({ tasks: [{ id: 'closed' }] })); await closed;
  assert.equal(Object.is(state.projectTasks, null), true);
});

test('Project create acknowledgements preserve newer fields and a replacement draft', async () => {
  let finish!: (response: Response) => void;
  const state = handlers(async (_url, init) => init ? new Promise(resolve => { finish = resolve; }) : Response.json({ projects: [] }));
  let pending = state.createProject(); state.newProject.title = 'Newer title';
  finish(Response.json({ success: true })); await pending;
  assert.equal(state.newProject.title, 'Newer title'); assert.equal(state.showCreateModal, true);
  pending = state.createProject(); state.newProject = { title: 'Replacement' };
  finish(Response.json({ success: true })); await pending;
  assert.equal(state.newProject.title, 'Replacement');
  pending = state.createProject(); finish(Response.json({ success: true })); await pending;
  assert.equal(state.newProject.title, ''); assert.equal(state.showCreateModal, false);
});


test('approved read publication preserves newer success/error and drops completions after view release', async () => {
  for (const newerFailure of [false, true]) for (const olderFailure of [false, true]) {
    const replies: Array<(response: Response) => void> = [];
    const state = handlers(() => new Promise(resolve => replies.push(resolve)));
    const old = state.loadProjects(); const recent = state.loadProjects();
    assert.equal(replies.length, 2, 'both requests start concurrently');
    replies[1](newerFailure ? Response.json({ error: 'New read failed' }, { status: 503 }) : Response.json({ projects: [{ id: 'new' }], completedTasks: [] }));
    await recent;
    replies[0](olderFailure ? Response.json({ error: 'Old read failed' }, { status: 503 }) : Response.json({ projects: [{ id: 'old' }], completedTasks: [] }));
    await old;
    if (newerFailure) assert.match(state.readErrors.projects, /New read failed|Failed to load tasks/);
    else assert.equal(state.projects[0].id, 'new');
    const last = state.loadProjects(); state.disposed = true;
    replies[2](Response.json({ projects: [{ id: 'closed' }], completedTasks: [] })); await last;
    assert.notEqual(state.projects?.[0]?.id, 'closed');
  }
});


test('each project selection owns its read even when reopening the identical project object', async () => {
  const replies: Array<(response: Response) => void> = [];
  const state = handlers(() => new Promise(resolve => replies.push(resolve)));
  const project = { id: 'same', title: 'Same' };
  const old = state.selectProject(project); state.selectedProject = null;
  const current = state.selectProject(project);
  replies[1](Response.json({ error: 'Newest failed' }, { status: 503 })); await current;
  replies[0](Response.json({ tasks: [{ id: 'old' }] })); await old;
  assert.equal(Object.is(state.projectTasks, null), true);
  assert.match(state.projectError, /Failed to load project/);
  const firstA = state.selectProject(project);
  const other = state.selectProject({ id: 'other' });
  const secondA = state.selectProject(project);
  replies[4](Response.json({ tasks: [{ id: 'new-a' }] })); await secondA;
  replies[3](Response.json({ tasks: [{ id: 'b' }] })); await other;
  replies[2](Response.json({ tasks: [{ id: 'old-a' }] })); await firstA;
  assert.equal(state.projectTasks[0].id, 'new-a');
});

test('project create retry clears its action error while unrelated reads preserve it', async () => {
  let fail = true;
  const state = handlers(async (_url, init) => init && fail ? Response.json({}, { status: 503 }) : Response.json({ projects: [] }));
  await state.createProject(); assert.match(state.error, /Failed to create project/);
  await state.loadProjects(); assert.match(state.error, /Failed to create project/);
  fail = false; await state.createProject(); assert.equal(state.error, '');
});
