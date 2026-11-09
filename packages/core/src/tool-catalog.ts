/** Capability metadata for the existing native task owner, consumed by Agency. */

import { ClaudeFullTaskNode } from './nodes/operator/claude-full-task.node.js';

export interface ToolCatalogEntry {
  skill: string;
  description: string;
  inputs: string;
  outputs: string;
  category: string;
  notes: string;
}

export function getCatalogEntries(): ToolCatalogEntry[] {
  const node = ClaudeFullTaskNode;
  return [{
    skill: node.id,
    description: node.description,
    inputs: node.inputs.map(input => `${input.name}${input.optional ? '' : '*'}: ${input.type}`).join(', '),
    outputs: node.outputs.map(output => `${output.name}: ${output.type}`).join(', '),
    category: node.category,
    notes: node.name,
  }];
}

export function buildToolCatalog(): string {
  const entries = getCatalogEntries();
  return `# Available Tools

You have access to ${entries.length} skills across these categories:

${entries.map(entry => `Skill: ${entry.skill}
Description: ${entry.description}
Inputs: ${entry.inputs}
Outputs: ${entry.outputs}
Category: ${entry.category}
Notes: ${entry.notes}`).join('\n\n---\n\n')}

IMPORTANT: Only use data from tool observations. Never invent or assume outputs.`;
}
