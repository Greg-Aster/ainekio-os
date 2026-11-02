import { DEFAULT_GRAPH_SCHEDULER, type GraphExecutionState, type SvelteFlowGraph } from '@metahuman/core'

export const nodeIds = {
  dreamer_memory_curator: 'curator-arbitrary-id',
  daydreamer_generator: 'generator-arbitrary-id',
  dreamer_dream_saver: 'saver-arbitrary-id',
  inner_dialogue_buffer: 'buffer-arbitrary-id',
} as const;

export const graph = {
  version: '1.0',
  format: 'svelte-flow',
  name: 'Daydreamer contract fixture',
  cognitiveMode: 'agent',
  scheduler: { ...DEFAULT_GRAPH_SCHEDULER },
  nodes: Object.entries(nodeIds).map(([nodeType, id]) => ({
    id,
    type: 'cognitiveNode',
    position: { x: 0, y: 0 },
    data: { label: nodeType, nodeType, properties: {} },
  })),
  edges: [
    { id: 'curated-memories', source: nodeIds.dreamer_memory_curator, sourceHandle: 'memories',
      target: nodeIds.daydreamer_generator, targetHandle: 'memories' },
    { id: 'generated-daydream', source: nodeIds.daydreamer_generator, sourceHandle: 'daydream',
      target: nodeIds.dreamer_dream_saver, targetHandle: 'dreamData' },
    { id: 'saved-inner-thought', source: nodeIds.dreamer_dream_saver, sourceHandle: 'dream',
      target: nodeIds.inner_dialogue_buffer, targetHandle: 'text' },
  ],
} as SvelteFlowGraph;

export const successfulOutputs: Record<keyof typeof nodeIds, Record<string, any>> = {
  dreamer_memory_curator: { count: 5, avgAgeDays: 12, memories: [] },
  daydreamer_generator: { daydream: 'A grounded test daydream with enough content.' },
  dreamer_dream_saver: { saved: true, eventId: 'evt-daydream', dream: 'A grounded test daydream with enough content.' },
  inner_dialogue_buffer: { saved: true, persisted: true },
};

export function graphState(
  overrides: Partial<typeof successfulOutputs> = {},
  status: GraphExecutionState['status'] = 'completed',
): GraphExecutionState {
  const outputs = { ...successfulOutputs, ...overrides };
  const nodes = new Map(
    Object.entries(nodeIds).map(([nodeType, id]) => [id, {
      nodeId: id,
      status: 'completed',
      startTime: 0,
      endTime: 1,
      inputs: {},
      outputs: outputs[nodeType as keyof typeof successfulOutputs],
    }]),
  );
  return { nodes, startTime: 0, endTime: 1, status } as GraphExecutionState;
}
