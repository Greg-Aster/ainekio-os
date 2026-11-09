import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-api-registry-'));
process.env.METAHUMAN_ROOT = root;
const { setAuditEnabled } = await import('../audit.js');
const { eventBus } = await import('../infrastructure/event-bus/client.js');
const { withUserContext } = await import('../context.js');
const { getProfilePaths } = await import('../paths.js');
const { astroHandler } = await import('./adapters/astro.js');
const { routeRequest, listRoutes } = await import('./router.js');
const { storageClient } = await import('../storage-client.js');
setAuditEnabled(false);
eventBus.disconnect();
after(() => {
  eventBus.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});

const user = { userId: 'registry-fixture', username: 'registry-fixture', role: 'owner' as const };
function request(endpoint: string, method = 'GET', body?: unknown) {
  const url = new URL(endpoint, 'http://localhost');
  return withUserContext(user, () => astroHandler({
    url, request: new Request(url, { method, ...(body === undefined ? {} : {
      body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }) }),
    cookies: {}, params: {}, locals: { authResolved: true, userContext: user },
  }));
}

test('headless routes retain the persisted startup flag after unused lifecycle exports are retired', async () => {
  const runtime = await import('../runtime-mode.js');
  assert.equal('enterHeadlessMode' in runtime, false);
  assert.equal('exitHeadlessMode' in runtime, false);
  assert.equal((await (await request('/api/runtime/mode')).json()).headless, false);
  for (const headless of [true, false, true, false]) {
    const response = await request('/api/runtime/mode', 'POST', { headless, claimedBy: 'fixture-controller' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true); assert.equal(result.mode.headless, headless);
    assert.equal(runtime.isHeadless(), headless);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'etc/runtime.json'), 'utf8'));
    assert.equal(saved.headless, headless); assert.equal(saved.claimedBy, 'fixture-controller');
    assert.equal(saved.lastChangedBy, 'local');
    assert.equal((await (await request('/api/runtime/mode')).json()).headless, headless);
  }
});

test('retired browser memory sync routes cannot change preserved profile memories', async () => {
  for (const retired of ['apps/site/src/lib/client/memory-sync.ts', 'packages/core/src/api/handlers/memory-sync.ts', 'packages/core/src/api/handlers/memory-sync-item.ts']) {
    assert.equal(fs.existsSync(new URL(`../../../../${retired}`, import.meta.url)), false, retired);
  }
  const episodic = getProfilePaths(user.username).episodic;
  fs.mkdirSync(episodic, { recursive: true });
  const memory = { id: 'sync-fixture-memory', type: 'observation', content: 'Preserved sync fixture', timestamp: '2026-11-04T12:00:00Z' };
  const file = path.join(episodic, `${memory.id}.json`);
  const original = JSON.stringify(memory);
  fs.writeFileSync(file, original);
  for (const [method, endpoint, body] of [
    ['GET', '/api/memory/sync/pull', undefined],
    ['POST', '/api/memory/sync/push', { memory }],
    ['PUT', '/api/memory/sync/push', { memory: { ...memory, content: 'Rejected replacement' } }],
    ['GET', `/api/memory/sync/${memory.id}`, undefined],
    ['DELETE', `/api/memory/sync/${memory.id}`, undefined],
  ] as const) {
    assert.equal((await request(endpoint, method, body)).status, 404, `${method} ${endpoint}`);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'retirement must preserve the stored record');
  }
  const patterns = listRoutes().map(route => route.pattern);
  assert.ok(patterns.includes('/api/profile-sync/config'));
  assert.ok(patterns.includes('/api/profile-sync/memories'));
  assert.ok(!patterns.some(pattern => pattern.includes('/api/memory/sync')));
});

test('ProjectDashboard requests reach real project and task storage through Astro', async () => {
  const created = await request('/api/projects', 'POST', { title: 'Registry project' });
  assert.equal(created.status, 200);
  const projectId = (await created.json()).project.id;
  const fixture = await withUserContext(user, () => {
    const ready = { id: 'task-ready', title: 'Ready task', status: 'todo', projectId, dependencies: [] };
    const blocked = { id: 'task-blocked', title: 'Blocked task', status: 'todo', projectId, dependencies: [ready.id] };
    const directory = path.join(getProfilePaths(user.username).tasks, 'active');
    fs.mkdirSync(directory, { recursive: true });
    for (const task of [ready, blocked]) fs.writeFileSync(path.join(directory, `${task.id}.json`), JSON.stringify(task));
    return { projectId, ready, blocked };
  });
  for (const [endpoint, key, id] of [
    ['/api/projects', 'projects', fixture.projectId],
    ['/api/tasks/actionable', 'tasks', fixture.ready.id],
    ['/api/tasks/blocked', 'tasks', fixture.blocked.id],
  ]) {
    const response = await request(endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.ok((await response.json())[key].some((item: { id: string }) => item.id === id), endpoint);
  }
  const details = await request(`/api/projects/${fixture.projectId}`);
  assert.equal((await details.json()).tasks.length, 2);
});

test('Site delegates every API request to Core instead of maintaining a second route registry', () => {
  const directory = new URL('../../../../apps/site/src/pages/api/', import.meta.url);
  const files = fs.readdirSync(directory, { recursive: true }).filter(file => String(file).endsWith('.ts'));
  assert.deepEqual(files, ['[...path].ts']);
  const transport = fs.readFileSync(new URL('[...path].ts', directory), 'utf8');
  assert.match(transport, /export const ALL = astroHandler/);
});

test('profile migration POST is registered in Core and keeps its authentication requirement', async () => {
  const response = await routeRequest({ method: 'POST', path: '/api/profile-path', body: {},
    user: { userId: '', username: '', role: 'guest', isAuthenticated: false } });
  assert.equal(response.status, 401);
});

test('Core supplies voice sample parameters and Astro preserves binary data and response cookies', async () => {
  const sampleId = 'voice-sample-fixture';
  const result = storageClient.resolvePath({ username: user.username, category: 'voice', subcategory: 'training' });
  assert.equal(result.success, true);
  fs.mkdirSync(result.path!, { recursive: true });
  const wav = Buffer.from('RIFF fixture WAVE');
  fs.writeFileSync(path.join(result.path!, `${sampleId}.wav`), wav);
  const response = await request(`/api/voice-samples/${sampleId}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type')!, /audio\/wav/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  const encoded = await request('/api/voice-samples/voice%2Dsample%2Dfixture');
  assert.equal(encoded.status, 200);
  assert.deepEqual(Buffer.from(await encoded.arrayBuffer()), wav);
  const logout = await request('/api/auth/logout', 'POST');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie')!, /mh_session=; Max-Age=0/);
});

test('retired HTTP surfaces cannot dispatch executable handlers through the catch-all', async () => {
  const paths: Array<[string, string[]]> = [
    ['/api/approvals', ['GET', 'POST']],
    ['/api/operator-proposals/stream', ['GET']],
    ['/api/operator-proposals/respond', ['POST']],
    ['/api/operator-proposals/post-feedback', ['POST']],
    ['/api/active-operator/approvals', ['GET', 'POST']],
    ['/api/active-operator/proposals', ['GET', 'POST']],
    ...['generate-plan', 'outcome-review', 'retry', 'run'].map(action => [`/api/agency/desires/fixture/${action}`, ['POST']] as [string, string[]]),
    ['/api/audit/clear', ['DELETE']], ['/api/big-brother-escalate', ['POST']],
    ['/api/curiosity-config', ['GET', 'POST']], ['/api/encryption', ['GET']],
    ...['lock', 'setup', 'unlock'].map(action => [`/api/encryption/${action}`, ['POST']] as [string, string[]]),
    ['/api/environment-bridge/control', ['POST']], ['/api/environment-bridge/diagnostics', ['GET']],
    ['/api/execute-graph', ['POST']], ['/api/execute', ['POST']], ['/api/export/conversations', ['POST']],
    ['/api/file_operations', ['GET', 'POST']], ['/api/fine-tune/models', ['GET']],
    ['/api/llm-backend/switch', ['POST']], ['/api/memories', ['GET']], ['/api/memories/search', ['GET']],
    ['/api/memory-metrics', ['GET']], ['/api/operator-proposals', ['GET']], ['/api/operator-proposals/review', ['POST']],
    ['/api/pause-state', ['GET', 'POST']],
    ...['persona-decision-rules', 'persona-relationships', 'persona-routines', 'persona', 'persona/summary',
      'profile-sync/user', 'remote-server/models', 'template-watch', 'template/fixture'].map(endpoint => [`/api/${endpoint}`, ['GET']] as [string, string[]]),
    ...['system-operator/backups', 'goal-reviews', 'voice/status', 'calendar/events', 'images/clip-status'].map(endpoint => [`/api/${endpoint}`, ['GET']] as [string, string[]]),
    ...['photos/ingest', 'documents/ingest', 'chats/ingest'].map(endpoint => [`/api/${endpoint}`, ['POST']] as [string, string[]]),
  ];
  for (const [endpoint, methods] of paths) for (const method of methods) {
    assert.equal((await request(endpoint, method, method === 'GET' ? undefined : {})).status, 404, `${method} ${endpoint}`);
  }
});

test('onboarding multipart uploads preserve bytes in the existing profile inbox without executing ingestion', async () => {
  const bytes = Buffer.from([0, 1, 2, 128, 255]);
  const paths: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('file', new File([bytes], 'context.pdf', { type: 'application/pdf' }));
    const url = new URL('http://localhost/api/ingest');
    const response = await withUserContext(user, () => astroHandler({
      url, request: new Request(url, { method: 'POST', body: form }),
      cookies: {}, params: {}, locals: { authResolved: true, userContext: user },
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state, 'stored-in-inbox');
    assert.ok(result.path.startsWith(getProfilePaths(user.username).inbox + path.sep));
    assert.deepEqual(fs.readFileSync(result.path), bytes);
    paths.push(result.path);
  }
  assert.notEqual(paths[0], paths[1], 'repeating a filename must preserve both uploaded originals');
  assert.equal(fs.existsSync(getProfilePaths('other-profile').inbox), false);
});

test('literal browser API requests have a registration in the single Core registry', () => {
  const routes = listRoutes();
  const site = new URL('../../../../apps/site/src/', import.meta.url);
  for (const directory of ['components', 'lib', 'stores']) {
    const root = new URL(directory + '/', site);
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(svelte|ts|js)$/.test(entry.name) || /\.(spec|test)\./.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:apiFetch|apiEventSource|apiUrl|fetch|EventSource)\(\s*(['"`])(\/api\/[^'"`]+)\1/g)) {
        if (match[2].includes('${')) continue;
        const endpoint = match[2].split('?')[0].replace(/\/$/, '');
        assert.ok(routes.some(route => route.pattern.startsWith('/api/')
          ? route.pattern === endpoint : new RegExp(route.pattern).test(endpoint)), `${file}: ${endpoint}`);
      }
    }
  }
});


test('retired operator proposal observation cannot mutate preserved proposal or feedback history', async () => {
  const state = getProfilePaths(user.username).state;
  const records = [
    ['operator-proposals/legacy.json', { id: 'legacy', status: 'pending', taskType: 'custom', createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z' }],
    ['operator-feedback/2000-01-01.json', [{ proposalId: 'legacy', response: 'rejected' }]],
    ['operator-post-feedback/2000-01-01.json', [{ proposalId: 'legacy', userRating: 'bad' }]],
  ] as const;
  for (const [name, data] of records) {
    const file = path.join(state, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  const abort = new AbortController();
  const result = await withUserContext(user, () => routeRequest({ method: 'GET', path: '/api/operator-proposals/stream',
    user: { ...user, isAuthenticated: true }, signal: abort.signal }));
  if (result.stream) {
    const iterator = result.stream[Symbol.asyncIterator]();
    try { await iterator.next(); await iterator.next(); }
    finally { abort.abort(); await iterator.return?.(); }
  }
  for (const [name, original] of records) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')), original,
    'retired observation must leave original history untouched');
  assert.equal(result.status, 404);
});

test('Security account forms reach the canonical metadata and password-confirmed username handlers', async () => {
  const { createUser, getUser, getUserByUsername } = await import('../users.js');
  const account = createUser('security-registry-fixture', 'fixture-password', 'standard');
  const context = { userId: account.id, username: account.username, role: account.role };
  const send = (endpoint: string, method: string, body: unknown) => withUserContext(context, () => {
    const url = new URL(endpoint, 'http://localhost');
    return astroHandler({ url, request: new Request(url, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      cookies: {}, params: {}, locals: { authResolved: true, userContext: context } });
  });
  const metadata = { displayName: 'Fixture Name', email: 'fixture@example.invalid' };
  assert.equal((await send('/api/auth/update-profile', 'POST', metadata)).status, 404);
  const changed = await send('/api/auth/update-profile', 'PUT', metadata);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).user.metadata.displayName, metadata.displayName);
  const cleared = await send('/api/auth/update-profile', 'PUT', { displayName: '', email: '' });
  assert.equal(cleared.status, 200);
  assert.equal(getUser(account.id)?.metadata?.email, '');
  assert.equal((await send('/api/auth/change-username', 'POST', { newUsername: 'security-renamed-fixture' })).status, 400);
  assert.equal((await send('/api/auth/change-username', 'POST', { newUsername: 'security-renamed-fixture', password: 'incorrect' })).status, 401);
  const renamed = await send('/api/auth/change-username', 'POST', { newUsername: 'security-renamed-fixture', password: 'fixture-password' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).username, 'security-renamed-fixture');
  assert.equal(getUserByUsername('security-renamed-fixture')?.id, account.id);
});

test('retired Function Memory API preserves stored records and canonical history paths', async () => {
  const paths = getProfilePaths(user.username);
  const originals = new Map<string, string>();
  for (const level of ['drafts', 'verified']) {
    const file = path.join(paths.functions, level, 'legacy-function.json');
    const original = JSON.stringify({ id: 'legacy-function', title: 'Historical function', metadata: { trustLevel: level === 'drafts' ? 'draft' : 'verified' } });
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original);
    originals.set(file, original);
  }
  assert.equal((await request('/api/functions')).status, 404);
  assert.equal((await request('/api/functions?sortBy=qualityScore&sortOrder=desc')).status, 404);
  for (const [file, original] of originals) assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(listRoutes().some(route => route.pattern === '/api/functions'), false);
});

test('retired node-pipeline preference routes preserve stored values without selecting execution behavior', async () => {
  const paths = getProfilePaths(user.username);
  const file = path.join(paths.etc, 'runtime.json');
  const original = JSON.stringify({ headless: false, cognitive: { useNodePipeline: false, changedBy: 'owner' } });
  fs.mkdirSync(paths.etc, { recursive: true });
  fs.writeFileSync(file, original);
  const rootRuntime = path.join(root, 'etc', 'runtime.json');
  const rootOriginal = JSON.stringify({ headless: false, cognitive: { useNodePipeline: true, changedAt: 'preserved', changedBy: 'owner' } });
  fs.mkdirSync(path.dirname(rootRuntime), { recursive: true });
  fs.writeFileSync(rootRuntime, rootOriginal);
  for (const method of ['GET', 'POST'] as const) {
    assert.equal((await request('/api/node-pipeline', method, method === 'POST' ? { enabled: true } : undefined)).status, 404);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readFileSync(rootRuntime, 'utf8'), rootOriginal);
  }
  assert.equal(listRoutes().some(route => route.pattern === '/api/node-pipeline'), false);
});

test('retired voice training routes and RVC installation preserve existing voice artifacts', async () => {
  const paths = getProfilePaths(user.username);
  const recording = path.join(paths.root, 'out', 'voice-training', 'recordings', 'saved.wav');
  const model = path.join(paths.root, 'out', 'voices', 'rvc-models', 'saved.pth');
  for (const file of [recording, model]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'preserved voice artifact');
  }
  for (const endpoint of ['/api/rvc-training', '/api/voice-training', '/api/voice-profile/upload']) {
    assert.equal(listRoutes().some(route => route.pattern === endpoint), false);
    assert.equal((await request(endpoint)).status, 404);
    assert.equal((await request(endpoint, 'POST', {})).status, 404);
  }
  for (const action of ['install-stream', 'uninstall']) {
    assert.equal((await request(`/api/addons/${action}`, 'POST', { addonId: 'rvc' })).status, 400);
  }
  const catalog = fs.readFileSync(new URL('../../../../etc/addons.json', import.meta.url), 'utf8');
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc', 'addons.json'), catalog);
  const addons = await (await request('/api/addons')).json();
  assert.deepEqual(Object.keys(addons.addons), ['kokoro']);
  for (const file of [recording, model]) assert.equal(fs.readFileSync(file, 'utf8'), 'preserved voice artifact');
});
