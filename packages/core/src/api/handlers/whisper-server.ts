import type { UnifiedHandler } from '../types.js'
import { errorResponse, successResponse } from '../types.js'
import {
  ensureVoiceServiceRunning,
  getVoiceServiceStatus,
  stopVoiceService,
  updateVoiceServiceTarget,
} from '../../voice-service-manager.js'

export const handleWhisperServer: UnifiedHandler = async (req) => {
  try {
    if (req.method === 'GET') {
      return successResponse(await getVoiceServiceStatus('whisper'))
    }

    const action = req.body?.action
    if (action === 'start') {
      const status = await ensureVoiceServiceRunning('whisper')
      return successResponse({ success: true, message: 'Whisper server start accepted', ...status })
    }
    if (action === 'stop') {
      const result = await stopVoiceService('whisper')
      return successResponse(result)
    }
    if (action === 'set-target') {
      if (req.user && req.user.role !== 'owner') {
        return errorResponse('Only the installation owner can change voice service target', 403)
      }
      const target = req.body?.target
      const remoteUrl = req.body?.remoteUrl
      if (target !== 'local' && target !== 'remote') {
        return errorResponse('target must be "local" or "remote"', 400)
      }
      const updated = await updateVoiceServiceTarget('whisper', target, typeof remoteUrl === 'string' ? remoteUrl : undefined)
      return successResponse({ success: true, message: `Whisper target set to ${target}`, ...updated.status, config: updated.config })
    }
    return errorResponse('Invalid action. Use "start", "stop", or "set-target"', 400)
  } catch (error) {
    console.error('[whisper-server] Error:', error)
    return errorResponse((error as Error).message, 500)
  }
}
