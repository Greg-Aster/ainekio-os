import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-system-errors-'));
process.env.METAHUMAN_ROOT = root;
const { eventBus } = await import('../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { registerProfileStorageConfigGetter } = await import('../path-builder.js');
registerProfileStorageConfigGetter(username => ({ path: path.join(root, 'profiles', username), type: 'internal' }));
const { createHelpTicket, recordSystemError, getPendingTechnicalTickets, updateTicket, getTicket } = await import('./index.js');
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('system errors retain evidence without inventing user feedback and replay cannot reopen a resolved occurrence', () => {
  const evidence = { source: 'chat', eventId: 'request-1', message: 'Actual failure', occurredAt: new Date().toISOString(),
    requestId: 'request-1', executionId: 'execution-1', stack: 'Complete error stack' };
  const ticket = recordSystemError('owner', evidence);
  assert.equal(ticket.feedbackRating, undefined);
  assert.equal(ticket.origin, 'system');
  assert.deepEqual(getTicket('owner', ticket.id)?.errorEvidence, evidence);
  assert.equal(recordSystemError('owner', evidence).id, ticket.id);
  assert.equal(getPendingTechnicalTickets('owner').length, 1);
  updateTicket('owner', ticket.id, { status: 'resolved' });
  assert.equal(recordSystemError('owner', evidence).status, 'resolved');
  assert.deepEqual(getPendingTechnicalTickets('owner'), []);
  assert.notEqual(recordSystemError('owner', { ...evidence, eventId: 'request-2' }).id, ticket.id);
  assert.equal(getPendingTechnicalTickets('owner').length, 1, 'A new occurrence after repair remains evidence');
  assert.equal(getPendingTechnicalTickets('other').length, 0);
});

test('negative feedback retains its existing meaning and only technical tickets enter code review', () => {
  const ticket = createHelpTicket('feedback-owner', 'The memory is missing', 'memory', 'memory-1');
  assert.equal(ticket.feedbackRating, -1);
  assert.deepEqual(getPendingTechnicalTickets('feedback-owner'), []);
  updateTicket('feedback-owner', ticket.id, { category: 'system_error' });
  assert.equal(getPendingTechnicalTickets('feedback-owner')[0].id, ticket.id);
});
