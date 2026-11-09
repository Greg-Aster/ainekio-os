import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real owner functions with isolated IO; no coordinator, models or robot starts.
function load(file: string, names: string[], globals: Record<string, unknown>) {
  const ast = ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.includes(node.name!.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))));
  const code = statements.map(node => node.getText(ast).replace(/^export /, '')).join('\n');
  const controller = new EventEmitter();
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    getModeController: () => controller,
    getQueueManager: () => ({ addEventListener() {}, removeEventListener() {} }),
    watch: () => Object.assign(new EventEmitter(), { close() {} }),
    dirname: path.dirname, basename: path.basename,
    ROBOT_OPERATOR_RUNTIME_FILE: '/fixture/run/operator.json', ACTIVE_OPERATOR_CONFIG_FILE: '/fixture/etc/operator.json',
    readActiveOperatorStatus: async () => ({ mode: 'reactive' }),
    eventBus: { subscribe: () => () => {} },
    ...globals });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    + `\nglobalThis.exports = { ${names.join(',')} };`, context);
  return context.exports;
}
const user = { isAuthenticated: true, role: 'owner', username: 'stream-fixture' };
const streamResponse = (stream: AsyncIterable<string>) => ({ status: 200, stream, headers: {} });
const parse = (value: string) => JSON.parse(value.slice(value.indexOf('data: ') + 6).trim());

test('Queue observation leaves producers free and builds one snapshot per delivered event batch', async () => {
  const system = Object.assign(new EventEmitter(), { triggers: new EventEmitter() });
  let reads = 0;
  let revision = 0;
  let fail = false;
  const owner = load('./unified-queue.ts', ['handleQueueStream', 'sse'], {
    getQueueSystem: () => system,
    queueSnapshot: () => {
      reads++;
      if (fail) throw new Error('Snapshot unavailable');
      return { revision };
    },
  });
  const abort = new AbortController();
  const response = await owner.handleQueueStream({ user, signal: abort.signal });
  const iterator = response.stream[Symbol.asyncIterator]();
  assert.equal(parse((await iterator.next()).value).snapshot.revision, 0);
  for (revision = 1; revision <= 40; revision++) {
    system.emit('queue', { type: 'task_completed', taskId: `task-${revision}` });
  }
  assert.equal(reads, 1, 'command producers must not read or serialize UI snapshots');
  for (let i = 1; i <= 40; i++) {
    const update = parse((await iterator.next()).value);
    assert.equal(update.event.taskId, `task-${i}`, 'all event identities and ordering survive batching');
    assert.equal(update.snapshot?.revision, i === 40 ? revision : undefined);
  }
  assert.equal(reads, 2, 'a delayed reader needs one current projection, not forty obsolete snapshots');
  fail = true;
  system.emit('queue', { type: 'task_started', taskId: 'next' });
  assert.equal(reads, 2);
  assert.equal(parse((await iterator.next()).value).error, 'Snapshot unavailable');
  assert.equal((await iterator.next()).done, true);
  assert.equal(system.listenerCount('queue'), 0);
  assert.equal(system.triggers.listenerCount('stateChange'), 0);
});

test('the coordinator stream delivers trigger-only changes for owners without doing snapshot work in producers', async () => {
  for (const role of ['owner', 'guest']) {
    const system = Object.assign(new EventEmitter(), { triggers: new EventEmitter() });
    let revision = 0;
    let reads = 0;
    const owner = load('./unified-queue.ts', ['handleQueueStream', 'sse'], {
      getQueueSystem: () => system,
      queueSnapshot: () => { reads++; return { revision }; },
    });
    const abort = new AbortController();
    const response = await owner.handleQueueStream({ user: { ...user, role }, signal: abort.signal });
    const iterator = response.stream[Symbol.asyncIterator]();
    await iterator.next();
    assert.equal(system.triggers.listenerCount('stateChange'), role === 'owner' ? 1 : 0);
    const next = iterator.next();
    revision++;
    system.triggers.emit('stateChange', { reason: 'modeChanged' });
    assert.equal(reads, 1);
    if (role === 'owner') {
      const packet = parse((await next).value);
      assert.equal(packet.type, 'trigger-state');
      assert.equal(packet.snapshot.revision, 1);
      abort.abort();
      assert.equal((await iterator.next()).done, true);
    } else {
      abort.abort();
      assert.equal((await next).done, true, 'guest stream must not wake for owner trigger state');
    }
    assert.equal(system.listenerCount('queue'), 0);
    assert.equal(system.triggers.listenerCount('stateChange'), 0);
  }
});

for (const taskStream of [false, true]) {
  test(`${taskStream ? 'task' : 'Queue'} stream releases wait listeners on updates, heartbeat and disconnect`, async () => {
    const system = Object.assign(new EventEmitter(), { triggers: new EventEmitter() });
    const timers = new Map<number, () => void>();
    let id = 0;
    const task = { id: 'fixture-task', state: 'leased', username: user.username };
    const manager = { getTask: () => task, getAllTasks: () => [task], getOutput: () => [],
      addEventListener: (fn: (...args: any[]) => void) => system.on('queue', fn),
      removeEventListener: (fn: (...args: any[]) => void) => system.off('queue', fn) };
    const owner = load('./unified-queue.ts', ['handleQueueStream', 'handleQueueTaskStream', 'terminalStreamEvent', 'sse', 'taskStatus', 'canReadTask'], {
      getQueueSystem: () => system, getQueueManager: () => manager, queueSnapshot: () => ({ tasks: [task] }),
      setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; },
      clearTimeout: (timer: number) => timers.delete(timer),
    });
    const abort = new AbortController();
    const response = await owner[taskStream ? 'handleQueueTaskStream' : 'handleQueueStream']({ user, signal: abort.signal, params: { id: task.id } });
    const iterator = response.stream[Symbol.asyncIterator]();
    await iterator.next();
    for (let i = 0; i < 40; i++) {
      const waiting = iterator.next();
      assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
      system.emit('queue', { type: 'task_output', taskId: task.id, details: { chunk: `data: ${i}\n\n` } });
      assert.equal((await waiting).done, false);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
      assert.equal(timers.size, 0);
    }
    const heartbeat = iterator.next();
    [...timers.values()][0]();
    const beat = (await heartbeat).value;
    assert.equal(beat, ': heartbeat\n\n', 'idle keepalives must not reread or transmit status snapshots');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    const waiting = iterator.next();
    abort.abort();
    assert.equal((await waiting).done, true);
    assert.equal(system.listenerCount('queue'), 0);
    assert.equal(system.triggers.listenerCount('stateChange'), 0);
    assert.equal(timers.size, 0);
    assert.equal(task.state, 'leased', 'closing observation cannot cancel admitted work');
  });
}

function fileIO() {
  const watchers: (EventEmitter & { close(): void; closed: boolean; notify(): void })[] = [];
  return { watchers, fs: {
    existsSync: () => true, mkdirSync() {}, writeFileSync() {},
    watch(_target: string, options: unknown, listener?: () => void) {
      const callback = listener ?? options as () => void;
      const watcher = Object.assign(new EventEmitter(), { closed: false,
        close() { this.closed = true; }, notify: callback });
      watchers.push(watcher); return watcher;
    },
  } };
}

test('one buffer stream preserves mode, timestamp and speaker, exposes read errors, and closes every watcher', async () => {
  const io = fileIO();
  let failInner = true;
  const owner = load('./buffer-stream.ts', ['handleBufferStream', 'streamBufferUpdates', 'isBufferMode', 'sse'], {
    fs: io.fs, path, streamResponse,
    eventBus: { subscribe: () => () => {} },
    getBufferNotificationPath: (_user: string, mode: string) => `/fixture/${mode}`,
    loadBufferForUser: (_user: string, mode: string) => {
      if (mode === 'inner' && failInner) throw new Error('Fixture read failure');
      return { messages: [{ role: 'assistant', content: mode, timestamp: 123, meta: { source: mode } }], lastUpdated: 456 };
    },
  });
  const abort = new AbortController();
  const response = await owner.handleBufferStream({ user, signal: abort.signal, query: { mode: 'conversation,inner,system,robot' } });
  const iterator = response.stream[Symbol.asyncIterator]();
  const initial = [];
  for (let i = 0; i < 8; i++) initial.push(parse((await iterator.next()).value));
  assert.deepEqual(initial.filter(item => item.type === 'update').map(item => item.mode), ['conversation', 'system', 'robot']);
  assert.equal(initial.find(item => item.type === 'error').mode, 'inner');
  assert.equal(initial.find(item => item.type === 'update').messages[0].timestamp, 123);
  assert.equal(initial.find(item => item.type === 'update').messages[0].role, 'assistant');
  failInner = false;
  const recovered = iterator.next();
  io.watchers[1].notify();
  assert.equal(parse((await recovered).value).messages[0].content, 'inner');
  const waiting = iterator.next();
  abort.abort();
  assert.equal((await waiting).done, true);
  assert.ok(io.watchers.every(watcher => watcher.closed));
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('monitor read and watcher failures are delivered, and disconnect releases subscriptions', async () => {
  const io = fileIO();
  let released = 0;
  const owner = load('./monitor-stream.ts', ['handleMonitorStream', 'streamMonitorUpdates', 'sse'], {
    fs: { ...io.fs, watch: (target: string, options: unknown, listener?: () => void) => {
      assert.notEqual(target, '/fixture/logs/audit', 'monitor must not subscribe to audit writes');
      return io.fs.watch(target, options, listener);
    } }, path, streamResponse, systemPaths: { logs: '/fixture/logs', run: '/fixture/run', etc: '/fixture/etc', agents: '/fixture/brain/agents', brain: '/fixture/brain' },
    getAgentMonitorSnapshot: () => { throw new Error('Fixture snapshot failed'); },
    subscribeEnvironmentBridgeState: () => () => { released++; },
    subscribeEnvironmentBridgeDiagnostics: () => () => { released++; },
  });
  const abort = new AbortController();
  const response = await owner.handleMonitorStream({ signal: abort.signal });
  const iterator = response.stream[Symbol.asyncIterator]();
  await iterator.next();
  assert.equal(parse((await iterator.next()).value).error, 'Fixture snapshot failed');
  const failedWatch = iterator.next();
  io.watchers[0].emit('error', new Error('Fixture watch failed'));
  assert.equal(parse((await failedWatch).value).error, 'Fixture watch failed');
  const waiting = iterator.next(); abort.abort(); await waiting;
  assert.equal(released, 2);
  assert.ok(io.watchers.every(watcher => watcher.closed));
});

test('monitor delivers real catalog changes across repeated atomic config replacement and source changes', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-catalog-stream-'));
  const brain = path.join(root, 'brain');
  const agents = path.join(brain, 'agents');
  const services = path.join(brain, 'services');
  const etc = path.join(root, 'etc');
  for (const dir of [agents, services, etc, path.join(root, 'logs/agents'), path.join(root, 'run/locks')]) fs.mkdirSync(dir, { recursive: true });
  const config = { revision: 0, agents: { organizer: { enabled: true, type: 'manual', agentPath: 'organizer/cli.ts' } } };
  fs.writeFileSync(path.join(etc, 'agents.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(etc, 'services.json'), JSON.stringify({ services: {} }));
  fs.mkdirSync(path.join(agents, 'organizer'));
  fs.writeFileSync(path.join(agents, 'organizer/cli.ts'), 'export {};');
  const { AgentCatalogService } = await import('../../agent-catalog.js');
  const { TriggerConfigService } = await import('../../queue/trigger-config-service.js');
  const { eventBus } = await import('../../infrastructure/event-bus/client.js');
  eventBus.disconnect();
  const catalog = new AgentCatalogService({ agentsDir: agents, brainDir: brain, servicesConfigPath: path.join(etc, 'services.json'),
    triggerConfigService: new TriggerConfigService(path.join(etc, 'agents.json')) });
  const watchers: fs.FSWatcher[] = [];
  const closedWatchers = new Set<fs.FSWatcher>();
  const owner = load('./monitor-stream.ts', ['handleMonitorStream', 'streamMonitorUpdates', 'sse'], {
    fs: { ...fs, watch: (...args: any[]) => {
      const watcher = (fs.watch as any)(...args) as fs.FSWatcher;
      watcher.once('close', () => closedWatchers.add(watcher));
      watchers.push(watcher); return watcher;
    } },
    path, streamResponse, systemPaths: { root, agents, brain, etc, logs: path.join(root, 'logs'), run: path.join(root, 'run') },
    getAgentMonitorSnapshot: () => ({ catalog: catalog.getSnapshot(), runningAgents: [] }),
    subscribeEnvironmentBridgeState: () => () => {}, subscribeEnvironmentBridgeDiagnostics: () => () => {},
  });
  const abort = new AbortController();
  const response = await owner.handleMonitorStream({ user, signal: abort.signal });
  const iterator = response.stream[Symbol.asyncIterator]();
  const next = async () => parse((await iterator.next()).value);
  const replace = (file: string, value: object) => {
    fs.writeFileSync(`${file}.next`, JSON.stringify(value));
    fs.renameSync(`${file}.next`, file);
  };
  try {
    await next();
    assert.equal((await next()).catalog.agents.find((agent: any) => agent.id === 'organizer').enabled, true);
    for (const enabled of [false, true]) {
      config.agents.organizer.enabled = enabled;
      config.revision++;
      replace(path.join(etc, 'agents.json'), config);
      const update = await next();
      assert.equal(update.catalog.revision, config.revision);
      assert.equal(update.catalog.agents.find((agent: any) => agent.id === 'organizer').enabled, enabled);
    }
    replace(path.join(etc, 'services.json'), { services: { 'maintenance-service': { enabled: true, agentPath: 'services/maintenance-service.ts' } } });
    assert.equal((await next()).catalog.agents.find((agent: any) => agent.id === 'maintenance-service').sourceReady, false);
    fs.writeFileSync(path.join(services, 'maintenance-service.ts'), 'export {};');
    assert.equal((await next()).catalog.agents.find((agent: any) => agent.id === 'maintenance-service').sourceReady, true);
    fs.mkdirSync(path.join(agents, 'catalog-fixture'));
    fs.writeFileSync(path.join(agents, 'catalog-fixture/cli.ts'), 'export {};');
    assert.equal((await next()).catalog.agents.find((agent: any) => agent.id === 'catalog-fixture').sourceReady, true);
    fs.rmSync(path.join(agents, 'catalog-fixture'), { recursive: true });
    assert.equal((await next()).catalog.agents.some((agent: any) => agent.id === 'catalog-fixture'), false);
  } finally {
    abort.abort();
    while (!(await iterator.next()).done) { /* drain pending committed snapshots */ }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(watchers.length, 5);
    assert.equal(closedWatchers.size, watchers.length);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('editor disconnect ends observation while the admitted graph continues without writing to the closed response', async () => {
  let complete!: (value: unknown) => void;
  let completed = false;
  const owner = load('./execute-graph-stream.ts', ['handleExecuteGraphStream', 'executeGraphWithEvents', 'formatSSE'], {
    streamResponse, namedSse: (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    runGraph: async ({ eventHandler }: any) => {
      eventHandler({ type: 'node_start', nodeId: 'fixture', timestamp: 'fixture' });
      const value = await new Promise(resolve => { complete = resolve; });
      completed = true; return value;
    }, extractGraphOutput: () => ({ response: 'done' }), collectNodeOutputs: () => ({}), listSkippedNodes: () => [],
  });
  const abort = new AbortController();
  const response = await owner.handleExecuteGraphStream({ user, signal: abort.signal,
    body: { graph: { nodes: [], edges: [] }, sessionId: 'fixture' } });
  const iterator = response.stream[Symbol.asyncIterator]();
  assert.match((await iterator.next()).value, /node_start/);
  const waiting = iterator.next(); abort.abort();
  assert.equal((await waiting).done, true);
  assert.equal(completed, false);
  complete({ status: 'completed', nodes: new Map() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, true);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

for (const [name, initialFrames] of [['generatePlanStream', 5], ['runDesireStream', 4], ['outcomeReviewStream', 4]] as const) {
  test(`${name}: disconnect releases observation without cancelling its Coordinator task`, async () => {
    const events = new EventEmitter();
    let cancels = 0;
    const task = { id: 'fixture-task', state: 'leased' };
    const desire = { id: 'fixture-desire', title: 'Fixture', status: 'approved', plan: { steps: [], operatorGoal: 'Fixture' } };
    const manager = { getTask: () => task, getOutput: () => [], cancel() { cancels++; },
      addEventListener: (fn: (...args: any[]) => void) => events.on('queue', fn),
      removeEventListener: (fn: (...args: any[]) => void) => events.off('queue', fn) };
    const owner = load('./agency-workflows.ts', [name, 'namedSse', 'dataSse', 'requireOwner'], {
      getQueueManager: () => manager, submitDesireAgent: async () => task, rejectInlineCritique() {},
      loadPlannableDesire: async () => desire, loadExecutableDesire: async () => desire, loadReviewableDesire: async () => desire,
      RUN_STREAM_LOG_PREFIX: 'fixture', PLAN_STREAM_LOG_PREFIX: 'fixture', OUTCOME_STREAM_LOG_PREFIX: 'fixture',
      setTimeout() { throw new Error('Task observation must wake on Coordinator events'); },
    });
    const abort = new AbortController();
    const iterator = owner[name]({ user, signal: abort.signal, params: { id: desire.id } });
    for (let i = 0; i < initialFrames; i++) assert.equal((await iterator.next()).done, false);
    const waiting = iterator.next();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.listenerCount('queue'), 1);
    abort.abort();
    assert.equal((await waiting).done, true);
    assert.equal(cancels, 0);
    assert.equal(events.listenerCount('queue'), 0);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  });
}


test('task reconnect delivers output arriving during replay before exactly one terminal event', async () => {
  for (const state of ['completed', 'failed', 'cancelled', 'expired']) {
    const events = new EventEmitter();
    const task = { id: 'replay-task', state: 'leased', username: user.username,
      error: { message: 'Original failure' }, cancellationReason: 'Original cancellation' };
    const manager = { getTask: () => task, getAllTasks: () => [task],
      getOutput: () => ['original prefix', 'original continuation'],
      addEventListener: (fn: (...args: any[]) => void) => events.on('queue', fn),
      removeEventListener: (fn: (...args: any[]) => void) => events.off('queue', fn) };
    const owner = load('./unified-queue.ts', ['handleQueueTaskStream', 'terminalStreamEvent', 'sse', 'taskStatus', 'canReadTask'], {
      getQueueManager: () => manager,
      setTimeout() { throw new Error('Already pending output must not wait'); },
    });
    const response = await owner.handleQueueTaskStream({ user, params: { id: task.id } });
    const iterator = response.stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, 'original prefix');
    events.emit('queue', { type: 'task_output', taskId: task.id, details: { chunk: 'last live output' } });
    task.state = state;
    events.emit('queue', { type: `task_${state}`, taskId: task.id });
    assert.equal((await iterator.next()).value, 'original continuation');
    assert.equal((await iterator.next()).value, 'last live output');
    const terminal = parse((await iterator.next()).value);
    assert.equal(terminal.type, state === 'completed' ? 'queued_task_completed' : 'error');
    assert.equal((await iterator.next()).done, true);
    assert.equal(events.listenerCount('queue'), 0);
  }
});

test('continuous robot telemetry cannot starve readiness updates in the monitor stream', async () => {
  const io = fileIO();
  const events = new EventEmitter();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, id = 0, revision = 0, reads = 0;
  const subscribe = (callback: () => void) => { events.on('update', callback); return () => events.off('update', callback); };
  const owner = load('./monitor-stream.ts', ['handleMonitorStream', 'streamMonitorUpdates', 'sse'], {
    fs: io.fs, path, streamResponse, systemPaths: { logs: '/fixture/logs', run: '/fixture/run', etc: '/fixture/etc', agents: '/fixture/brain/agents', brain: '/fixture/brain' },
    getAgentMonitorSnapshot: () => { reads++; return { revision }; },
    subscribeEnvironmentBridgeState: subscribe, subscribeEnvironmentBridgeDiagnostics: subscribe,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, {at: now + delay, callback}); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
  });
  const abort = new AbortController();
  const response = await owner.handleMonitorStream({ signal: abort.signal });
  const iterator = response.stream[Symbol.asyncIterator]();
  await iterator.next(); await iterator.next();
  try {
    // Advance virtual time while telemetry keeps arriving faster than UI sampling.
    for (now = 0; now < 1000; now += 10) {
      revision++; events.emit('update');
      for (const [timer, value] of timers) if (value.at <= now) { timers.delete(timer); value.callback(); }
    }
    assert.ok(reads > 1, 'A moving robot must publish changed readiness without waiting for telemetry to become idle');
    assert.ok(parse((await iterator.next()).value).revision > 0);
  } finally {
    abort.abort();
    while (!(await iterator.next()).done) { /* drain already delivered snapshots */ }
  }
  assert.equal(timers.size, 0);
  assert.equal(events.listenerCount('update'), 0);
});

test('operator changes share the coordinator stream, observe atomic file replacement and release subscriptions', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-stream-'));
  const runtime = path.join(root, 'run', 'operator.json');
  const config = path.join(root, 'etc', 'operator.json');
  for (const file of [runtime, config]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); }
  const controller = new EventEmitter();
  const system = Object.assign(new EventEmitter(), { triggers: new EventEmitter() });
  let reads = 0;
  let watcherCount = 0;
  let failed = false;
  const owner = load('./unified-queue.ts', ['handleQueueStream', 'sse'], {
    getQueueSystem: () => system, getModeController: () => controller,
    ROBOT_OPERATOR_RUNTIME_FILE: runtime, ACTIVE_OPERATOR_CONFIG_FILE: config,
    watch: (...args: Parameters<typeof fs.watch>) => {
      const watcher = fs.watch(...args);
      watcherCount++;
      watcher.once('close', () => watcherCount--);
      return watcher;
    },
    queueSnapshot: () => ({ tasks: [] }),
    readActiveOperatorStatus: async () => {
      reads++;
      if (failed) throw new Error('Operator history unavailable');
      return { runtime: JSON.parse(fs.readFileSync(runtime, 'utf8')), configuration: JSON.parse(fs.readFileSync(config, 'utf8')) };
    },
  });
  try {
    for (let round = 0; round < 2; round++) {
      const abort = new AbortController();
      const response = await owner.handleQueueStream({ user, signal: abort.signal });
      const iterator = response.stream[Symbol.asyncIterator]();
      assert.ok(parse((await iterator.next()).value).snapshot.activeOperator);
      assert.equal(controller.listenerCount('modeChanged'), 1);
      assert.equal(watcherCount, 2);
      const mode = iterator.next();
      const before = reads;
      controller.emit('modeChanged', 'reactive');
      assert.equal(reads, before, 'the mode producer must not build UI snapshots');
      assert.ok(parse((await mode).value).snapshot.activeOperator);
      for (const file of [runtime, config, runtime]) {
        const update = iterator.next();
        fs.writeFileSync(file + '.tmp', JSON.stringify({ revision: reads }));
        fs.renameSync(file + '.tmp', file);
        const packet = parse((await update).value);
        assert.equal(packet.type, 'operator-state');
        assert.deepEqual(packet.snapshot.activeOperator[file === runtime ? 'runtime' : 'configuration'], JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      failed = true;
      const error = iterator.next();
      controller.emit('modeChanged', 'reactive');
      const packet = parse((await error).value);
      assert.equal(packet.snapshot.activeOperatorError, 'Operator history unavailable');
      assert.deepEqual(packet.snapshot.tasks, [], 'operator read failures must not break queue observation');
      failed = false;
      const recovery = iterator.next();
      controller.emit('modeChanged', 'reactive');
      assert.ok(parse((await recovery).value).snapshot.activeOperator);
      const pending = iterator.next();
      abort.abort();
      assert.equal((await pending).done, true);
      assert.equal(controller.listenerCount('modeChanged'), 0);
      assert.equal(system.listenerCount('queue'), 0);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(watcherCount, 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the shared operator projection preserves owner-only configuration access', async () => {
  const configuration = { autonomyMode: 'semi', semiAssessmentMinutes: 9 };
  const owner = load('./active-operator.ts', ['readActiveOperatorStatus', 'handleGetActiveOperatorStatus', 'jsonError'], {
    getModeController: () => ({ getStatus: () => ({ mode: 'semi', health: 'healthy' }) }),
    getQueueManager: () => ({ getAllTasks: () => [], getHistory: () => [] }),
    readRobotOperatorRuntimeState: () => null, loadActiveOperatorConfig: () => configuration,
  });
  for (const role of ['owner', 'standard', 'guest']) {
    const response = await owner.handleGetActiveOperatorStatus({ user: { role } });
    assert.equal(response.status, 200);
    assert.equal(response.data.mode, 'semi');
    assert.equal(Object.hasOwn(response.data, 'configuration'), role === 'owner');
    if (role === 'owner') assert.deepEqual(response.data.configuration, configuration);
  }
});

test('Agency observes only its authenticated profile through the existing coordinator connection', async () => {
  for (const role of ['owner', 'guest']) {
    const listeners = new Set<(event: any) => void>();
    const system = Object.assign(new EventEmitter(), { triggers: new EventEmitter() });
    const owner = load('./unified-queue.ts', ['handleQueueStream', 'sse'], {
      getQueueSystem: () => system, queueSnapshot: () => ({ tasks: [] }),
      eventBus: { subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    });
    const abort = new AbortController();
    const response = await owner.handleQueueStream({ user: { ...user, role }, signal: abort.signal });
    const iterator = response.stream[Symbol.asyncIterator]();
    await iterator.next();
    assert.equal(listeners.size, role === 'owner' ? 1 : 0);
    const next = iterator.next();
    for (const listener of listeners) listener({ event: 'agency.changed', data: { username: 'other-profile', revision: 'other' } });
    for (const listener of listeners) listener({ event: 'agency.changed', data: { username: user.username, revision: 'committed', desireId: 'desire' } });
    if (role === 'owner') {
      const packet = parse((await next).value);
      assert.equal(packet.type, 'agency-state');
      assert.equal(packet.snapshot.agencyChange.revision, 'committed');
      assert.equal(packet.snapshot.agencyChange.desireId, 'desire');
      abort.abort(); await iterator.next();
    } else { abort.abort(); assert.equal((await next).done, true); }
    assert.equal(listeners.size, 0);
  }
});

test('Agency emits a profile change only after persistence and preserves history on deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-change-'));
  const changes: any[] = [];
  let fail = false;
  const owner = load('../../agency/storage.ts', ['notifyAgencyChange', 'saveDesire', 'deleteDesire', 'ensureDesireFolder', 'getDesireFolderPath'], {
    fs, path, CATEGORY: 'config', SUBCATEGORY: 'desires', FOLDER_BASE: 'folders',
    getUserContext: () => ({ username: 'context-profile' }), randomUUID: () => `revision-${changes.length}`,
    statusToStage: () => 'strengthening', initializeDesireMetrics: () => ({}),
    eventBus: { emit: (_source: string, event: string, data: any) => {
      const manifest = path.join(root, 'folders/desire/manifest.json');
      changes.push({ event, data, exists: fs.existsSync(manifest) });
    } },
    storageClient: {
      write: async ({ relativePath, data }: { relativePath: string; data: string }) => {
        if (fail) return { success: false, error: 'Storage unavailable' };
        const target = path.join(root, relativePath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
        return { success: true };
      },
      delete: async ({ relativePath }: { relativePath: string }) => {
        if (fail) return { success: false, error: 'Delete denied' };
        fs.rmSync(path.join(root, relativePath), { force: true }); return { success: true };
      },
    },
  });
  try {
    const desire = { id: 'desire', title: 'Fixture', status: 'nascent', metrics: {} };
    fail = true;
    await assert.rejects(owner.saveDesire(desire, 'profile-a'), /Storage unavailable/);
    assert.equal(changes.length, 0);
    fail = false;
    await owner.saveDesire(desire, 'profile-a');
    assert.equal(changes[0].exists, true);
    assert.equal(changes[0].data.username, 'profile-a');
    await owner.saveDesire(desire);
    assert.equal(changes[1].data.username, 'context-profile');
    const history = path.join(root, 'folders/desire/executions/attempt-001.json');
    fs.writeFileSync(history, 'retained result');
    fail = true;
    await assert.rejects(owner.deleteDesire(desire, 'profile-a'), /Delete denied/);
    assert.equal(changes.length, 2);
    fail = false;
    await owner.deleteDesire(desire, 'profile-a');
    assert.equal(changes[2].exists, false);
    assert.equal(fs.readFileSync(history, 'utf8'), 'retained result');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('monitor delivers Coordinator lease transitions without rebuilding for token output and releases the listener', async () => {
  const io = fileIO();
  const listeners = new Set<(event: { type: string }) => void>();
  let scheduled: (() => void) | undefined;
  let leased = false;
  let reads = 0;
  const owner = load('./monitor-stream.ts', ['handleMonitorStream', 'streamMonitorUpdates', 'sse'], {
    fs: io.fs, path, streamResponse,
    systemPaths: { logs: '/fixture/logs', run: '/fixture/run', etc: '/fixture/etc', agents: '/fixture/brain/agents', brain: '/fixture/brain' },
    getQueueManager: () => ({ addEventListener: (listener: (event: { type: string }) => void) => listeners.add(listener),
      removeEventListener: (listener: (event: { type: string }) => void) => listeners.delete(listener) }),
    getAgentMonitorSnapshot: () => { reads++; return { runningAgents: leased ? [{ name: 'desire-agent' }] : [] }; },
    subscribeEnvironmentBridgeState: () => () => {}, subscribeEnvironmentBridgeDiagnostics: () => () => {},
    setTimeout: (callback: () => void) => { scheduled = callback; return 1; }, clearTimeout() {},
  });
  const abort = new AbortController();
  const response = await owner.handleMonitorStream({ signal: abort.signal });
  const iterator = response.stream[Symbol.asyncIterator]();
  await iterator.next();
  assert.equal(parse((await iterator.next()).value).runningAgents.length, 0);
  assert.equal(listeners.size, 1);
  for (const [type, active] of [['task_started', true], ['task_completed', false]] as const) {
    const next = iterator.next(); leased = active;
    const before = reads;
    listeners.forEach(listener => listener({ type }));
    assert.equal(reads, before, 'state producers must not perform monitor reads');
    assert.ok(scheduled); const deliver = scheduled; scheduled = undefined; deliver();
    assert.equal(parse((await next).value).runningAgents.length, active ? 1 : 0);
    for (let i = 0; i < 1000; i++) listeners.forEach(listener => listener({ type: 'task_output' }));
    assert.equal(scheduled, undefined, 'output chunks do not change the monitor lifecycle projection');
    assert.equal(reads, before + 1);
  }
  const pending = iterator.next(); abort.abort(); await pending;
  assert.equal(listeners.size, 0);
  assert.ok(io.watchers.every(watcher => watcher.closed));
});
