import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverTTSOutput } from './tts.node.js';
import type { TTSQueueItem } from '../../tts/delivery-queue.js';
import { normalizeRobotSpeechText } from '../../tts/robot-speech.js';

const request = {
  username: 'test-user',
  text: 'Hello from the robot.',
  mode: 'conversation' as const,
  source: 'environment-mode',
};

test('local speech keeps using the existing browser queue', async () => {
  let queued = 0;
  let rendered = 0;
  const result = await deliverTTSOutput(request, {
    getSettings: () => ({
      provider: 'kokoro',
      outputTarget: 'local',
      speechDisabled: false,
    }),
    queue: (_username, text, mode, source): TTSQueueItem => {
      queued += 1;
      return { id: 'tts-local', text, mode, source, timestamp: 1 };
    },
    renderRobot: async () => {
      rendered += 1;
      return { actionId: 'unexpected', requestId: 'unexpected', totalChunks: 1 };
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    deliveryId: 'tts-local',
    route: 'local',
    reason: undefined,
  });
  assert.equal(queued, 1);
  assert.equal(rendered, 0);
});

test('the main speech disable state prevents local queue admission', async () => {
  let queued = 0;
  const result = await deliverTTSOutput(request, {
    getSettings: () => ({
      provider: 'kokoro',
      outputTarget: 'local',
      speechDisabled: true,
    }),
    queue: () => {
      queued += 1;
      return null;
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.route, 'local');
  assert.match(result.reason || '', /disabled/i);
  assert.equal(queued, 0);
});

test('Environment Mode robot speech bypasses the browser queue exactly once', async () => {
  let queued = 0;
  let rendered = 0;
  const result = await deliverTTSOutput(request, {
    getSettings: () => ({
      provider: 'kokoro',
      outputTarget: 'robot',
      speechDisabled: false,
    }),
    queue: () => {
      queued += 1;
      return null;
    },
    createRequestId: () => 'tts-robot-test',
    renderRobot: async (options) => {
      rendered += 1;
      assert.equal(options.requestId, 'tts-robot-test');
      assert.equal(options.text, request.text);
      return {
        actionId: 'speech-action-1',
        requestId: options.requestId,
        totalChunks: 1,
      };
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    deliveryId: 'speech-action-1',
    route: 'robot',
  });
  assert.equal(queued, 0);
  assert.equal(rendered, 1);
});

test('fast body speech uses the originating robot session through the existing renderer', async () => {
  let rendered = 0;
  const result = await deliverTTSOutput({ ...request, source: 'fast-body-event', sessionId: 'event-body' }, {
    getSettings: () => ({ provider: 'kokoro', outputTarget: 'robot', speechDisabled: false }),
    queue: () => { throw new Error('Body event speech must not enter the browser queue'); },
    renderRobot: async (options) => {
      rendered += 1;
      assert.equal(options.sessionId, 'event-body');
      assert.equal(options.text, request.text);
      return { actionId: 'body-event-speech', requestId: options.requestId, totalChunks: 1 };
    },
  });
  assert.equal(rendered, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryId, 'body-event-speech');
});

test('the main speech disable state blocks server-owned robot synthesis', async () => {
  let queued = 0;
  let rendered = 0;
  const result = await deliverTTSOutput(request, {
    getSettings: () => ({
      provider: 'kokoro',
      outputTarget: 'robot',
      speechDisabled: true,
    }),
    queue: () => {
      queued += 1;
      return null;
    },
    renderRobot: async () => {
      rendered += 1;
      return { actionId: 'unexpected', requestId: 'unexpected', totalChunks: 1 };
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.route, 'robot');
  assert.match(result.reason || '', /disabled/i);
  assert.equal(queued, 0);
  assert.equal(rendered, 0);
});

test('every workflow follows destination changes without a source or dialogue-mode override', async () => {
  for (const source of ['reflector', 'daydreamer', 'environment-mode', 'fast-body-event']) {
    for (const mode of ['inner', 'conversation'] as const) {
      let destination: 'local' | 'robot' = 'robot';
      let disabled = false;
      const deliveries: string[] = [];
      const dependencies = {
        getSettings: () => ({ provider: 'kokoro', outputTarget: destination, speechDisabled: disabled }),
        queue: (_username: string, text: string, deliveredMode: string, deliveredSource?: string): TTSQueueItem => {
          assert.equal(deliveredMode, mode);
          assert.equal(deliveredSource, source);
          deliveries.push('browser');
          return { id: 'browser-speech', text, mode, source, timestamp: 1 };
        },
        renderRobot: async (options: { text: string; requestId: string }) => {
          assert.equal(options.text, request.text);
          deliveries.push('body-control');
          return { actionId: 'robot-speech', requestId: options.requestId, totalChunks: 1 };
        },
      };
      const input = { ...request, source, mode };
      assert.equal((await deliverTTSOutput(input, dependencies)).route, 'robot');
      destination = 'local';
      assert.equal((await deliverTTSOutput(input, dependencies)).route, 'local');
      disabled = true;
      assert.equal((await deliverTTSOutput(input, dependencies)).accepted, false);
      destination = 'robot';
      assert.equal((await deliverTTSOutput(input, dependencies)).accepted, false);
      disabled = false;
      assert.equal((await deliverTTSOutput(input, dependencies)).route, 'robot');
      assert.deepEqual(deliveries, ['body-control', 'browser', 'body-control']);
    }
  }
});

test('a reflection stages speech through the same durable owner as conversation', async () => {
  const effects: any[] = [];
  const execution = {
    occurrenceId: 'reflection-tts',
    dispatch: (effect: unknown) => {
      effects.push(effect);
      return { effectId: 'reflection-delivery' };
    },
  } as NonNullable<Parameters<typeof deliverTTSOutput>[0]['execution']>;
  const result = await deliverTTSOutput({
    ...request, mode: 'inner', source: 'reflector', sessionId: 'origin-body', execution,
  }, {
    getSettings: () => ({ provider: 'kokoro', outputTarget: 'robot', speechDisabled: false }),
    queue: () => { throw new Error('Must not also enqueue browser playback'); },
    renderRobot: async () => { throw new Error('Durable work must own rendering'); },
  });
  assert.deepEqual(result, { accepted: true, route: 'robot', deliveryId: 'reflection-delivery' });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind, 'coordinator_work');
  assert.equal(effects[0].payload.handler, 'tts.robot-speech');
  assert.equal(effects[0].payload.input.sessionId, 'origin-body');
  assert.equal(effects[0].payload.input.text, request.text);
  assert.equal(effects[0].payload.input.requestId, 'reflection-tts');
});

test('Body Control failure is reported without falling back to browser playback', async () => {
  const result = await deliverTTSOutput({ ...request, mode: 'inner', source: 'reflector' }, {
    getSettings: () => ({ provider: 'kokoro', outputTarget: 'robot', speechDisabled: false }),
    queue: () => { throw new Error('Must not substitute a different destination'); },
    renderRobot: async () => { throw new Error('Body Control disconnected'); },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.route, 'robot');
  assert.equal(result.reason, 'Body Control disconnected');
});

test('server-owned robot speech strips non-speakable model formatting', () => {
  assert.equal(
    normalizeRobotSpeechText('<think>hidden</think> **Hello** [friend](https://example.com).'),
    'Hello friend.',
  );
});
