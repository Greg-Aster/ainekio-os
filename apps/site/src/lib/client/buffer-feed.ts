import type { ResponseEntryReference } from '@metahuman/core/cognitive-graph-contract';

export type BufferSource = 'conversation' | 'inner' | 'system' | 'robot' | 'terminal';
export type BufferView = 'conversation' | 'inner' | 'system' | 'terminal';

export interface FeedMessage {
  timestamp?: number;
  meta?: Record<string, any> | null;
  responseEntry?: ResponseEntryReference;
  taskId?: string;
}

function deliveryIdentity(message: FeedMessage): string | undefined {
  if (message.responseEntry) return JSON.stringify([message.responseEntry.mode, message.responseEntry.id]);
  const source = message.meta?.bufferSource || (message.meta?.liveConversation ? 'conversation' : undefined);
  const id = message.meta?.idempotencyKey;
  if (source && id) return JSON.stringify([source, id]);
  return message.taskId ? JSON.stringify(['task', message.taskId]) : undefined;
}

export function stampBufferSource<T extends FeedMessage>(
  message: T,
  source: BufferSource,
): T {
  return {
    ...message,
    meta: { ...(message.meta || {}), bufferSource: source },
  };
}

export function replaceBufferSlice<T extends FeedMessage>(
  current: T[],
  source: BufferSource,
  replacement: T[],
): T[] {
  return [
    ...current.filter(message => message.meta?.bufferSource !== source),
    ...replacement.map(message => stampBufferSource(message, source)),
  ].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

/** Project replayed delivery identities once, while retaining distinct equal-text reactions. */
export function receiveLiveConversation<T extends FeedMessage>(current: T[], message: T): T[] {
  const id = deliveryIdentity(message);
  return [...current.filter(entry => !(message.taskId && entry.taskId === message.taskId)
    && (!id || deliveryIdentity(entry) !== id)), message];
}

/**
 * Project canonical buffer records and live replies into the selectable chat views.
 * Selection controls reads only; it has no relationship to compose target.
 */
export function projectBufferFeed<T extends FeedMessage>(
  messages: T[],
  selectedViews: ReadonlySet<BufferView>,
  presentations: T[],
): T[] {
  const projected = [...messages];
  const positions = new Map<string, number>();
  projected.forEach((message, index) => {
    const id = deliveryIdentity(message);
    if (id) positions.set(id, index);
  });
  for (const presentation of presentations) {
    const id = deliveryIdentity(presentation);
    const index = id ? positions.get(id) : undefined;
    if (index !== undefined) {
      const saved = projected[index];
      projected[index] = { ...saved, ...presentation,
        timestamp: saved.timestamp ?? presentation.timestamp,
        meta: { ...saved.meta, ...presentation.meta } };
    } else {
      if (id) positions.set(id, projected.length);
      projected.push(presentation);
    }
  }
  return projected
    .filter(message => {
      if (message.meta?.liveConversation === true) return selectedViews.has('conversation');
      const source = message.meta?.bufferSource;
      if (source === 'terminal') return selectedViews.has('terminal');
      if (source === 'conversation') return selectedViews.has('conversation');
      if (source === 'inner') return selectedViews.has('inner');
      if (source === 'system' || source === 'robot') return selectedViews.has('system');
      return false;
    })
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}
