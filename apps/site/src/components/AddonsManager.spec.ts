import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readServerEvents } from '../lib/client/sse.js';

// Run the real component handlers with the shared SSE reader. Only HTTP and
// browser lifecycle/confirmation are fixtures; no installer or runtime is run.
const component = readFileSync(new URL('./AddonsManager.svelte', import.meta.url), 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
const source = ts.createSourceFile('addons.ts', script, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(statement =>
  !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement)
  && !ts.isTypeAliasDeclaration(statement) && !ts.isLabeledStatement(statement))
  .map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(respond: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { path: string; init?: RequestInit }[] = [];
  let mount!: () => void;
  let destroy!: () => void;
  let confirmed = true;
  const state = vm.createContext({
    readServerEvents, AbortController, Date,
    confirm: () => confirmed,
    onMount: (callback: typeof mount) => { mount = callback; },
    onDestroy: (callback: typeof destroy) => { destroy = callback; },
    apiFetch: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (path === '/api/addons') return json({ addons: {
        example: { name: 'Example', installed: false }, kokoro: { name: 'Kokoro', installed: false },
      }, categories: {} });
      return respond(path, init);
    },
  });
  vm.runInContext(code, state);
  return { state, requests, read: (name: string) => vm.runInContext(name, state),
    mount: () => mount(), destroy: () => destroy(), decline: () => { confirmed = false; } };
}

function stream(text: string, leaveOpen = false) {
  let cancelled = 0;
  const bytes = new TextEncoder().encode(text);
  const response = new Response(new ReadableStream({ start(controller) {
    // Every byte is separate, including multibyte UTF-8 and CRLF delimiters.
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    if (!leaveOpen) controller.close();
  }, cancel() { cancelled++; } }));
  return { response, cancelled: () => cancelled };
}

test('installation uses shared SSE framing, finishes at the result and updates only that addon without a refresh', async () => {
  const transport = stream(': heartbeat\r\nevent: log\r\ndata: {"level":"info",\r\ndata: "message":"猫"}\r\n\r\n'
    + frame('complete', { success: true, message: 'Installed' }), true);
  const f = fixture(() => transport.response);
  await f.state.loadAddons();
  await f.state.installAddon('example');
  assert.equal(f.read('addons.example.installed'), true);
  assert.equal(f.read('addons.kokoro.installed'), false);
  assert.equal(f.read('operations.example.controller'), null);
  assert.equal(f.read('operations.example.logs[0].message'), '猫');
  assert.equal(f.read('operations.example.logs[1].message'), 'Installed');
  assert.equal(f.read('currentInstallAddon'), 'example');
  assert.equal(f.read('error'), null);
  assert.equal(transport.cancelled(), 1, 'a terminal result releases the reader even before EOF');
  assert.equal(transport.response.body!.locked, false);
  assert.equal(f.requests.filter(request => request.path === '/api/addons').length, 1);
  assert.equal(f.requests[1].init?.method, 'POST');
  assert.equal(JSON.parse(String(f.requests[1].init?.body)).addonId, 'example');
  f.state.closeInstallModal();
  assert.equal(f.read('currentInstallAddon'), null);
  assert.equal(f.read('operations.example'), undefined, 'delivered temporary logs are released on close');
});

test('premature EOF, backend failure, malformed events and HTTP errors all release busy state without claiming installation', async () => {
  const cases = [
    { response: stream(frame('start', { message: 'Started' })).response, error: /without a completion result/ },
    { response: stream(frame('complete', { success: false, error: 'Package download failed' })).response, error: /Package download failed/ },
    { response: stream(frame('error', { message: 'Installer could not start' })).response, error: /Installer could not start/ },
    { response: stream('event: log\ndata: invalid-json\n\n', true).response, error: /SyntaxError/ },
    { response: json({ error: 'Owner access required' }, 403), error: /Owner access required/ },
  ];
  for (const { response, error } of cases) {
    const f = fixture(() => response);
    await f.state.loadAddons();
    await f.state.installAddon('example');
    assert.equal(f.read('addons.example.installed'), false);
    assert.equal(f.read('operations.example.controller'), null);
    assert.match(f.read('error'), error);
    assert.equal(f.read('operations.example.logs.at(-1).level'), 'error');
    assert.equal(f.read('currentInstallAddon'), 'example', 'the error and progress remain available in the dialog');
    if (response.ok) assert.equal(response.body!.locked, false);
    else assert.equal(response.bodyUsed, true, 'HTTP error details are consumed');
  }
});

test('parallel addon installations keep separate logs; hiding a dialog does not cancel its request', async () => {
  const channels = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const f = fixture((_path, init) => {
    const id = JSON.parse(String(init?.body)).addonId;
    return new Response(new ReadableStream({ start(controller) { channels.set(id, controller); } }));
  });
  await f.state.loadAddons();
  const first = f.state.installAddon('example');
  const second = f.state.installAddon('kokoro');
  await turn();
  const emit = (id: string, event: string, data: unknown) => channels.get(id)!.enqueue(new TextEncoder().encode(frame(event, data)));
  emit('example', 'log', { level: 'info', message: 'Example progress' });
  emit('kokoro', 'log', { level: 'info', message: 'Kokoro progress' });
  await turn();
  assert.equal(f.read('operations.example.logs[0].message'), 'Example progress');
  assert.equal(f.read('operations.kokoro.logs[0].message'), 'Kokoro progress');
  assert.equal(f.read('currentInstallAddon'), 'kokoro');
  f.state.closeInstallModal();
  assert.equal(f.requests[1].init!.signal!.aborted, false);
  assert.equal(f.requests[2].init!.signal!.aborted, false);
  emit('example', 'complete', { success: true, message: 'Example installed' });
  emit('kokoro', 'complete', { success: true, message: 'Kokoro installed' });
  await Promise.all([first, second]);
  assert.equal(f.read('addons.example.installed'), true);
  assert.equal(f.read('addons.kokoro.installed'), true);
  assert.equal(f.read('Object.keys(operations).length'), 0, 'hidden completed operations release temporary logs');
});

test('in-app navigation preserves installation until its terminal result and releases temporary state', async () => {
  let cancelled = 0;
  let channel!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({
    start(controller) { channel = controller; }, cancel() { cancelled++; },
  }));
  const f = fixture(() => response);
  f.mount(); await turn();
  const pending = f.state.installAddon('example');
  await turn();
  f.destroy();
  assert.equal(f.requests[0].init!.signal!.aborted, true, 'the catalog read belongs to the view');
  assert.equal(f.requests[1].init!.signal!.aborted, false, 'navigation must not stop installed work');
  assert.equal(cancelled, 0);
  channel.enqueue(new TextEncoder().encode(frame('complete', { success: true, message: 'Installed after navigation' })));
  await pending;
  assert.equal(f.read('addons.example.installed'), true);
  assert.equal(f.read('Object.keys(operations).length'), 0);
  assert.equal(response.body!.locked, false);
  assert.equal(f.read('error'), null);
  const remounted = fixture(() => { throw Error('Unexpected action'); });
  remounted.state.apiFetch = async () => json({ addons: { example: { name: 'Example', installed: true } }, categories: {} });
  remounted.mount(); await turn();
  assert.equal(remounted.read('addons.example.installed'), true);
  remounted.destroy();
});

test('selecting a second installation releases the completed first modal logs', async () => {
  const f = fixture(() => stream(frame('complete', { success: true, message: 'Installed' })).response);
  await f.state.loadAddons();
  await f.state.installAddon('example');
  assert.equal(f.read('operations.example.logs.length'), 1);
  await f.state.installAddon('kokoro');
  assert.equal(f.read('operations.example'), undefined);
  assert.equal(f.read('operations.kokoro.logs.length'), 1);
  f.state.closeInstallModal();
  assert.equal(f.read('Object.keys(operations).length'), 0);
});

test('repeated install/uninstall uses backend results; failed uninstall preserves installed state and declined actions do nothing', async () => {
  let uninstallFails = false;
  const f = fixture(path => path.endsWith('/uninstall')
    ? json(uninstallFails ? { error: 'Runtime could not stop' } : { success: true }, uninstallFails ? 500 : 200)
    : stream(frame('complete', { success: true, message: 'Installed' })).response);
  await f.state.loadAddons();
  for (let cycle = 0; cycle < 2; cycle++) {
    await f.state.installAddon('example');
    assert.equal(f.read('addons.example.installed'), true);
    f.state.closeInstallModal();
    uninstallFails = true;
    await f.state.uninstallAddon('example');
    assert.equal(f.read('addons.example.installed'), true);
    assert.match(f.read('error'), /Runtime could not stop/);
    uninstallFails = false;
    await f.state.uninstallAddon('example');
    assert.equal(f.read('addons.example.installed'), false);
    assert.equal(f.read('Object.keys(operations).length'), 0);
  }
  assert.equal(f.requests.filter(request => request.path === '/api/addons').length, 1);
  const before = f.requests.length;
  f.decline();
  await f.state.installAddon('example');
  await f.state.uninstallAddon('example');
  assert.equal(f.requests.length, before);
});

test('catalog failures retain the backend error and navigation cancels a pending catalog read', async () => {
  const failed = fixture(() => { throw Error('Unexpected action'); });
  failed.state.apiFetch = async () => json({ error: 'Catalog is unavailable' }, 500);
  await failed.state.loadAddons();
  assert.equal(failed.read('loading'), false);
  assert.match(failed.read('error'), /Catalog is unavailable/);

  const pending = fixture(() => { throw Error('Unexpected action'); });
  let signal!: AbortSignal;
  pending.state.apiFetch = async (_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const read = pending.state.loadAddons();
  pending.destroy();
  await read;
  assert.equal(signal.aborted, true);
  assert.equal(pending.read('error'), null);
  assert.equal(pending.read('loading'), false);
});
