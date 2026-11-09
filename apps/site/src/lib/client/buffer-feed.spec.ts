import assert from 'node:assert/strict';
import {
  projectBufferFeed,
  receiveLiveConversation,
  replaceBufferSlice,
  stampBufferSource,
  type BufferView,
  type FeedMessage,
} from './buffer-feed.js';

type TestMessage = FeedMessage & {
  role: string;
  content: string;
  timestamp: number;
  relPath?: string;
  meta?: Record<string, any>;
};

const conversation = stampBufferSource<TestMessage>({
  role: 'user', content: 'spoken', timestamp: 30,
}, 'conversation');
const inner = stampBufferSource<TestMessage>({
  role: 'thought', content: 'unvoiced', timestamp: 10,
}, 'inner');
const system = stampBufferSource<TestMessage>({
  role: 'system', content: 'service started', timestamp: 40,
}, 'system');
const robot = stampBufferSource<TestMessage>({
  role: 'robot', content: 'wave queued', timestamp: 20,
}, 'robot');
const all = [conversation, inner, system, robot];

assert.deepEqual(
  projectBufferFeed(all, new Set<BufferView>(['conversation']), []).map(message => message.content),
  ['spoken'],
  'Conversation reads only Conversation Buffer',
);
assert.deepEqual(
  projectBufferFeed(all, new Set<BufferView>(['inner']), []).map(message => message.content),
  ['unvoiced'],
  'Inner reads only Inner Dialogue Buffer',
);
assert.deepEqual(
  projectBufferFeed(all, new Set<BufferView>(['system']), []).map(message => message.content),
  ['wave queued', 'service started'],
  'System chronologically merges Robot Buffer and System Buffer',
);
assert.deepEqual(
  projectBufferFeed(all, new Set<BufferView>(['conversation', 'inner']), []).map(message => message.content),
  ['unvoiced', 'spoken'],
  'Multi-select combines reads without selecting a write target',
);

const replaced = replaceBufferSlice(all, 'robot', [
  { role: 'robot', content: 'sit queued', timestamp: 5 },
]);
assert.deepEqual(
  replaced.filter(message => message.meta?.bufferSource === 'robot').map(message => message.content),
  ['sit queued'],
  'An authoritative stream update replaces only its own buffer slice',
);
assert.deepEqual(
  replaced.map(message => message.content),
  ['sit queued', 'unvoiced', 'spoken', 'service started'],
  'Replacement preserves global chronological order',
);

const live = { role: 'assistant', content: 'brief reaction', timestamp: 25,
  meta: { liveConversation: true, idempotencyKey: 'reaction-1' } };
let liveMessages = receiveLiveConversation<TestMessage>([], live);
liveMessages = receiveLiveConversation(liveMessages, { ...live });
assert.equal(liveMessages.length, 1, 'Replay of one delivery identity projects one reply');
liveMessages = receiveLiveConversation(liveMessages, {
  ...live, timestamp: 35, meta: { ...live.meta, idempotencyKey: 'reaction-2' },
});
assert.equal(liveMessages.length, 2, 'Separate events with equal text remain visible');
const updatedBuffers = replaceBufferSlice(all, 'conversation', [{ role: 'user', content: 'updated', timestamp: 50 }]);
assert.deepEqual(projectBufferFeed(updatedBuffers, new Set<BufferView>(['conversation']), liveMessages)
  .map(message => message.content), ['brief reaction', 'brief reaction', 'updated']);
assert.deepEqual(projectBufferFeed(updatedBuffers, new Set<BufferView>(['inner']), liveMessages)
  .map(message => message.content), ['unvoiced']);
assert.ok(updatedBuffers.every(message => !message.meta?.liveConversation),
  'Live view state never enters canonical buffer snapshots');


const terminal = stampBufferSource<TestMessage>({ role: 'assistant', content: 'Big Brother final answer', timestamp: 45,
  meta: { source: 'big-brother', speaker: 'Big Brother', submissionId: 'terminal-turn' } }, 'terminal');
assert.deepEqual(projectBufferFeed([...all, terminal], new Set<BufferView>(['terminal']), []).map(message => message.content),
  ['Big Brother final answer'], 'Terminal selects its canonical exchange history');
assert.deepEqual(projectBufferFeed([...all, terminal], new Set<BufferView>(['inner']), []).map(message => message.content),
  ['unvoiced'], 'Big Brother replies do not become unvoiced thoughts');

assert.deepEqual(projectBufferFeed([...all, terminal], new Set<BufferView>(['conversation']), []).map(message => message.content),
  ['spoken'], 'Conversation does not silently select the Terminal buffer');
assert.deepEqual(projectBufferFeed([...all, terminal], new Set<BufferView>(['conversation', 'terminal']), []).map(message => message.content),
  ['spoken', 'Big Brother final answer'], 'Conversation and Terminal combine chronologically when both are selected');
assert.deepEqual(projectBufferFeed([...all, terminal], new Set<BufferView>(['conversation', 'inner', 'system', 'terminal']), []).map(message => message.content),
  ['unvoiced', 'wave queued', 'spoken', 'service started', 'Big Brother final answer'], 'All four tabs share the same projection');

// A task's raw answer is a presentation of one actual saved record only when
// the producer supplies its identity. Equal text is never evidence of identity.
const views = new Set<BufferView>(['conversation', 'inner']);
for (const mode of ['conversation', 'inner'] as const) {
  const saved: TestMessage = stampBufferSource({ role: mode === 'inner' ? 'reflection' : 'assistant',
    content: 'Saved answer', timestamp: 80, relPath: 'actual-record.json',
    meta: { idempotencyKey: 'saved-answer', attribution: 'actual producer' } }, mode);
  const raw: TestMessage = { role: saved.role, content: '<think>Actual reasoning</think>Saved answer', timestamp: 90,
    taskId: 'accepted-task', responseEntry: { mode, id: 'saved-answer' }, meta: { bufferSource: mode } };
  for (const savedFirst of [true, false]) {
    let buffers: TestMessage[] = savedFirst ? [saved] : [];
    let presentations = savedFirst ? [] : receiveLiveConversation<TestMessage>([], raw);
    assert.equal(projectBufferFeed(buffers, views, presentations).length, 1);
    buffers = [saved];
    presentations = receiveLiveConversation(presentations, raw);
    presentations = receiveLiveConversation(presentations, { ...raw });
    const projected = projectBufferFeed(buffers, views, presentations);
    assert.equal(projected.length, 1, `${mode}: either arrival order and replay project one answer`);
    assert.equal(projected[0].content, raw.content, 'Raw thinking and reply content are preserved');
    assert.equal(projected[0].timestamp, saved.timestamp, 'Saved chronology survives the presentation overlay');
    assert.equal(projected[0].meta?.attribution, 'actual producer');
    assert.equal(projected[0].relPath, saved.relPath);
    assert.equal(buffers[0].content, 'Saved answer', 'Projection never rewrites persistence');
  }
  const other = { ...saved, meta: { ...saved.meta, idempotencyKey: 'different-saved-answer' } };
  assert.equal(projectBufferFeed([saved, other], views, [raw]).length, 2, 'Equal text with distinct saved identities stays distinct');
  const custom = { ...raw, responseEntry: undefined, content: saved.content };
  assert.equal(projectBufferFeed([saved], views, [custom]).length, 2, 'Unproven or ambiguous custom output is not merged by text');
  assert.equal(projectBufferFeed([], views, receiveLiveConversation([custom], { ...custom })).length, 1,
    'Task-only custom output replays once by its accepted task identity');
  assert.equal(projectBufferFeed([], views, [custom, { ...custom, taskId: 'another-task' }]).length, 2,
    'Separate task-only outputs with identical text stay distinct');
  assert.equal(projectBufferFeed([saved], views, [{ ...raw, responseEntry: { mode: mode === 'inner' ? 'conversation' : 'inner', id: 'saved-answer' } }]).length, 2,
    'IDs are scoped to their actual source buffer');
}

console.log('buffer-feed.spec.ts: all assertions passed');
