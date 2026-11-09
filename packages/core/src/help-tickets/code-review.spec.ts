import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-code-review-'));
process.env.METAHUMAN_ROOT = root;
globalThis.fetch = async () => { throw new Error('Code review tests prohibit network'); };
const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const router = await import('../model-router.js');
let planningCalls = 0;
let terminalCalls = 0;
let failTerminal = false;
let reply = '';
let terminalPrompt = '';
const modelMock = mock.module('../model-router.js', { namedExports: { ...router,
  callLLM: async (request: any) => { planningCalls++; assert.equal(request.role, 'coder'); assert.equal(request.options.toolAccess, 'read-only'); return { content: 'Investigate the supplied issue and return the required report.' }; },
} });
const terminal = await import('../terminal/client.js');
const terminalMock = mock.module('../terminal/client.js', { namedExports: { ...terminal,
  executeBigBrotherTool: async (request: any) => {
    terminalCalls++;
    terminalPrompt = request.prompt;
    assert.ok(request.codeReview.issueIds.length);
    if (failTerminal) throw new Error('Fixture Codex failure');
    return { success: true, output: reply, metadata: { repairAuthorization: { canRepair: false } } };
  },
} });
const { createUser } = await import('../users.js');
const { getProfilePaths } = await import('../path-builder.js');
const { withUserContext } = await import('../context.js');
const { runGraph } = await import('../graph-runtime.js');
const { loadGraphForMode } = await import('../graph-streaming.js');
const { loadBufferForUser } = await import('../conversation-buffer.js');
const { recordSystemError, getTicket, getPendingTechnicalTickets } = await import('./index.js');
const { systemCodeReviewAuthorization } = await import('./code-review.js');
const { prepareCodeReviewResult } = await import('../nodes/active-operator/help-ticket-review.node.js');
const { SYSTEM_CODE_REVIEW_TERMINAL_PROMPT } = await import('./code-review-prompts.js');
const username = 'review-owner';
createUser(username, 'fixture-password-only', 'owner');
const profile = getProfilePaths(username);
fs.mkdirSync(path.dirname(profile.voiceConfig), { recursive: true });
fs.writeFileSync(profile.voiceConfig, JSON.stringify({ tts: { speechDisabled: true } }));
fs.mkdirSync(path.join(root, 'etc/cognitive-graphs'), { recursive: true });
fs.copyFileSync(new URL('../../../../etc/cognitive-graphs/system-code-review-mode.json', import.meta.url), path.join(root, 'etc/cognitive-graphs/system-code-review-mode.json'));
fs.copyFileSync(new URL('../../../../etc/cognitive-graphs/system-event.json', import.meta.url), path.join(root, 'etc/cognitive-graphs/system-event.json'));
after(() => { terminalMock.restore(); modelMock.restore(); eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });
const issue = (eventId: string) => recordSystemError(username, { source: 'chat', eventId, message: 'Fixture failure', occurredAt: new Date().toISOString() });
const outcome = (id: string) => ({ id, outcome: 'unresolved', diagnosis: 'The source fixture is faulty.', solution: 'Correct its producer.',
  changedFiles: [], validation: ['Read the fixture.'], evidence: ['Original error receipt.'], remainingWork: 'Source repair needs authorization.' });
const context = { username, userId: username, cognitiveMode: 'agent', allowMemoryWrites: true, recordPersonaMemory: true };

test('existing trust policy controls source repair while every level permits diagnosis', () => {
  for (const trustLevel of ['observe', 'suggest', 'supervised_auto', 'bounded_auto', 'adaptive_auto']) {
    fs.mkdirSync(profile.persona, { recursive: true });
    fs.writeFileSync(path.join(profile.persona, 'decision-rules.json'), JSON.stringify({ trustLevel }));
    assert.deepEqual(systemCodeReviewAuthorization(username), {
      trustLevel,
      approval: trustLevel === 'observe' ? 'observe_only' : trustLevel === 'adaptive_auto' ? 'auto_approve' : 'require_approval',
      canRepair: trustLevel === 'adaptive_auto',
      access: trustLevel === 'adaptive_auto' ? 'repair' : 'read-only',
    });
  }
  fs.writeFileSync(path.join(profile.persona, 'decision-rules.json'), JSON.stringify({ trustLevel: 'observe' }));
});

test('code review preserves its existing unreadable and unsupported trust policy behavior', () => {
  const file = path.join(profile.persona, 'decision-rules.json');
  const suggested = { trustLevel: 'suggest', approval: 'require_approval', canRepair: false, access: 'read-only' };
  try {
    fs.rmSync(file);
    assert.deepEqual(systemCodeReviewAuthorization(username), suggested);
    fs.writeFileSync(file, 'malformed rules');
    assert.deepEqual(systemCodeReviewAuthorization(username), suggested);
    for (const trustLevel of [undefined, 'unsupported']) {
      fs.writeFileSync(file, JSON.stringify({ trustLevel }));
      assert.deepEqual(systemCodeReviewAuthorization(username), {
        trustLevel, approval: 'require_approval', canRepair: false, access: 'read-only',
      });
    }
  } finally { fs.writeFileSync(file, JSON.stringify({ trustLevel: 'observe' })); }
});

test('real workflow preserves an unfixed diagnosis in conversation and Persona Memory before recording ticket outcome', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const ticket = issue('first');
    reply = JSON.stringify({ report: 'Diagnosis completed. The repair remains proposed.', issues: [outcome(ticket.id)] });
    const { graph } = await loadGraphForMode('system-code-review', username);
    const state = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id] } } });
    assert.equal(state.status, 'completed', state.error?.message);
    assert.equal(planningCalls, 1);
    assert.equal(terminalCalls, 1);
    const saved = getTicket(username, ticket.id)!;
    assert.equal(saved.status, 'needs_fix');
    assert.ok(saved.lastCodeReview?.memoryEventId);
    assert.ok(fs.existsSync(saved.lastCodeReview!.memoryPath!));
    const buffer = loadBufferForUser(username, 'conversation').messages;
    assert.equal(buffer.length, 1, 'An autonomous review must not fabricate a user message');
    assert.equal(buffer[0].content, JSON.parse(reply).report);
    assert.equal(buffer[0].meta.speaker, 'System Code Review');
    await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id] } }, executionId: state.executionId });
    assert.equal(terminalCalls, 1, 'Resuming delivery must not repeat investigation');
    assert.equal(getTicket(username, ticket.id)!.history.filter(entry => entry.action === 'system_code_review').length, 1);
  });
});

test('provider failure still saves an error report and leaves the issue unresolved', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const ticket = issue('provider-failure');
    failTerminal = true;
    try {
      const { graph } = await loadGraphForMode('system-code-review', username);
      const state = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id] } } });
      assert.equal(state.status, 'completed', state.error?.message);
      assert.equal(state.nodes.get('record')?.outputs?.failed, true);
      assert.match(loadBufferForUser(username, 'conversation').messages.at(-1)!.content, /Fixture Codex failure/);
      assert.equal(getTicket(username, ticket.id)!.status, 'investigating');
      assert.ok(getTicket(username, ticket.id)!.lastCodeReview?.memoryEventId);
    } finally { failTerminal = false; }
  });
});

test('report-only recovery never calls models or Codex, and an empty issue set skips both', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const ticket = issue('planning-failure');
    const before = [planningCalls, terminalCalls];
    const { graph } = await loadGraphForMode('system-code-review', username);
    const state = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id], reportOnly: true,
      reviewExecutionId: 'failed-planning-execution', error: 'Planning provider is unavailable' } } });
    assert.equal(state.status, 'completed', state.error?.message);
    assert.deepEqual([planningCalls, terminalCalls], before);
    assert.equal(getTicket(username, ticket.id)!.lastCodeReview?.executionId, 'failed-planning-execution');
    const empty = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [] } } });
    assert.equal(empty.status, 'completed', empty.error?.message);
    assert.deepEqual([planningCalls, terminalCalls], before);
  });
});

test('resolution needs evidence; read-only changes and malformed reports remain explicit failures', () => {
  const ticket = issue('resolution');
  const review = { issues: [ticket], executionId: 'resolution-review' };
  const fixed = { ...outcome(ticket.id), outcome: 'resolved' };
  assert.equal(prepareCodeReviewResult(review, { result: JSON.stringify({ report: 'Already corrected, verified.', issues: [fixed] }) }).failed, false);
  assert.equal(prepareCodeReviewResult(review, { result: JSON.stringify({ report: 'No evidence', issues: [{ ...fixed, validation: [] }] }) }).failed, true);
  assert.equal(prepareCodeReviewResult(review, { result: 'not json' }).issues[0].outcome, 'unresolved');
  for (const field of ['changedFiles', 'validation', 'evidence']) {
    const malformed = { ...outcome(ticket.id), [field]: 'Read-only investigation.' };
    const prepared = prepareCodeReviewResult(review, { result: JSON.stringify({ report: 'Diagnosis completed.', issues: [malformed] }) });
    assert.equal(prepared.failed, true, `${field} must remain an array of strings`);
  }
  assert.equal(prepareCodeReviewResult(review, { repairAuthorization: { canRepair: false },
    result: JSON.stringify({ report: 'Edited', issues: [{ ...fixed, changedFiles: ['source.ts'] }] }) }).failed, true);
  assert.ok(getPendingTechnicalTickets(username).some(item => item.id === ticket.id));
});

test('a verified resolution is retained in conversation and memory and leaves pending review work', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const ticket = issue('verified-resolution');
    reply = JSON.stringify({ report: 'The existing correction was verified against the original failure.',
      issues: [{ ...outcome(ticket.id), outcome: 'resolved', remainingWork: '' }] });
    const { graph } = await loadGraphForMode('system-code-review', username);
    const state = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id] } } });
    assert.equal(state.status, 'completed', state.error?.message);
    const saved = getTicket(username, ticket.id)!;
    assert.equal(saved.status, 'resolved');
    assert.equal(saved.resolution?.resolvedBy, 'system_code_review');
    assert.ok(fs.existsSync(saved.lastCodeReview!.memoryPath!));
    assert.equal(loadBufferForUser(username, 'conversation').messages.at(-1)!.content, JSON.parse(reply).report);
    assert.ok(!getPendingTechnicalTickets(username).some(item => item.id === ticket.id));
  });
});

test('chat error transport records one real issue and its System Buffer evidence across repeat delivery', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const { handleSystemError } = await import('../api/handlers/system-error.js');
    const request = { method: 'POST', path: '/api/system-error', user: { username, userId: username, role: 'owner', isAuthenticated: true },
      body: { eventId: 'browser-error', message: 'Original browser failure', stack: 'Original stack', sessionId: 'browser-session' } } as const;
    const first = await handleSystemError(request);
    const second = await handleSystemError(request);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, second.data);
    const ticket = getTicket(username, (first.data as { ticketId: string }).ticketId)!;
    assert.equal(ticket.feedbackRating, undefined);
    assert.equal(ticket.errorEvidence?.stack, 'Original stack');
    assert.equal(loadBufferForUser(username, 'system').messages.filter(entry => entry.meta?.ticketId === ticket.id).length, 1);
  });
});

test('report delivery recovery preserves the original prepared report and never repeats investigation', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const ticket = issue('delivery-failure');
    reply = JSON.stringify({ report: 'Original complete diagnosis for delivery recovery.', issues: [outcome(ticket.id)] });
    const before = [planningCalls, terminalCalls];
    const { graph } = await loadGraphForMode('system-code-review', username);
    const failed = await runGraph({ graph, context: { ...context, recordPersonaMemory: false, codeReview: { issueIds: [ticket.id] } } });
    assert.equal(failed.status, 'failed');
    const prepared = failed.nodes.get('prepare')!.outputs!.prepared;
    assert.equal(getTicket(username, ticket.id)!.lastCodeReview, undefined);
    const recovered = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [ticket.id], reportOnly: true,
      reviewExecutionId: failed.executionId, recoveredPrepared: prepared, error: failed.error?.message } } });
    assert.equal(recovered.status, 'completed', recovered.error?.message);
    assert.deepEqual([planningCalls, terminalCalls], before.map(count => count + 1));
    const reports = loadBufferForUser(username, 'conversation').messages.filter(entry => entry.meta?.reviewExecutionId === failed.executionId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].content, JSON.parse(reply).report);
    assert.equal(getTicket(username, ticket.id)!.lastCodeReview?.executionId, failed.executionId);
  });
});

test('Active Operator receives the registered coding operation and unresolved issue evidence', async () => {
  fs.mkdirSync(path.join(root, 'brain/agents/system-code-review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brain/agents/system-code-review/cli.ts'), 'export {};');
  fs.copyFileSync(new URL('../../../../etc/agents.json', import.meta.url), path.join(root, 'etc/agents.json'));
  const { robotAutonomyTaskCatalogNode } = await import('../nodes/robot-operator/task-catalog.node.js');
  const pending = issue('operator-visible');
  const result = await robotAutonomyTaskCatalogNode.execute!({}, { username }, { taskIds: ['system-code-review'], includeActivityHistory: false });
  assert.equal(result.tasks[0]?.id, 'system-code-review');
  assert.ok(result.activationState.systemIssues.some((item: any) => item.id === pending.id));
  const { nodeRegistry } = await import('../nodes/index.js');
  const contextNode = nodeRegistry.get('robot_autonomy_controller_context')!;
  const selection = await contextNode.execute!({ activationState: result.activationState }, { username }, { contextPurpose: 'selection' });
  assert.ok(selection.request.includes(pending.id));
});

test('the terminal receives explicit array field types and its multi-issue report retains every outcome', async () => {
  await withUserContext({ username, userId: username, role: 'owner' }, async () => {
    const primary = issue('typed-report-primary');
    const duplicate = issue('typed-report-duplicate');
    const outcomes = [outcome(primary.id), { ...outcome(duplicate.id), outcome: 'duplicate', duplicateOf: primary.id }];
    reply = JSON.stringify({ report: 'Read-only investigation completed; repair remains proposed.', issues: outcomes });
    const { graph } = await loadGraphForMode('system-code-review', username);
    const state = await runGraph({ graph, context: { ...context, codeReview: { issueIds: [primary.id, duplicate.id] } } });
    assert.equal(state.status, 'completed', state.error?.message);
    assert.match(terminalPrompt, /The changedFiles, validation and evidence fields must be arrays of strings/);
    assert.match(terminalPrompt, /use \[\] when empty, never a plain string/);
    assert.equal(terminalPrompt, SYSTEM_CODE_REVIEW_TERMINAL_PROMPT);
    const prepared = state.nodes.get('prepare')!.outputs!.prepared;
    assert.equal(prepared.failed, false);
    assert.deepEqual(prepared.issues, outcomes);
    assert.equal(getTicket(username, primary.id)!.status, 'needs_fix');
    assert.equal(getTicket(username, duplicate.id)!.status, 'duplicate');
    assert.equal(getTicket(username, duplicate.id)!.duplicateOf, primary.id);
    assert.equal(loadBufferForUser(username, 'conversation').messages.at(-1)!.content, JSON.parse(reply).report);
    assert.ok(fs.existsSync(getTicket(username, duplicate.id)!.lastCodeReview!.memoryPath!));
  });
});
