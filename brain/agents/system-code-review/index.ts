import type { AgentModule } from '@metahuman/agent-runtime';
import { run } from './core.js';
export const meta = { id: 'system-code-review', name: 'System Code Review', usesLLM: true,
  description: 'Reviews unresolved technical errors from chat and system execution, investigates their causes through an editable node workflow and Codex, and records findings and repair outcomes. Source repairs depend on the current trust authorization.',
  priority: 'normal' as const, tags: ['system', 'code', 'review'] };
const agent: AgentModule = { meta, run };
export default agent;
export { run, runCycle } from './core.js';
