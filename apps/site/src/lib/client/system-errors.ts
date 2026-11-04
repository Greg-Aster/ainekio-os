import { apiFetch } from './api-config';

/** Preserve the displayed error while its evidence is admitted by the existing server owners. */
export async function reportChatError(error: unknown, context: { eventId?: string; sessionId?: string; requestId?: string } = {}): Promise<void> {
  const response = await apiFetch('/api/system-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error ? { stack: error.stack } : {}), eventId: context.eventId || crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      sessionId: context.sessionId, requestId: context.requestId }) });
  if (!response.ok) throw new Error(`Unable to record chat error (${response.status})`);
}
