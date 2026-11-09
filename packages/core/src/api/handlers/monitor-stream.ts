import fs from 'node:fs';
import path from 'node:path';
import type { UnifiedHandler } from '../types.js';
import { streamResponse } from '../types.js';
import { getAgentMonitorSnapshot } from '../../agent-monitor.js';
import { subscribeEnvironmentBridgeState } from '../../environment-interface/index.js';
import { subscribeEnvironmentBridgeDiagnostics } from '../../environment-interface/diagnostics.js';
import { systemPaths } from '../../path-builder.js';
import { getQueueManager } from '../../queue/unified-queue-manager.js';
import type { QueueEvent } from '../../queue/types.js';

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const handleMonitorStream: UnifiedHandler = async (req) => {
  const response = streamResponse(streamMonitorUpdates(req.signal));
  return {
    ...response,
    headers: {
      ...response.headers,
      'X-Accel-Buffering': 'no',
    },
  };
};

async function* streamMonitorUpdates(signal: AbortSignal | undefined): AsyncGenerator<string> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  const watchers: fs.FSWatcher[] = [];

  const push = (data: Record<string, unknown>) => {
    if (closed) return;
    queue.push(sse(data));
    wake?.();
    wake = undefined;
  };

  const close = () => {
    closed = true;
    wake?.();
    wake = undefined;
  };

  const sendSnapshot = () => {
    if (closed) return;
    try {
      const snapshot = getAgentMonitorSnapshot();

      push({
        type: 'snapshot',
        ...snapshot,
        agents: snapshot.runningAgents,
      });
    } catch (error) {
      console.error('Error computing agent monitor snapshot:', error);
      push({ type: 'error', error: (error as Error).message });
    }
  };

  const scheduleSnapshot = () => {
    if (closed) return;
    // Coalesce updates without waiting for the robot's telemetry to become idle.
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      sendSnapshot();
    }, 100);
  };

  const watchPath = (target: string, options: fs.WatchOptions = {}, filenames?: string[]) => {
    try {
      if (!fs.existsSync(target)) return;
      const watcher = fs.watch(target, options, (_event, filename) => {
        if (!filenames || filename === null || filenames.includes(filename.toString())) scheduleSnapshot();
      });
      watcher.on('error', error => push({ type: 'error', error: error.message }));
      watchers.push(watcher);
    } catch (error) {
      console.warn('[monitor/stream] Watch failed:', target, (error as Error).message);
      push({ type: 'error', error: (error as Error).message });
    }
  };

  push({ type: 'connected' });
  const unsubscribeBridgeState = subscribeEnvironmentBridgeState(scheduleSnapshot);
  const unsubscribeBridgeDiagnostics = subscribeEnvironmentBridgeDiagnostics(scheduleSnapshot);
  const queueManager = getQueueManager();
  const queueListener = (event: QueueEvent) => {
    if (event.type !== 'task_output') scheduleSnapshot();
  };
  queueManager.addEventListener(queueListener);

  watchPath(path.join(systemPaths.logs, 'agents'));
  watchPath(path.join(systemPaths.run, 'locks'));
  // Watch directories so atomic config replacement keeps the subscription alive.
  watchPath(systemPaths.etc, {}, ['agents.json', 'services.json']);
  watchPath(systemPaths.agents, { recursive: true });
  watchPath(path.join(systemPaths.brain, 'services'), { recursive: true });
  sendSnapshot();

  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  try {
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    unsubscribeBridgeState();
    unsubscribeBridgeDiagnostics();
    queueManager.removeEventListener(queueListener);
    for (const watcher of watchers) {
      watcher.close();
    }
    signal?.removeEventListener('abort', close);
    close();
  }
}
