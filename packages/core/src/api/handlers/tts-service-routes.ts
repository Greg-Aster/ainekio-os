import type { UnifiedHandler } from '../types.js';
import {
  ensureVoiceServiceRunning,
  getVoiceServiceStatus,
  stopVoiceService,
  updateVoiceServiceTarget,
  type VoiceServiceId,
} from '../../voice-service-manager.js';

function managedVoiceServer(id: VoiceServiceId): UnifiedHandler {
  return async (req) => {
  try {
    if (req.method === 'GET') return { status: 200, data: await getVoiceServiceStatus(id) };

    const { action, target, remoteUrl } = req.body ?? {};
    if (action === 'start') {
      const result = await ensureVoiceServiceRunning(id);
      return { status: 200, data: { success: true, message: `${id} server start accepted`, ...result } };
    }

    if (action === 'stop') {
      const result = await stopVoiceService(id);
      return { status: result.success ? 200 : 500, data: result };
    }

    if (action === 'set-target') {
      if (req.user && req.user.role !== 'owner') {
        return { status: 403, data: { error: 'Only the installation owner can change voice service target', success: false } };
      }
      if (target !== 'local' && target !== 'remote') {
        return { status: 400, data: { error: 'target must be "local" or "remote"', success: false } };
      }
      const updated = await updateVoiceServiceTarget(id, target, typeof remoteUrl === 'string' ? remoteUrl : undefined);
      return { status: 200, data: { success: true, message: `${id} target set to ${target}`, ...updated.status, config: updated.config } };
    }

    return { status: 400, data: { error: 'Invalid action. Use "start", "stop", or "set-target".' } };
  } catch (error) {
    return { status: 500, data: { error: String(error), success: false, running: false } };
  }
  };
}

export const handleKokoroServer = managedVoiceServer('kokoro');
