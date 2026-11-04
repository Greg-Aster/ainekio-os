import { collectSystemReviewIssues, getTargetUser, loadGraphForMode, runGraph, withUserContext, type GraphExecutionState } from '@metahuman/core';
import type { AgentContext, AgentInput, AgentResult } from '@metahuman/agent-runtime';

export async function runCycle(options: { username?: string; signal?: AbortSignal; taskBrief?: string } = {}) {
  const user = getTargetUser({ username: options.username });
  if (!user) throw new Error('System Code Review requires an authenticated profile');
  return withUserContext(user, async () => {
    const issues = collectSystemReviewIssues(user.username);
    const { graph } = await loadGraphForMode('system-code-review', user.username);
    const codeReview = { issueIds: issues.map(issue => issue.id) };
    const base = { username: user.username, userId: user.userId, cognitiveMode: 'agent',
      allowMemoryWrites: true, recordPersonaMemory: true, taskBrief: options.taskBrief, codeReview };
    let state: GraphExecutionState;
    try { state = await runGraph({ graph, signal: options.signal, context: base }); }
    catch (error) {
      // The same report-only graph path preserves failure without rerunning the planner or Codex.
      state = await runGraph({ graph, context: { ...base, codeReview: { ...codeReview, reportOnly: true,
        error: (error as Error).message } } });
    }
    const record = state.nodes.get('record');
    if (record?.outputs?.recorded) return { success: state.status !== 'failed' && !record.outputs.failed,
      executionId: state.executionId, report: record.outputs.response, error: state.error?.message };
    if (state.status === 'waiting') return { success: true, executionId: state.executionId, pending: true };
    const failure = state.error?.message || 'The code review workflow did not save its report';
    const report = await runGraph({ graph, context: { ...base, codeReview: { ...codeReview, reportOnly: true,
      reviewExecutionId: state.executionId, error: failure, recoveredWork: state.nodes.get('terminal')?.outputs?.toolWork,
      recoveredPrepared: state.nodes.get('prepare')?.outputs?.prepared } } });
    const reported = report.nodes.get('record')?.outputs;
    return { success: false, executionId: state.executionId, reportExecutionId: report.executionId,
      report: reported?.response, error: failure };
  });
}

export async function run(ctx: AgentContext, input: AgentInput): Promise<AgentResult> {
  const started = Date.now();
  const result = await runCycle({ username: ctx.username, signal: ctx.signal,
    taskBrief: typeof input.options?.taskBrief === 'string' ? input.options.taskBrief : undefined });
  return { success: result.success, data: result, error: result.error, duration: Date.now() - started };
}
