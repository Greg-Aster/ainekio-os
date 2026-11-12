import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-action-identity-'));
process.env.METAHUMAN_ROOT = root;
const { setAuditEnabled } = await import('../../audit.js');
setAuditEnabled(false);
const { eventBus } = await import('../../infrastructure/event-bus/client.js');
eventBus.disconnect();
const { environmentActionContextInputNode: node } = await import('./action-context-input.node.js');
const { prepareEnvironmentCommand } = await import('../../environment-interface/store.js');
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('action evidence matches the full sent identity, not a truncated prefix', async () => {
  const prefix = 'action-'.repeat(40);
  const sentId = `${prefix}sent`;
  const prepared = prepareEnvironmentCommand({ id: sentId, type: 'requestMotion', description: 'wave', sessionId: 'fixture' });
  const record = { actionId: prepared.input.id, correlationId: `${prefix}complete-cycle` };
  const foreign = await node.execute({ actionId: `${prefix}different`, record }, {});
  assert.equal(foreign.available, false, 'A common prefix is not the same sent action');
  assert.equal(foreign.actionContext, null);
  const matched = await node.execute({ actionId: sentId, record }, {});
  assert.equal(matched.available, true);
  assert.equal(matched.actionId, sentId);
  assert.equal(matched.correlationId, record.correlationId, 'The complete cycle identity reaches downstream evidence correlation');
});

test('action identity comparison does not rewrite whitespace inside identifiers', async () => {
  const record = { actionId: 'sent  action', correlationId: 'cycle  one' };
  assert.equal((await node.execute({ actionId: 'sent action', record }, {})).available, false);
  const matched = await node.execute({ actionId: record.actionId, record }, {});
  assert.equal(matched.available, true);
  assert.equal(matched.correlationId, record.correlationId);
  assert.equal((await node.execute({ actionId: '', record }, {})).available, false);
});
