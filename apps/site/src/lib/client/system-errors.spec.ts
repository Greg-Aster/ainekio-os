import assert from 'node:assert/strict';
import test from 'node:test';
import { reportChatError } from './system-errors.js';

test('chat error admission preserves complete evidence and stable source identity', async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/system-error'));
    assert.equal(options?.method, 'POST');
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({ success: true, ticketId: 'fixture' });
  };
  try {
    const error = new Error('Complete error\n' + 'evidence '.repeat(1500));
    for (let repeat = 0; repeat < 2; repeat++) await reportChatError(error, { eventId: 'source-event', sessionId: 'session' });
    assert.equal(bodies[0].message, error.message);
    assert.equal(bodies[0].stack, error.stack);
    assert.equal(bodies[0].eventId, bodies[1].eventId);
    assert.ok(Number.isFinite(Date.parse(bodies[0].occurredAt)));
    assert.equal(bodies[0].sessionId, 'session');
  } finally { globalThis.fetch = original; }
});

test('failed error admission remains a reported delivery failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'storage unavailable' }, { status: 500 });
  try { await assert.rejects(reportChatError(new Error('original error')), /Unable to record chat error/); }
  finally { globalThis.fetch = original; }
});
