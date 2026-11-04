import { defineNode } from '../types.js';
import { getTicket, updateTicket, type HelpTicket } from '../../help-tickets/index.js';
import { collectSystemReviewIssues, systemCodeReviewAuthorization } from '../../help-tickets/code-review.js';
import { SYSTEM_CODE_REVIEW_PROMPT } from '../../help-tickets/code-review-prompts.js';
import type { ConversationMessage } from '../../conversation-buffer.js';

interface IssueOutcome {
  id: string;
  outcome: 'resolved' | 'unresolved' | 'not_actionable' | 'duplicate';
  diagnosis: string;
  solution: string;
  changedFiles: string[];
  validation: string[];
  evidence: string[];
  remainingWork: string;
  duplicateOf?: string;
}
interface PreparedReview {
  report: string;
  issues: IssueOutcome[];
  failed: boolean;
  executionId: string;
  entry: ConversationMessage;
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export function prepareCodeReviewResult(review: { issues: HelpTicket[]; executionId: string; error?: string }, work?: Record<string, any>): PreparedReview {
  let failed = Boolean(review.error || work?.state === 'failed');
  let report = '';
  let issues: IssueOutcome[] = [];
  try {
    if (failed) throw new Error(review.error || work?.error || 'Terminal investigation failed');
    if (review.issues.length === 0) report = 'No unresolved technical issues are currently recorded.';
    else {
      const raw = String(work?.result || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const value = JSON.parse(raw);
      if (typeof value.report !== 'string' || !value.report.trim() || !Array.isArray(value.issues)) throw new Error('The terminal response has no complete review report');
      report = value.report;
      const known = new Set(review.issues.map(issue => issue.id));
      for (const item of value.issues) {
        if (!known.delete(item.id) || !['resolved', 'unresolved', 'not_actionable', 'duplicate'].includes(item.outcome)
          || typeof item.diagnosis !== 'string' || typeof item.solution !== 'string' || typeof item.remainingWork !== 'string'
          || !strings(item.changedFiles) || !strings(item.validation) || !strings(item.evidence)
          || item.outcome === 'duplicate' && typeof item.duplicateOf !== 'string') throw new Error('The terminal response has invalid or incomplete issue outcomes');
        if (item.outcome === 'resolved' && (!item.validation.length || !item.evidence.length)) throw new Error('A resolved issue has no validation or evidence');
        if (work?.repairAuthorization?.canRepair === false && item.changedFiles.length) throw new Error('A read-only investigation reported source changes');
        issues.push(item);
      }
      if (known.size) throw new Error('The terminal response omitted supplied issues');
    }
  } catch (error) {
    failed = true;
    report = `System Code Review could not complete the investigation: ${(error as Error).message}`
      + (work?.result ? `\n\nTerminal report:\n${work.result}` : '');
    issues = review.issues.map(issue => ({ id: issue.id, outcome: 'unresolved', diagnosis: (error as Error).message,
      solution: '', changedFiles: [], validation: [], evidence: [], remainingWork: 'Investigation remains incomplete.' }));
  }
  return { report, issues, failed, executionId: review.executionId,
    entry: { role: 'assistant', content: report, timestamp: Date.now(), meta: {
      source: 'system-code-review', speaker: 'System Code Review', reviewExecutionId: review.executionId,
      issueIds: review.issues.map(issue => issue.id), outcomes: issues.map(issue => ({ id: issue.id, outcome: issue.outcome })),
      reviewFailed: failed, idempotencyKey: `system-code-review:${review.executionId}:report`,
    } } };
}

export const HelpTicketReviewInputNode = defineNode({
  id: 'help_ticket_review_input', name: 'Help Ticket Review Input', category: 'input',
  description: 'Loads pending technical help tickets, attributed evidence and current repair authorization for review.',
  inputs: [], outputs: [
    { name: 'review', type: 'object' }, { name: 'messages', type: 'array' },
    { name: 'selectedContext', type: 'object' }, { name: 'runInvestigation', type: 'boolean' },
    { name: 'recoveredWork', type: 'object', optional: true },
    { name: 'recoveredPrepared', type: 'object', optional: true },
    { name: 'toolAccess', type: 'string' },
  ],
  properties: { prompt: SYSTEM_CODE_REVIEW_PROMPT },
  propertySchemas: { prompt: { type: 'text_multiline', label: 'Review planning prompt', default: SYSTEM_CODE_REVIEW_PROMPT, rows: 12, canvas: 'primary' } },
  async execute(_inputs, context, properties) {
    const supplied = context.codeReview ?? {};
    const issues = Array.isArray(supplied.issueIds)
      ? supplied.issueIds.map((id: string) => getTicket(context.username!, id)).filter((issue: HelpTicket | null): issue is HelpTicket => Boolean(issue))
      : collectSystemReviewIssues(context.username!);
    const authorization = systemCodeReviewAuthorization(context.username!);
    const review = { issues, authorization, executionId: supplied.reviewExecutionId || context.graphExecution!.executionId, error: supplied.error };
    return { review, selectedContext: { issues }, recoveredWork: supplied.recoveredWork,
      recoveredPrepared: supplied.recoveredPrepared, toolAccess: 'read-only',
      runInvestigation: issues.length > 0 && supplied.reportOnly !== true,
      messages: [{ role: 'system', content: properties?.prompt ?? SYSTEM_CODE_REVIEW_PROMPT },
        { role: 'user', content: JSON.stringify({ ...review, instruction: context.taskBrief ?? null }) }],
    };
  },
});

export const HelpTicketReviewResultNode = defineNode({
  id: 'help_ticket_review_result', name: 'Help Ticket Review Result', category: 'output',
  description: 'Records review outcomes in the existing help ticket history and prepares an attributed report for conversation and memory.',
  inputs: [ { name: 'review', type: 'object', optional: true }, { name: 'toolWork', type: 'object', optional: true },
    { name: 'prepared', type: 'object', optional: true }, { name: 'memory', type: 'array', optional: true } ],
  outputs: [ { name: 'prepared', type: 'object' }, { name: 'entry', type: 'message' },
    { name: 'response', type: 'string' }, { name: 'recorded', type: 'boolean' }, { name: 'failed', type: 'boolean' } ],
  properties: { operation: 'prepare' },
  propertySchemas: { operation: { type: 'select', label: 'Operation', default: 'prepare', options: ['prepare', 'record'] } },
  async execute(inputs, context, properties) {
    const prepared: PreparedReview = inputs.prepared ?? prepareCodeReviewResult(inputs.review, inputs.toolWork);
    let recorded = false;
    if (properties?.operation === 'record') {
      const memory = inputs.memory as Array<{ eventId: string; filePath: string }>;
      if (!memory?.length) throw new Error('The review report has not been saved to Persona Memory');
      for (const result of prepared.issues) {
        const ticket = getTicket(context.username!, result.id);
        if (!ticket) throw new Error(`Review issue no longer exists: ${result.id}`);
        if (ticket.lastCodeReview?.executionId === prepared.executionId) continue;
        if (result.outcome === 'duplicate' && (result.duplicateOf === result.id || !getTicket(context.username!, result.duplicateOf!))) {
          throw new Error(`Duplicate review has no distinct existing ticket: ${result.duplicateOf}`);
        }
        const status = { resolved: 'resolved', unresolved: 'needs_fix', not_actionable: 'wont_fix', duplicate: 'duplicate' } as const;
        updateTicket(context.username!, result.id, {
          status: prepared.failed ? 'investigating' : status[result.outcome], duplicateOf: result.duplicateOf,
          llmAnalysis: { analyzedAt: new Date().toISOString(), summary: result.diagnosis,
            ...(!prepared.failed ? { rootCause: result.diagnosis } : {}),
            suggestedCategory: ticket.category || 'system_error', suggestedPriority: ticket.priority,
            proposedSolution: result.solution, relatedFiles: result.changedFiles,
            requiresCodeChange: !prepared.failed && result.outcome === 'unresolved', requiresTrainingChange: false },
          ...(result.outcome === 'resolved' || result.outcome === 'not_actionable' ? { resolution: {
            resolvedAt: new Date().toISOString(), resolvedBy: result.outcome === 'resolved' ? 'system_code_review' as const : 'wont_fix' as const,
            summary: result.diagnosis,
          } } : {}),
          lastCodeReview: { executionId: prepared.executionId, completedAt: new Date().toISOString(), outcome: result.outcome,
            reportKey: prepared.entry.meta!.idempotencyKey, memoryEventId: memory[0].eventId, memoryPath: memory[0].filePath },
        }, 'system', 'system_code_review');
      }
      recorded = true;
    }
    return { prepared, entry: prepared.entry, response: prepared.report, recorded, failed: prepared.failed };
  },
});
