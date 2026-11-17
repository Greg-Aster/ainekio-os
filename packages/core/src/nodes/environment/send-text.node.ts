import { defineNode } from '../types.js';
import {
  queueEnvironmentBridgeText,
  summarizeEnvironmentBridgeState,
} from '../../environment-interface/index.js';

function extractTextValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['response', 'content', 'cleaned', 'text', 'output', 'message']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = extractTextValue(candidate);
      if (nested) return nested;
    }
  }
  return '';
}

function normalizeRole(value: unknown, fallback: 'assistant' | 'user' | 'system'): 'assistant' | 'user' | 'system' {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  return fallback;
}

export const environmentSendTextNode = defineNode({
  id: 'environment_send_text',
  name: 'Body Control Text Out',
  aliases: ['body_control_text_out'],
  category: 'environment',
  inputs: [
    { name: 'text', type: 'any', description: 'Workflow response or message text to stream to Body Control' },
    { name: 'entry', type: 'message', optional: true, description: 'Single conversation entry with role and timestamp' },
    { name: 'entries', type: 'array', optional: true, description: 'Conversation entries to forward in order' },
    { name: 'metadata', type: 'object', optional: true, description: 'Optional provenance metadata for the message' },
    { name: 'sessionId', type: 'string', optional: true, description: 'Target Environment Bridge session ID' },
  ],
  outputs: [
    { name: 'sent', type: 'boolean', primary: true, description: 'Whether text was queued for Environment Bridge delivery' },
    { name: 'text', type: 'string', description: 'Forwarded text content' },
    { name: 'targetSessionId', type: 'string', description: 'Connected Environment Bridge session ID, when available' },
    { name: 'status', type: 'string', description: 'Delivery status: queued, empty, bridge_disabled, or no_session' },
  ],
  properties: {
    role: 'assistant',
    source: '',
  },
  propertySchemas: {
    role: {
      type: 'select',
      default: 'assistant',
      label: 'Speaker Role',
      options: ['assistant', 'user', 'system'],
      description: 'Default role label when forwarding plain text rather than a typed conversation entry.',
    },
    source: {
      type: 'string',
      default: '',
      label: 'Source Label',
      description: 'Optional workflow or channel label shown alongside the message in Ainekio Cockpit.',
    },
  },
  execution: {
    activation: 'any-input',
    requiredInputs: [],
  },
  description: 'Streams workflow text outputs through the Environment Bridge to the Body Control Ainekio Cockpit.',
  async execute(inputs, context, properties) {
    const fallbackRole = normalizeRole(properties?.role, 'assistant');
    const metadataObj = inputs.metadata && typeof inputs.metadata === 'object' && !Array.isArray(inputs.metadata)
      ? inputs.metadata as Record<string, unknown>
      : {};
    const configuredSource = typeof metadataObj.dialogueSource === 'string' && metadataObj.dialogueSource.trim()
      ? metadataObj.dialogueSource.trim()
      : typeof properties?.source === 'string' && properties.source.trim()
        ? properties.source.trim()
        : typeof metadataObj.source === 'string' && metadataObj.source.trim()
          ? metadataObj.source.trim()
          : context.cognitiveMode || '';

    const items: Array<{ text: string; role: 'assistant' | 'user' | 'system'; timestamp?: string }> = [];
    if (Array.isArray(inputs.entries) && inputs.entries.length > 0) {
      for (const entry of inputs.entries) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const content = extractTextValue(rec);
        if (!content) continue;
        const ts = typeof rec.timestamp === 'number'
          ? new Date(rec.timestamp).toISOString()
          : typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
        items.push({ text: content, role: normalizeRole(rec.role, fallbackRole), timestamp: ts });
      }
    } else if (inputs.entry && typeof inputs.entry === 'object') {
      const rec = inputs.entry as Record<string, unknown>;
      const content = extractTextValue(rec);
      if (content) {
        const ts = typeof rec.timestamp === 'number'
          ? new Date(rec.timestamp).toISOString()
          : typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
        items.push({ text: content, role: normalizeRole(rec.role, fallbackRole), timestamp: ts });
      }
    } else {
      const content = extractTextValue(inputs.text);
      if (content) {
        items.push({ text: content, role: fallbackRole });
      }
    }

    if (items.length === 0) {
      return { sent: false, text: '', targetSessionId: '', status: 'empty' };
    }

    const combinedText = items.map(item => item.text).join('\n\n');
    const requestedSessionId = typeof inputs.sessionId === 'string' ? inputs.sessionId.trim() : '';
    const bridge = summarizeEnvironmentBridgeState();
    if (!bridge.enabled) {
      return { sent: false, text: combinedText, targetSessionId: requestedSessionId, status: 'bridge_disabled' };
    }
    const targetSession = requestedSessionId
      ? bridge.sessions.find(session => session.sessionId === requestedSessionId && session.status === 'connected')
      : bridge.sessions.find(session => session.status === 'connected');
    if (!targetSession) {
      return { sent: false, text: combinedText, targetSessionId: requestedSessionId, status: 'no_session' };
    }

    const targetSessionId = targetSession.sessionId;
    for (const item of items) {
      const payload = {
        sessionId: targetSessionId,
        text: item.text,
        role: item.role,
        ...(configuredSource ? { source: configuredSource } : {}),
        ...(context.cognitiveMode ? { cognitiveMode: context.cognitiveMode } : {}),
        timestamp: item.timestamp ?? new Date().toISOString(),
      };
      if (context.graphExecution) {
        context.graphExecution.dispatch({
          kind: 'environment_text_stream',
          payload,
        });
      } else {
        queueEnvironmentBridgeText(payload);
      }
    }

    return {
      sent: true,
      text: combinedText,
      targetSessionId,
      status: 'queued',
    };
  },
});
