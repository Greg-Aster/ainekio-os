import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./SystemSettings.svelte', import.meta.url), 'utf8');
const script = ts.createSourceFile('SystemSettings.ts', source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(script.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(script)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(respond: (url: string, options?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const context = vm.createContext({ onMount() {}, apiFetch: (url: string, options?: RequestInit) => { calls.push(url); return respond(url, options); },
    console: { error() {} }, alert() {}, confirm: () => true });
  vm.runInContext(code, context);
  return { context, calls, run: (text: string): any => vm.runInContext(text, context) };
}

test('failed native content-mode changes retain the acknowledged server value in state and the select', async () => {
  for (const [state, handler] of [['reflectorContentMode', 'handleReflectorContentModeChange'], ['indexContentMode', 'handleIndexContentModeChange']]) {
    const f = fixture(() => json({ error: 'Write failed' }, 500));
    f.run(`${state} = 'agent'`);
    const target = { value: 'all' };
    f.context.event = { target };
    await f.run(`${handler}(event)`);
    assert.equal(f.run(state), 'agent');
    assert.equal(target.value, 'agent');
  }
});

test('a saved boot setting followed by a failed refresh reports the refresh failure', async () => {
  const f = fixture((_url, options) => options?.method === 'POST' ? json({ success: true }) : json({ error: 'Snapshot unavailable' }, 503));
  f.run("bootAgents = [{agentId:'voice',displayName:'Voice',enabled:true}]");
  await f.run("saveBootAgentVariable(bootAgents[0], 'enabled', false)");
  assert.equal(f.run('bootManagerFeedback.type'), 'error');
  assert.match(f.run('bootManagerFeedback.text'), /refresh|load|snapshot/i);
});

test('failed initial reads do not present defaults as acknowledged server configuration', async () => {
  const f = fixture(() => json({ error: 'Read unavailable' }, 503));
  for (const operation of ['loadAuditLoggingState()', 'loadReflectorContentMode()', 'loadIndexContentMode()', 'loadLoggingConfig()']) await f.run(operation);
  assert.equal(f.run('auditLoggingEnabled'), null);
  assert.equal(f.run('reflectorContentMode'), '');
  assert.equal(f.run('indexContentMode'), '');
  assert.equal(f.run('logLevel'), '');
});

test('successful content-mode writes keep their existing owner and payload contracts', async () => {
  const writes: Array<{ url: string; method?: string; body: any }> = [];
  const f = fixture((url, options) => {
    writes.push({ url, method: options?.method, body: JSON.parse(String(options?.body)) });
    return json({ success: true });
  });
  f.context.event = { target: { value: 'all' } };
  await f.run('handleReflectorContentModeChange(event)');
  await f.run('handleIndexContentModeChange(event)');
  assert.equal(f.run('reflectorContentMode'), 'all');
  assert.equal(f.run('indexContentMode'), 'all');
  assert.deepEqual(writes, [
    { url: '/api/trigger-manager/config', method: 'PATCH', body: { globalSettings: { memoryContentMode: 'all' } } },
    { url: '/api/embeddings', method: 'POST', body: { indexContentMode: 'all' } },
  ]);
});

test('successful boot writes report success only after an acknowledged refreshed snapshot', async () => {
  const f = fixture((_url, options) => options?.method === 'POST' ? json({ success: true })
    : json({ bootAgents: [{ agentId: 'voice', displayName: 'Voice', enabled: false }] }));
  f.run("bootAgents = [{agentId:'voice',displayName:'Voice',enabled:true}]");
  const target = { checked: false };
  f.context.event = { currentTarget: target };
  await f.run("saveBootAgentVariable(bootAgents[0], 'enabled', false, event)");
  assert.equal(f.run('bootManagerFeedback.type'), 'success');
  assert.equal(f.run('bootAgents[0].enabled'), false);
  assert.equal(target.checked, false);
  assert.equal(f.run('bootManagerSaving'), '');
});

test('audit purge retains server retention and confirmation; cancellation sends no request', async () => {
  const f = fixture(() => json({ enabled: true, retentionDays: 19 }));
  await f.run('loadAuditLoggingState()');
  assert.equal(f.run('auditLoggingEnabled'), true);
  assert.equal(f.run('auditRetentionDays'), 19);
  const before = f.calls.length;
  f.context.confirm = (message: string) => { assert.match(message, /19 days/); return false; };
  await f.run('purgeOldAuditLogs()');
  assert.equal(f.calls.length, before);
});

test('failed settings reads expose their reason and clear it when the existing loader recovers', async () => {
  for (const [loader, error, body] of [
    ['loadAuditLoggingState', 'auditError', { enabled: true, retentionDays: 9 }],
    ['loadReflectorContentMode', 'reflectorError', { snapshot: { globalSettings: { memoryContentMode: 'agent' } } }],
    ['loadIndexContentMode', 'indexError', { indexContentMode: 'agent' }],
    ['loadModelInfo', 'modelInfoError', { activeModel: 'Fixture' }],
    ['loadStorageStatus', 'storageError', { authenticated: false }],
    ['loadLoggingConfig', 'loggingMessage', { level: 'warn' }],
  ] as const) {
    let fail = true;
    const f = fixture(() => fail ? json({ error: 'Fixture read unavailable' }, 503) : json(body));
    await f.run(`${loader}()`);
    assert.equal(f.run(error), 'Fixture read unavailable');
    fail = false;
    await f.run(`${loader}()`);
    assert.equal(f.run(error), '');
  }
});

test('malformed boot acknowledgement stays an error instead of being accepted as empty success', async () => {
  const f = fixture((_url, options) => options?.method === 'POST' ? new Response('invalid JSON') : json({ bootAgents: [] }));
  await f.run("saveBootAgentVariable({agentId:'voice',displayName:'Voice'}, 'enabled', true)");
  assert.equal(f.run('bootManagerFeedback.type'), 'error');
});
