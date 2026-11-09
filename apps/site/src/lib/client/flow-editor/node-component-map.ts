/**
 * Node Component Map
 *
 * Maps cognitive node type IDs to Svelte Flow component types.
 * Uses category-based components for maintainability.
 */

import type { NodeCategory } from '@metahuman/core/nodes/types';

// Category to component name mapping
const categoryToComponent: Record<NodeCategory, string> = {
  input: 'inputNode',
  output: 'outputNode',
  router: 'routerNode',
  control_flow: 'routerNode',
  context: 'contextNode',
  environment: 'environmentNode',
  operator: 'operatorNode',
  chat: 'llmNode',
  model: 'llmNode',
  skill: 'skillNode',
  memory: 'memoryNode',
  utility: 'utilityNode',
  agent: 'agentNode',
  config: 'utilityNode',
  persona: 'personaNode',
  thought: 'cognitiveNode',
  dreamer: 'cognitiveNode',
  curiosity: 'cognitiveNode',
  curator: 'curatorNode',
  safety: 'safetyNode',
  emulation: 'utilityNode',
  agency: 'agencyNode',
  cognitive: 'cognitiveNode',
  'active-operator': 'operatorNode',
};

/**
 * Get the Svelte Flow component type for a node
 * All schema-backed nodes use the category's shared BaseNode registration.
 * FlowEditor retains aliases for persisted component type names.
 */
export function getNodeComponentType(category: NodeCategory, _nodeType?: string): string {
  return categoryToComponent[category] || 'genericNode';
}
