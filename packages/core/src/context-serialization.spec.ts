import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeContext, parseContext } from './context-serialization.js';

const expandReferences = (value: any) => parseContext(JSON.stringify(value));

test('repeated observations and action receipts remain losslessly accessible with their provenance', () => {
  const observation = { summary: 'A book beside a lamp on the table.', observedAt: '2026-10-08T12:00:00Z', frameId: 'frame-1', source: 'camera' };
  const action = { id: 'action-1', type: 'requestMotion', description: 'bow', result: 'completed', at: '2026-10-09T12:00:00Z' };
  const input = { observationHistory: [observation], robotStatus: {
    latestVisualObservation: observation, lastAction: action, lastBodyAction: action,
  }, history: [{ role: 'user', content: 'What did you dream last night?', timestamp: '2026-10-09T12:00:01Z' },
    { role: 'inner', content: 'A dated dream.', timestamp: '2026-10-08T02:00:00Z' }],
    objective: 'Look at the table', capabilities: { actions: ['takePicture', 'requestMotion'] } };
  const result = serializeContext(input);
  assert(result.length < JSON.stringify(input).length);
  assert.deepEqual(JSON.parse(result).robotStatus.latestVisualObservation, { $ref: '#/observationHistory/0' });
  assert.deepEqual(expandReferences(JSON.parse(result)), input);
  assert.deepEqual(input.robotStatus.lastBodyAction, action);
});

test('distinct dates, speakers and receipts are not conflated; pointer keys are escaped', () => {
  const fact = { content: 'The same words with different source and time.', role: 'user', at: '2026-10-08' };
  const input = { 'a/b~c': fact, same: fact, otherSpeaker: { ...fact, role: 'assistant' }, otherDate: { ...fact, at: '2026-10-09' }, empty: [{}, {}] };
  const result = JSON.parse(serializeContext(input));
  assert.deepEqual(result.same, { $ref: '#/a~1b~0c' });
  assert.equal(result.otherSpeaker.role, input.otherSpeaker.role);
  assert.equal(result.otherDate.at, input.otherDate.at);
  assert.deepEqual(result.empty, [{}, {}]);
  assert.deepEqual(expandReferences(result), input);
});

test('repeated instruction text is represented once without merging its different records', () => {
  const instruction = 'Continue the recorded investigation with the original objective and returned evidence. '.repeat(12);
  const input = { activity: { instruction, source: 'autonomy', timestamp: '2026-10-27T12:00:00Z' },
    execution: { instruction, source: 'user', timestamp: '2026-10-27T12:01:00Z' },
    history: [{ content: instruction, role: 'assistant', timestamp: '2026-10-27T12:02:00Z' }] };
  const serialized = serializeContext(input, true);
  const result = JSON.parse(serialized);
  assert.deepEqual(result.execution.instruction, { $ref: '#/activity/instruction' });
  assert.deepEqual(expandReferences(result), input);
  assert.equal(result.execution.source, 'user');
  assert.equal(result.history[0].role, 'assistant');
  assert.ok(serialized.length < JSON.stringify(input).length / 2);
});
