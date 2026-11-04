import type { UnifiedHandler } from '../types.js';
import { recordSystemError } from '../../help-tickets/index.js';
import { submitSystemEvent } from '../../buffer-admission.js';

export const handleSystemError: UnifiedHandler = async req => {
  const body = req.body || {};
  if (typeof body.message !== 'string' || !body.message.trim() || typeof body.eventId !== 'string' || !body.eventId.trim()) {
    return { status: 400, data: { error: 'An error message and event identity are required' } };
  }
  const evidence = { source: 'chat-interface', eventId: body.eventId, message: body.message,
    occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : new Date().toISOString(),
    ...(typeof body.stack === 'string' ? { stack: body.stack } : {}),
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
  };
  const ticket = recordSystemError(req.user.username, evidence);
  await submitSystemEvent(req.user.username, evidence.message, { source: 'chat-interface', type: 'chat_error',
    severity: 'error', ticketId: ticket.id, idempotencyKey: evidence.eventId, sessionId: evidence.sessionId });
  return { status: 200, data: { success: true, ticketId: ticket.id } };
};
