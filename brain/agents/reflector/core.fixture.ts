import { DEFAULT_GRAPH_SCHEDULER, type GraphExecutionState, type SvelteFlowGraph } from '@metahuman/core'

export const nodeIds = {
  text_input: 'persona-context-editable-id',
  reflection_memory_sampler: 'memory-editable-id',
  reflection_prompt: 'prompt-editable-id',
  reflector_llm: 'model-editable-id',
  reflection_buffer: 'reflection-buffer-editable-id',
  reasoning_buffer: 'reasoning-buffer-editable-id',
  reflection_memory: 'reflection-memory-editable-id',
  tts: 'tts-editable-id',
} as const

export const graph = {
  version: '1.0',
  format: 'svelte-flow',
  name: 'Reflector contract fixture',
  cognitiveMode: 'agent',
  scheduler: { ...DEFAULT_GRAPH_SCHEDULER },
  nodes: [
    ...Object.entries(nodeIds)
      .filter(([name]) => !['reflection_buffer', 'reasoning_buffer', 'reflection_memory'].includes(name))
      .map(([nodeType, id]) => ({
        id,
        type: 'cognitiveNode',
        position: { x: 0, y: 0 },
        data: { label: nodeType, nodeType, properties: {} },
      })),
    {
      id: nodeIds.reflection_memory,
      type: 'cognitiveNode', position: { x: 0, y: 0 },
      data: { label: 'reflection-memory', nodeType: 'inner_dialogue_saver', properties: { roles: ['reflection'] } },
    },
    {
      id: nodeIds.reflection_buffer,
      type: 'cognitiveNode',
      position: { x: 0, y: 0 },
      data: { label: 'reflection', nodeType: 'inner_dialogue_buffer', properties: { role: 'reflection' } },
    },
    {
      id: nodeIds.reasoning_buffer,
      type: 'cognitiveNode',
      position: { x: 0, y: 0 },
      data: { label: 'reasoning', nodeType: 'inner_dialogue_buffer', properties: { role: 'reasoning' } },
    },
  ],
  edges: [
    { id: 'persona-context', source: nodeIds.text_input, sourceHandle: 'text',
      target: nodeIds.reflection_prompt, targetHandle: 'personaContext' },
    { id: 'sampled-memories', source: nodeIds.reflection_memory_sampler, sourceHandle: 'memories',
      target: nodeIds.reflection_prompt, targetHandle: 'memories' },
    { id: 'system-prompt', source: nodeIds.reflection_prompt, sourceHandle: 'systemPrompt',
      target: nodeIds.reflector_llm, targetHandle: 'systemPrompt' },
    { id: 'user-prompt', source: nodeIds.reflection_prompt, sourceHandle: 'userPrompt',
      target: nodeIds.reflector_llm, targetHandle: 'prompt' },
    { id: 'generated-reflection', source: nodeIds.reflector_llm, sourceHandle: 'response',
      target: nodeIds.reflection_buffer, targetHandle: 'text' },
    { id: 'persisted-reflection', source: nodeIds.reflection_buffer, sourceHandle: 'entries',
      target: nodeIds.reflection_memory, targetHandle: 'entries' },
    { id: 'saved-speech', source: nodeIds.reflection_memory, sourceHandle: 'text',
      target: nodeIds.tts, targetHandle: 'innerDialogue' },
  ],
} as SvelteFlowGraph

export const successfulOutputs: Record<string, Record<string, any>> = {
  [nodeIds.text_input]: { text: 'Fixture persona context.' },
  [nodeIds.reflection_memory_sampler]: {
    ready: true,
    count: 4,
    candidateCount: 20,
    failedCount: 1,
    memories: [],
  },
  [nodeIds.reflection_prompt]: { ready: true, personaApplied: true,
    systemPrompt: 'Fixture instructions.', userPrompt: 'Fixture memories.' },
  [nodeIds.reflector_llm]: { response: 'A new reflection.' },
  [nodeIds.reflection_buffer]: {
    saved: true,
    persisted: true,
    text: 'A new reflection.',
    entries: [{ role: 'reflection', text: 'A new reflection.' }],
  },
  [nodeIds.reflection_memory]: {
    saved: true,
    eventId: 'evt-reflection',
    eventPath: 'memory/episodic/reflection.json',
    text: 'A new reflection.',
  },
  [nodeIds.reasoning_buffer]: { saved: true, persisted: true, text: 'Reasoning.' },
  [nodeIds.tts]: { queued: true, itemId: 'tts-item' },
}

export function graphState(
  overrides: Record<string, Record<string, any>> = {},
  status: GraphExecutionState['status'] = 'completed',
): GraphExecutionState {
  const outputs = { ...successfulOutputs, ...overrides }
  return {
    nodes: new Map(Object.values(nodeIds).map(id => [id, {
      nodeId: id,
      status: 'completed',
      startTime: 0,
      endTime: 1,
      outputs: outputs[id],
    }])),
    startTime: 0,
    endTime: 1,
    status,
  } as GraphExecutionState
}
