/**
 * Owns the local model service process for shell launchers and API consumers.
 * The existing PID file survives launcher and web-process restarts.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { systemPaths } from './path-builder.js';
import { acquireLock } from './locks.js';
import { isLocalModelServiceRunning } from './providers/local-models.js';
import { loadBackendConfig } from './llm-backend.js';

const DEFAULT_PORT = 4324;
const DEFAULT_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 1000;
const PID_FILE = path.join(systemPaths.run, 'local-models.pid');
let startGeneration = 0;

export interface LocalModelServiceOptions {
  port?: number;
  host?: string;
  modelsDir?: string;
  configPath?: string;
}

export function loadLocalModelsConfig() {
  const localModels = loadBackendConfig(true).localModels;
  const endpoint = localModels?.endpoint || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const port = Number(new URL(endpoint).port) || DEFAULT_PORT;
  return {
    enabled: localModels?.enabled ?? true,
    endpoint,
    port,
    autoStart: localModels?.autoStart ?? false,
    downloadOnWifiOnly: localModels?.downloadOnWifiOnly ?? true,
    embeddings: localModels?.embeddings ?? { model: 'qwen3-embedding-0.6b' },
    llm: localModels?.llm ?? { model: 'qwen3-1.7b' }
  };
}

function readPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Invalid local-model service PID: ${PID_FILE}`);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function releasePid(pid: number): void {
  if (readPid() === pid) fs.unlinkSync(PID_FILE);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A detached child can remain a zombie until its parent reaps it.
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) return false;
    throw error;
  }
}

function getServicePid(): number | null {
  const pid = readPid();
  if (pid !== null && !isProcessRunning(pid)) {
    releasePid(pid);
    return null;
  }
  return pid;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopProcess(pid: number): Promise<void> {
  signalProcess(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (isProcessRunning(pid) && Date.now() < deadline) await delay(25);
  if (isProcessRunning(pid)) {
    signalProcess(pid, 'SIGKILL');
    while (isProcessRunning(pid)) await delay(25);
  }
  releasePid(pid);
}

/** Start or reuse the same service, regardless of which entrypoint requested it. */
export async function startLocalModelService(options: LocalModelServiceOptions = {}): Promise<boolean> {
  const generation = startGeneration;
  const config = loadLocalModelsConfig();
  if (!config.enabled) {
    console.log('[local-model-manager] Service is disabled in config');
    return false;
  }
  const port = options.port ?? Number(process.env.LOCAL_MODELS_PORT || config.port);
  const host = options.host || DEFAULT_HOST;
  const endpoint = `http://${host}:${port}`;
  const running = await isLocalModelServiceRunning(endpoint);
  if (generation !== startGeneration) return false;
  if (running) return true;

  // Keep only the process creation/PID handoff atomic. Readiness does not hold
  // this lock, so stop can cancel a startup that has not become healthy.
  const lock = acquireLock('local-models', { exitOnSignal: false });
  let pid: number;
  let spawnError: Error | undefined;
  try {
    const existingPid = getServicePid();
    if (existingPid !== null) {
      pid = existingPid;
    } else {
      const servicePath = path.join(systemPaths.root, 'packages', 'local-model-service');
      const builtEntry = path.join(servicePath, 'dist', 'index.js');
      const sourceEntry = path.join(servicePath, 'src', 'index.ts');
      const built = fs.existsSync(builtEntry);
      if (!built && !fs.existsSync(sourceEntry)) {
        throw new Error('Local model service entrypoint is missing');
      }
      const modelsDir = path.resolve(systemPaths.root, options.modelsDir || process.env.MODELS_DIR || 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      const log = fs.openSync(path.join(systemPaths.run, 'local-models.log'), 'a');
      try {
        const child = spawn(process.execPath, built ? [builtEntry] : ['--import', 'tsx', sourceEntry], {
          cwd: servicePath,
          stdio: ['ignore', log, log],
          detached: true,
          env: {
            ...process.env,
            PORT: String(port),
            HOST: host,
            MODELS_DIR: modelsDir,
            CONFIG_PATH: options.configPath || path.join(systemPaths.etc, 'llm-backend.json')
          }
        });
        child.once('error', error => { spawnError = error; });
        if (!child.pid) throw new Error('Local model service process could not be created');
        pid = child.pid;
        try {
          fs.writeFileSync(PID_FILE, `${pid}\n`);
        } catch (error) {
          child.kill('SIGTERM');
          throw error;
        }
        child.unref();
      } finally {
        fs.closeSync(log);
      }
    }
  } finally {
    lock.release();
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (getServicePid() !== pid) return false;
    if (await isLocalModelServiceRunning(endpoint)) {
      return getServicePid() === pid;
    }
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }
  // A cancelled start must never stop a subsequent replacement.
  if (getServicePid() === pid) await stopProcess(pid);
  console.error('[local-model-manager] Service did not become healthy; see logs/run/local-models.log');
  return false;
}

/** Stop the recorded process, including one started before this caller existed. */
export async function stopLocalModelService(): Promise<void> {
  startGeneration++;
  const pid = getServicePid();
  if (pid !== null) {
    await stopProcess(pid);
  } else if (await isLocalModelServiceRunning(loadLocalModelsConfig().endpoint)) {
    throw new Error('Local model service is responding but has no managed PID; stop its owning launcher');
  }
}
