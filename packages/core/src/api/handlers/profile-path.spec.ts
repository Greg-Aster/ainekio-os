import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Profile paths deliberately reject /tmp. Keep this isolated fixture in the
// existing ignored test cache, with its own installation and user store.
const cache = fileURLToPath(new URL('../../../../../node_modules/.cache/', import.meta.url));
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'api-profile-migration-'));
process.env.METAHUMAN_ROOT = root;
const { ROOT, getProfilePaths } = await import('../../path-builder.js');
assert.equal(ROOT, root);
const { setAuditEnabled } = await import('../../audit.js');
const { eventBus } = await import('../../infrastructure/event-bus/client.js');
const { createUser, getProfileStorageConfig } = await import('../../users.js');
const { withUserContext } = await import('../../context.js');
const { astroHandler } = await import('../adapters/astro.js');
setAuditEnabled(false);
eventBus.disconnect();
const account = createUser('migration-fixture', 'fixture-password', 'owner');
const user = { userId: account.id, username: account.username, role: 'owner' as const };
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

function migrate(body: unknown) {
  const url = new URL('http://localhost/api/profile-path');
  return withUserContext(user, () => astroHandler({
    url, request: new Request(url, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' } }),
    cookies: {}, params: {}, locals: { authResolved: true, userContext: user },
  }));
}

test('Core migration streams actual progress and updates only the fixture profile across repeated moves', async () => {
  const original = getProfilePaths(user.username).root;
  const relative = 'persona/core.json';
  const content = '{"identity":{"name":"Migration fixture"}}';
  fs.mkdirSync(path.join(original, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(original, relative), content);
  for (const name of ['first', 'second']) {
    const destination = path.join(root, name);
    const response = await migrate({ path: destination, keepSource: true, encryption: { type: 'none' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type')!, /text\/event-stream/);
    const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)));
    assert.ok(events.some(event => event.progress?.step === 'complete' && event.progress.status === 'completed'), JSON.stringify(events));
    assert.ok(events.every(event => !event.error && event.progress.status !== 'failed'), JSON.stringify(events));
    assert.equal(fs.readFileSync(path.join(destination, relative), 'utf8'), content);
    assert.equal(fs.readFileSync(path.join(original, relative), 'utf8'), content);
    assert.equal(getProfileStorageConfig(user.username)?.path, destination);
  }
});

test('migration preserves request validation and login-password verification before starting SSE', async () => {
  for (const [body, status, error] of [
    [{}, 400, 'Path is required'],
    [{ path: '/etc/profile-fixture' }, 400, 'Invalid path'],
    [{ path: getProfilePaths(user.username).root }, 400, 'New path is same as current path'],
    [{ path: path.join(root, 'wrong-password'), encryption: { type: 'aes256', useLoginPassword: true, password: 'wrong' } }, 401, 'Incorrect login password'],
  ] as const) {
    const response = await migrate(body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, error);
  }
  const destination = path.join(root, 'occupied');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'existing.txt'), 'Preserve existing destination');
  const response = await migrate({ path: destination });
  const progress = await response.text();
  assert.match(progress, /Destination is not empty/);
  assert.equal(fs.readFileSync(path.join(destination, 'existing.txt'), 'utf8'), 'Preserve existing destination');
  assert.equal(getProfileStorageConfig(user.username)?.path, path.join(root, 'second'));
});
