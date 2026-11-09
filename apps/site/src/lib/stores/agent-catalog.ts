import { writable } from 'svelte/store';
import { apiEventSource, apiFetch } from '../client/api-config';

type AgentCatalogLifecycle = 'scheduled-work' | 'workflow' | 'service';
type AgentCatalogOwner = 'trigger-manager' | 'robot-operator' | 'agent-monitor' | 'workflow' | 'available';
type AgentCatalogHealth = 'ready' | 'available' | 'missing-source' | 'disabled';
type AgentCatalogRisk = 'standard' | 'privileged' | 'destructive';

export interface AgentCatalogItem {
  id: string;
  sourceAgentId: string;
  displayName: string;
  description: string;
  lifecycle: AgentCatalogLifecycle;
  owner: AgentCatalogOwner;
  health: AgentCatalogHealth;
  risk: AgentCatalogRisk;
  installed: boolean;
  sourceReady: boolean;
  sourcePath?: string;
  triggerRegistered: boolean;
  serviceRegistered: boolean;
  enabled: boolean;
  triggerType?: 'interval' | 'time-of-day' | 'event' | 'activity' | 'manual';
  handler: string;
  usesLLM: boolean;
  priority: 'low' | 'normal' | 'high';
  parentIds: string[];
  tags: string[];
  canRegister: boolean;
  canUnregister: boolean;
  canRun: boolean;
  statusReason: string;
}

export interface AgentCatalogSnapshot {
  generatedAt: string;
  revision: number;
  scope: 'system';
  counts: {
    total: number;
    installed: number;
    triggerRegistered: number;
    services: number;
    available: number;
    missingSource: number;
    workflowChildren: number;
  };
  agents: AgentCatalogItem[];
}

export const agentCatalogSnapshot = writable<AgentCatalogSnapshot | null>(null);
export const agentCatalogError = writable<string | null>(null);
export const agentCatalogConnection = writable<'idle' | 'loading' | 'ready' | 'reconnecting' | 'error'>('idle');

let users = 0;
let stream: EventSource | null = null;

export function useAgentCatalog(): () => void {
  users++;
  if (!stream) {
    agentCatalogConnection.set('loading');
    stream = apiEventSource('/api/monitor/stream');
    stream.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') throw new Error(data.error);
        if (data.type !== 'snapshot') return;
        if (!data.catalog) throw new Error('The monitor snapshot did not include the Agent Catalog');
        agentCatalogSnapshot.set(data.catalog);
        agentCatalogError.set(null);
        agentCatalogConnection.set('ready');
      } catch (error) {
        agentCatalogError.set(error instanceof Error ? error.message : String(error));
        agentCatalogConnection.set('error');
      }
    };
    stream.onerror = () => {
      agentCatalogConnection.set('reconnecting');
      agentCatalogError.set('Agent Catalog connection interrupted. Reconnecting…');
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      stream!.onmessage = null;
      stream!.onerror = null;
      stream!.close();
      stream = null;
      agentCatalogSnapshot.set(null);
      agentCatalogError.set(null);
      agentCatalogConnection.set('idle');
    }
  };
}

async function control(action: 'register' | 'unregister', agentId: string): Promise<AgentCatalogSnapshot> {
  const response = await apiFetch('/api/agent-catalog/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, agentId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false || !data.snapshot) {
    throw new Error(data.error || `Agent Catalog ${action} failed: ${response.status}`);
  }
  return data.snapshot;
}

export function registerCatalogAgent(agentId: string): Promise<AgentCatalogSnapshot> {
  return control('register', agentId);
}

export function unregisterCatalogAgent(agentId: string): Promise<AgentCatalogSnapshot> {
  return control('unregister', agentId);
}
