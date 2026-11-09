import fs from 'node:fs';
import path from 'node:path';
import { systemPaths } from './path-builder.js';
import type { AgentFailureEntry } from './agent-monitor-types.js';

const LOG_PREFIX = '[agent-monitor-registry]';

export interface AgentRegistry {
  [agentName: string]: {
    pid: number;
    startTime: string;
  };
}

interface AgentFailureRegistry {
  [agentName: string]: AgentFailureEntry;
}

const getRegistryPath = () => path.join(systemPaths.logs, 'agents', 'running.json');
const getFailureRegistryPath = () => path.join(systemPaths.logs, 'agents', 'failures.json');

export function readRegistry(): AgentRegistry {
  const registryPath = getRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read agent registry:`, (error as Error).message);
    return {};
  }
}

export function writeRegistry(registry: AgentRegistry): void {
  const registryPath = getRegistryPath();
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function readFailureRegistry(): AgentFailureRegistry {
  const registryPath = getFailureRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as AgentFailureRegistry;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read agent failure registry:`, (error as Error).message);
    return {};
  }
}

function writeFailureRegistry(registry: AgentFailureRegistry): void {
  const registryPath = getFailureRegistryPath();
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

export function recordAgentFailure(entry: Omit<AgentFailureEntry, 'timestamp'> & { timestamp?: string }): void {
  const registry = readFailureRegistry();
  registry[entry.agent] = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  writeFailureRegistry(registry);
}

export function clearAgentFailure(agentName: string): void {
  const registry = readFailureRegistry();
  if (!registry[agentName]) return;
  delete registry[agentName];
  writeFailureRegistry(registry);
}

export function getAgentFailures(): AgentFailureEntry[] {
  return Object.values(readFailureRegistry())
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export function registerAgent(name: string, pid: number): void {
  const registry = readRegistry();
  registry[name] = {
    pid,
    startTime: new Date().toISOString(),
  };
  writeRegistry(registry);
  clearAgentFailure(name);
}

export function unregisterAgent(name: string, expectedPid?: number): void {
  const registry = readRegistry();
  if (expectedPid !== undefined && registry[name]?.pid !== expectedPid) {
    return;
  }
  delete registry[name];
  writeRegistry(registry);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isAgentRunning(name: string): boolean {
  const registry = readRegistry();
  const info = registry[name];
  if (!info) return false;
  return isProcessRunning(info.pid);
}

export function getRunningAgents(): Array<{ name: string; pid: number; startTime: string }> {
  const registry = readRegistry();
  const running: Array<{ name: string; pid: number; startTime: string }> = [];

  for (const [name, info] of Object.entries(registry)) {
    if (isProcessRunning(info.pid)) {
      running.push({
        name,
        pid: info.pid,
        startTime: info.startTime,
      });
    }
  }

  return running;
}

function signalAgent(name: string, force = false): { success: boolean; message: string; pid?: number } {
  const registry = readRegistry();
  const info = registry[name];

  if (!info) {
    return { success: false, message: `Agent '${name}' is not in the registry` };
  }

  if (!isProcessRunning(info.pid)) {
    unregisterAgent(name);
    return { success: false, message: `Agent '${name}' is not running (cleaned up stale entry)` };
  }

  try {
    process.kill(info.pid, force ? 'SIGKILL' : 'SIGTERM');
    return {
      success: true,
      message: `Sent ${force ? 'SIGKILL' : 'SIGTERM'} to ${name}`,
      pid: info.pid,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to stop ${name}: ${(error as Error).message}`,
      pid: info.pid,
    };
  }
}

export async function stopAllAgents(force = false): Promise<{
  stopped: string[];
  failed: string[];
  total: number;
}> {
  const running = getRunningAgents();
  const stopped: string[] = [];
  const failed: string[] = [];

  await Promise.all(running.map(async agent => {
    const result = await stopAgent(agent.name, force);
    if (result.success) {
      stopped.push(agent.name);
    } else {
      failed.push(agent.name);
    }
  }));

  return {
    stopped,
    failed,
    total: running.length,
  };
}

/** A stop receipt reports termination of the recorded child, not just a sent signal. */
export async function stopAgent(name: string, force = false): Promise<ReturnType<typeof signalAgent>> {
  const result = signalAgent(name, force);
  if (!result.success || !result.pid) return result;
  const pid = result.pid;
  if (await waitForProcessExit(pid, 5000)) {
    unregisterAgent(name, pid);
    return { success: true, pid, message: `Agent '${name}' stopped` };
  }
  return { success: false, pid, message: `Agent '${name}' has not stopped` };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !isProcessRunning(pid);
}
