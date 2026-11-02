import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { compile } from 'svelte/compiler';
import ts from 'typescript';
import { render } from 'svelte/server';
import type { EnvironmentBridgeDiagnosticsSession } from '../lib/client/environment-bridge-diagnostics-types';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./RobotConnectionStatus.svelte', import.meta.url), 'utf8');
const compiled = ts.transpileModule(compile(source, { filename: 'RobotConnectionStatus.svelte', generate: 'server' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function view(panel: Record<string, unknown>, disconnected = false) {
  let cleanup: (() => void) | undefined;
  let closed = false;
  const stream = { close() { closed = true; },
    set onmessage(callback: (event: {data: string}) => void) { callback({ data: JSON.stringify({ type: 'snapshot', agentData: { 'environment-bridge': panel } }) }); },
    set onerror(callback: () => void) { if (disconnected) callback(); },
  };
  const context = vm.createContext({ exports: {}, require: (id: string) => {
    if (id === 'svelte') return { onMount: (callback: () => () => void) => { cleanup = callback(); } };
    if (id === '../lib/client/api-config') return { apiEventSource: (url: string) => { assert.equal(url, '/api/monitor/stream'); return stream; } };
    return require(id);
  } });
  vm.runInContext(compiled, context);
  const html = render(context.exports.default).body;
  cleanup?.();
  assert.equal(closed, true, 'The view releases its existing monitor subscription on unmount');
  return html;
}
const panel = (ready: boolean, extra: Record<string, unknown> = {}) => ({ readiness: ready ? 'ready' : 'not-ready',
  variables: [{ key: 'enabled', value: true }], latestTask: 'Remote host unavailable',
  diagnostics: { connections: [{ endpoint: 'ws://saved-host/environment', sessionId: 'body', robotId: 'robot-a', active: ready, ready, connected: ready,
    ...(!ready ? { error: 'connect ECONNREFUSED' } : {}) }], sessions: [] as Partial<EnvironmentBridgeDiagnosticsSession>[] }, ...extra });

test('normal conversation shows a disconnected robot and its real route failure', () => {
  const html = view(panel(false));
  assert.match(html, /role="alert"/);
  assert.match(html, /Robot voice is disconnected/);
  assert.match(html, /ECONNREFUSED/);
});
test('normal conversation reports failed voice delivery even when transport is ready', () => {
  const data = panel(true);
  data.diagnostics.sessions = [{ sessionId: 'body', lastTranscriptionStatus: 'failed', recentEvents: [
    {timestamp: '2026-11-01T23:00:00Z', kind: 'audio.transcription', status: 'failed', message: 'Whisper returned 503'},
  ] }];
  const html = view(data);
  assert.match(html, /Voice delivery failed/);
  assert.match(html, /Whisper returned 503/);
});
test('lost status stream cannot leave an old connected badge visible', () => {
  const html = view(panel(true), true);
  assert.match(html, /status is unavailable/);
  assert.doesNotMatch(html, /Robot connected/);
});
test('recovered connection renders the current body and route as status', () => {
  const html = view(panel(true));
  assert.match(html, /Robot connected/);
  assert.match(html, /robot-a/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /role="alert"/);
});
