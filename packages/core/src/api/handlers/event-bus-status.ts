import type { UnifiedHandler } from '../types.js';
import { getEventBusStatus, startEventBusProcess, stopEventBusProcess } from '../../infrastructure/event-bus/server.js';

export const handleGetEventBusStatus: UnifiedHandler = async () => {
  try { return { status: 200, data: await getEventBusStatus() }; }
  catch (error) { return { status: 500, error: (error as Error).message }; }
};

export const handlePostEventBusStatus: UnifiedHandler = async req => {
  try {
    const action = req.body?.action;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return { status: 400, data: { success: false, error: `Unknown action: ${action}` } };
    }
    if (action === 'stop' || action === 'restart') await stopEventBusProcess();
    if (action === 'stop') {
      return { status: 200, data: { success: true, message: 'Managed event-bus process stopped' } };
    }
    const status = await startEventBusProcess();
    return { status: 200, data: { success: true, ...status,
      message: status.healthy ? 'Event bus server ready' : 'Event bus process starting; health pending' } };
  } catch (error) {
    return { status: 500, data: { success: false, error: (error as Error).message } };
  }
};
