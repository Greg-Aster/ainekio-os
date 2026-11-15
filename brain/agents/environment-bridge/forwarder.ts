import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ROOT } from '@metahuman/core/paths';

const MAX_FORWARDER_STDERR_BYTES = 4096;

export interface RemoteForwarder {
  signal: AbortSignal;
  failure: () => Error | undefined;
  detail: () => string | undefined;
  clearDetail: () => void;
  stop: () => Promise<void>;
}

/** The bridge reconnect owner retains a live tunnel across WebSocket attempts. */
export function startRemoteForwarder(
  adapterUrl: string,
  signal: AbortSignal,
): RemoteForwarder {
  const controller = new AbortController();
  const services = JSON.parse(fs.readFileSync(path.join(ROOT, 'etc/services.json'), 'utf8'));
  const service = services.services?.['environment-bridge'] ?? {};
  const endpoint = new URL(adapterUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || !endpoint.port) {
    throw new Error('Remote Adapter URL must use ws://127.0.0.1:PORT/environment for remote forwarding');
  }
  const transport = service.transport ?? 'cloudflare';
  let command: string;
  let args: string[];
  let credentials: ReturnType<typeof parseEnv> = {};
  if (transport === 'ssh') {
    const target = String(service.sshTarget ?? '').trim();
    if (!target) throw new Error('Configure the Environment Bridge SSH destination (user@host or SSH host alias)');
    command = 'ssh';
    args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${endpoint.port}:127.0.0.1:${service.sshGatewayPort ?? 8790}`, '--', target];
  } else if (transport === 'cloudflare') {
    const hostname = String(service.cloudflareHostname ?? '').trim();
    if (!hostname) throw new Error('Configure the Environment Bridge Cloudflare hostname');
    const accessEnvFile = String(service.accessEnvFile ?? '').trim();
    credentials = accessEnvFile ? parseEnv(fs.readFileSync(accessEnvFile, 'utf8')) : {};
    command = path.join(ROOT, 'bin/connect-environment');
    args = [hostname, endpoint.port];
  } else {
    throw new Error(`Unknown remote bridge transport: ${transport}`);
  }
  const child = spawn(command, args, {
    env: { ...process.env, ...credentials },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (stderrTail.length > MAX_FORWARDER_STDERR_BYTES) {
      stderrTail = stderrTail.slice(-MAX_FORWARDER_STDERR_BYTES);
    }
  });
  const detail = () => stderrTail
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);
  let forwarderError: Error | undefined;
  const exited = new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('error', error => { forwarderError = error; controller.abort(); finish(); });
    child.once('close', (code, exitSignal) => {
      if (!controller.signal.aborted) {
        const reason = detail();
        forwarderError = new Error(reason
          ? `${transport} forwarder exited (${exitSignal ?? code}): ${reason}`
          : `${transport} forwarder exited (${exitSignal ?? code})`);
        controller.abort();
      }
      finish();
    });
  });
  const stop = () => child.kill('SIGTERM');
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) controller.abort();
  return {
    signal: controller.signal,
    failure: () => forwarderError,
    detail,
    clearDetail: () => { stderrTail = ''; },
    async stop() {
      signal.removeEventListener('abort', abort);
      controller.abort();
      stop();
      await exited;
      controller.signal.removeEventListener('abort', stop);
    },
  };
}
