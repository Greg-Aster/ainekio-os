import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import type { UnifiedRequest } from './api/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ainekio-audit-'));
process.env.METAHUMAN_ROOT = root;
const { eventBus } = await import('./infrastructure/event-bus/client.js');
// Persistence is real; the separate native server suite covers live transport.
eventBus.publish = () => {};
const { handleGetAudit } = await import('./api/handlers/audit.js');
const auditOwner = await import('./audit.js');
const request = (query: Record<string, string>): UnifiedRequest => ({ path: '/api/audit', method: 'GET',
  user: { userId: 'fixture', username: 'fixture', role: 'owner', isAuthenticated: true }, query });
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }); });

test('audit pages preserve every entry once across concurrent append and equal timestamps', async () => {
  const date = '2026-11-04';
  const dir = path.join(root, 'logs/audit');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.ndjson`);
  const entries = Array.from({ length: 7 }, (_, id) => ({ timestamp: `${date}T10:00:00Z`,
    level: id % 2 ? 'error' : 'info', category: 'system', event: `fixture-${id}`, details: { text: '🤖'.repeat(18000) } }));
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  const page = (query: Record<string, string>) => handleGetAudit(request({ date, limit: '2', ...query }));
  const first = await page({});
  assert.equal(first.status, 200);
  assert.equal(first.data.entries.length, 2);
  assert.equal(first.data.summary.total, 7);
  assert.deepEqual(first.data.entries.map((e: { event: string }) => e.event), ['fixture-6', 'fixture-5']);
  assert.equal(first.data.entries[0].details.text, entries[0].details.text);
  fs.appendFileSync(file, JSON.stringify({ ...entries[0], event: 'later-append' }) + '\n');
  const seen = first.data.entries.map((e: { event: string }) => e.event);
  let cursor = first.data.nextCursor;
  while (cursor !== null) {
    const next = await page({ before: String(cursor) });
    assert.equal(next.status, 200);
    seen.push(...next.data.entries.map((e: { event: string }) => e.event));
    cursor = next.data.nextCursor;
  }
  assert.deepEqual(seen, entries.map(entry => entry.event).reverse());
  const filtered = await page({ level: 'error' });
  assert.equal(filtered.data.matched, 3);
  assert.deepEqual(filtered.data.entries.map((e: { event: string }) => e.event), ['fixture-5', 'fixture-3']);
});

test('a damaged audit file reports failure instead of an empty successful history', async () => {
  fs.writeFileSync(path.join(root, 'logs/audit/2026-11-03.ndjson'), '{broken}\n');
  const response = await handleGetAudit(request({ date: '2026-11-03' }));
  assert.equal(response.status, 500);
});

test('cancelled reads release their file and do not produce a successful partial page', () => {
  const signal = AbortSignal.abort(new Error('fixture cancelled'));
  assert.throws(() => auditOwner.queryAuditLog({ date: '2026-11-04', signal }), /fixture cancelled/);
  fs.renameSync(path.join(root, 'logs/audit/2026-11-04.ndjson'), path.join(root, 'logs/audit/fixture.ndjson'));
});

test('settings survive a new process and preserve other logging configuration', () => {
  const dir = path.join(root, 'etc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logging.json'), JSON.stringify({ level: 'warn', levels: { module: 'error' } }));
  auditOwner.configureAudit({ enabled: false, retentionDays: 3 });
  try {
    assert.equal(auditOwner.isAuditEnabled(), false);
    const module = new URL('./audit.ts', import.meta.url).href;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import {getAuditSettings,configureAudit} from ${JSON.stringify(module)};
       console.log('SETTINGS:'+JSON.stringify(getAuditSettings()));configureAudit({enabled:true,retentionDays:2})`],
      { env, encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /SETTINGS:\{"enabled":false,"retentionDays":3\}/);
    assert.deepEqual(auditOwner.getAuditSettings(), { enabled: true, retentionDays: 2 }, 'a running process sees another process’s policy update');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'logging.json'), 'utf8'));
    assert.equal(saved.level, 'warn');
    assert.equal(saved.levels.module, 'error');
  } finally { auditOwner.configureAudit({ enabled: true, retentionDays: 7 }); }
});

test('module logging uses the shared API setting and retires nonfunctional options', async () => {
  const { handleSetLoggingConfig, handleGetLoggingConfig } = await import('./api/handlers/logging-config.js');
  const { createLogger } = await import('./logger.js');
  const update = await handleSetLoggingConfig({ ...request({}), method: 'POST',
    body: { level: 'error', suppressPatterns: ['/unused'], colorize: true, logSlowRequests: true } });
  assert.equal(update.status, 200);
  const response = await handleGetLoggingConfig(request({}));
  assert.equal(response.data.level, 'error');
  assert.equal('suppressPatterns' in response.data, false);
  assert.equal('logSlowRequests' in response.data, false);
  const previous = console.log;
  const previousError = console.error;
  const seen: unknown[][] = [];
  console.log = (...args) => { seen.push(args); };
  console.error = (...args) => { seen.push(args); };
  try {
    const logger = createLogger('fixture-module');
    logger.info('routine');
    logger.error('failure');
    assert.deepEqual(seen, [['[fixture-module]', 'failure']]);
  } finally { console.log = previous; console.error = previousError; }
});

test('profile creation keeps machine logging policy out of profile templates', async () => {
  const { initializeProfile } = await import('./profile.js');
  const template = path.join(root, 'profiles/_template/etc');
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, 'logging.json'), '{"level":"debug"}');
  fs.writeFileSync(path.join(template, 'retained.json'), '{"name":"{{USERNAME}}"}');
  await initializeProfile('fixture-profile');
  assert.equal(fs.existsSync(path.join(root, 'profiles/fixture-profile/etc/logging.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'profiles/fixture-profile/etc/retained.json'), 'utf8')).name, 'fixture-profile');
  assert.equal(fs.existsSync(path.join(root, 'etc/logging.json')), true);
});

test('profile creation omits retired boredom settings from existing templates', async () => {
  const { initializeProfile } = await import('./profile.js');
  const template = path.join(root, 'profiles/_template/etc');
  fs.mkdirSync(template, { recursive: true });
  const legacy = '{"enabled":true,"intervalMinutes":30}';
  fs.writeFileSync(path.join(template, 'boredom.json'), legacy);
  await initializeProfile('retired-boredom-template');
  assert.equal(fs.existsSync(path.join(root, 'profiles/retired-boredom-template/etc/boredom.json')), false);
  assert.equal(fs.readFileSync(path.join(template, 'boredom.json'), 'utf8'), legacy);
});

test('profile creation does not recreate retired boredom settings without a template', async () => {
  const { initializeProfile } = await import('./profile.js');
  const template = path.join(root, 'profiles/_template');
  const savedTemplate = path.join(root, 'profiles/_template-held');
  const hadTemplate = fs.existsSync(template);
  if (hadTemplate) fs.renameSync(template, savedTemplate);
  const seeds = ['models.json', 'training.json', 'psychoanalyzer.json'];
  for (const name of seeds) {
    fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
    fs.copyFileSync(new URL(`../../../etc/${name}`, import.meta.url), path.join(root, 'etc', name));
  }
  try {
    await initializeProfile('retired-boredom-fresh');
    const profileEtc = path.join(root, 'profiles/retired-boredom-fresh/etc');
    assert.equal(fs.existsSync(path.join(profileEtc, 'boredom.json')), false);
    assert.equal(fs.existsSync(path.join(profileEtc, 'sleep.json')), true);
    assert.equal(fs.existsSync(path.join(profileEtc, 'voice.json')), true);
  } finally {
    if (hadTemplate) fs.renameSync(savedTemplate, template);
  }
});

test('a damaged logging policy reports failures without breaking callers or recursing', async () => {
  const { createLogger } = await import('./logger.js');
  const filename = path.join(root, 'etc/logging.json');
  const saved = fs.readFileSync(filename);
  const previous = process.stderr.write;
  const messages: string[] = [];
  process.stderr.write = chunk => { messages.push(String(chunk)); return true; };
  try {
    fs.writeFileSync(filename, '{broken}');
    assert.doesNotThrow(() => auditOwner.audit({ level: 'error', category: 'system', event: 'fixture-failure' }));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Failed to write audit entry/);
    assert.doesNotThrow(() => createLogger('fixture').info('routine'));
    assert.equal(messages.length, 2);
    assert.match(messages[1], /Cannot read logging policy/);
  } finally { process.stderr.write = previous; fs.writeFileSync(filename, saved); }
});

test('context creation preserves the selected user without producing bookkeeping audit events', async () => {
  const { withUserContext, getUserContext } = await import('./context.js');
  const published: string[] = [];
  const original = eventBus.emit;
  eventBus.emit = (...args) => { published.push(args[1]); };
  try {
    for (let i = 0; i < 20; i++) await withUserContext({ userId: 'fixture', username: 'fixture', role: 'owner' }, async () => {
      assert.equal(getUserContext()?.username, 'fixture');
    });
    assert.equal(published.includes('audit.system'), false);
  } finally { eventBus.emit = original; }
});

test('repeated console logger initialization records a warning once and retains its actor', async () => {
  const { initGlobalLogger } = await import('./logging.js');
  const previous = console.warn;
  const previousError = console.error;
  try {
    initGlobalLogger('first');
    initGlobalLogger('second');
    console.warn('fixture-warning-once');
    const entries = auditOwner.queryAuditLog({ date: new Date().toISOString().slice(0, 10),
      match: entry => entry.event === 'fixture-warning-once' }).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, 'second');
  } finally { console.warn = previous; console.error = previousError; }
});
