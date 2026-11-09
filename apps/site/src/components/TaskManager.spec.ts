import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const text = readFileSync(new URL('./TaskManager.svelte', import.meta.url), 'utf8');
const ast = ts.createSourceFile('TaskManager.ts', text.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function handlers(apiFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const state = vm.createContext({ Date, JSON, apiFetch, tasks: [], completedTasks: [], loading: false, error: '',
    disposed: false, requestId: 0, publishedRequest: 0, loadError: '', editingTaskId: null, editForm: {}, editSaving: false, newTaskTitle: '', showNewTask: false });
  vm.runInContext(code, state);
  return state;
}

test('Task local date edits preserve instants and explicitly clear due through the existing PATCH contract', async () => {
  const payloads: any[] = [];
  const state = handlers(async (_url, init) => { if (init) payloads.push(JSON.parse(String(init.body))); return Response.json({ tasks: [], completedTasks: [] }); });
  const date = new Date(2026, 9, 4, 13, 24, 12, 123);
  state.startEdit({ id: 'task', title: 'One', due: date.toISOString() });
  assert.equal(state.editForm.due, '2026-10-04T13:24:12.123');
  await state.saveEdit();
  assert.equal(payloads[0].due, date.toISOString());
  state.startEdit({ id: 'task', title: 'One', due: date.toISOString() });
  state.editForm.due = '';
  await state.saveEdit();
  assert.equal(payloads[1].due, '');
  assert.equal(payloads[1].taskId, 'task');
});

test('Task save acknowledgements preserve another edit and changes to the submitted draft', async () => {
  let finish!: (response: Response) => void;
  const state = handlers(async (_url, init) => init ? new Promise(resolve => { finish = resolve; }) : Response.json({ tasks: [], completedTasks: [] }));
  state.startEdit({ id: 'one', title: 'One' });
  let pending = state.saveEdit();
  state.startEdit({ id: 'two', title: 'Two' });
  finish(Response.json({ success: true })); await pending;
  assert.equal(state.editingTaskId, 'two'); assert.equal(state.editForm.title, 'Two');
  pending = state.saveEdit(); state.editForm.title = 'Newer two';
  finish(Response.json({ success: true })); await pending;
  assert.equal(state.editForm.title, 'Newer two');
  pending = state.saveEdit(); finish(Response.json({ success: true })); await pending;
  assert.equal(state.editingTaskId, null);
});

test('Task creation clears only the submitted title and reports failed writes', async () => {
  let finish!: (response: Response) => void;
  const state = handlers(async (_url, init) => init ? new Promise(resolve => { finish = resolve; }) : Response.json({ tasks: [], completedTasks: [] }));
  state.newTaskTitle = 'First'; state.showNewTask = true;
  const pending = state.createTask(); state.newTaskTitle = 'Second';
  finish(Response.json({ success: true })); await pending;
  assert.equal(state.newTaskTitle, 'Second'); assert.equal(state.showNewTask, true);
  const rejected = state.createTask(); finish(Response.json({ error: 'Locked' }, { status: 423 })); await rejected;
  assert.equal(state.newTaskTitle, 'Second'); assert.match(state.error, /Failed to create task/);
});

test('Task calendar and search use explicit supplied data rather than hidden component state', () => {
  const state = handlers(async () => Response.json({}));
  const tasks = [{ id: 'one', title: 'Alpha', status: 'todo', due: new Date(2026, 10, 5, 12).toISOString() },
    { id: 'two', title: 'Beta', status: 'todo', tags: ['needle'], due: new Date(2026, 10, 6, 12).toISOString() }];
  assert.equal(state.matchesSearch(tasks[0], 'beta'), false);
  assert.equal(state.matchesSearch(tasks[1], 'NEEDLE'), true);
  const calendar = state.buildCalendar(tasks.filter(task => state.matchesSearch(task, 'Beta')), new Date(2026, 10, 5));
  assert.equal(calendar.flatMap((day: any) => day.tasks).length, 1);
  assert.equal(calendar.flatMap((day: any) => day.tasks)[0].id, 'two');
});


test('approved read publication preserves newer success/error and drops completions after view release', async () => {
  for (const newerFailure of [false, true]) for (const olderFailure of [false, true]) {
    const replies: Array<(response: Response) => void> = [];
    const state = handlers(() => new Promise(resolve => replies.push(resolve)));
    const old = state.loadTasks(); const recent = state.loadTasks();
    assert.equal(replies.length, 2, 'both requests start concurrently');
    replies[1](newerFailure ? Response.json({ error: 'New read failed' }, { status: 503 }) : Response.json({ tasks: [{ id: 'new' }], completedTasks: [] }));
    await recent;
    replies[0](olderFailure ? Response.json({ error: 'Old read failed' }, { status: 503 }) : Response.json({ tasks: [{ id: 'old' }], completedTasks: [] }));
    await old;
    if (newerFailure) assert.match(state.loadError, /New read failed|Failed to load tasks/);
    else assert.equal(state.tasks[0].id, 'new');
    const last = state.loadTasks(); state.disposed = true;
    replies[2](Response.json({ tasks: [{ id: 'closed' }], completedTasks: [] })); await last;
    assert.notEqual(state.tasks?.[0]?.id, 'closed');
  }
});


test('task action retries clear their own failure while polls preserve it', async () => {
  let failed = true;
  const state = handlers(async (_url, init) => init && failed ? Response.json({}, { status: 503 }) : Response.json({ tasks: [], completedTasks: [] }));
  state.newTaskTitle = 'Create'; await state.createTask(); assert.match(state.error, /Failed to create task/);
  await state.loadTasks(); assert.match(state.error, /Failed to create task/);
  failed = false; await state.createTask(); assert.equal(state.error, '');
  failed = true; state.startEdit({ id: 'one', title: 'One' }); await state.saveEdit(); assert.match(state.error, /Failed to update task/);
  failed = false; await state.saveEdit(); assert.equal(state.error, '');
  failed = true; await state.updateTaskStatus('one', 'done'); assert.match(state.error, /Failed to update task/);
  failed = false; await state.updateTaskStatus('one', 'done'); assert.equal(state.error, '');
});
