import WebSocket from 'ws';
import { startRemoteForwarder } from './forwarder.js';
import { createCoalescedTaskRunner } from './async-control.js';

export interface BodyConnection {
  endpoint: string;
  sessionId?: string;
  gatewayInstance?: string;
  robotId?: string;
  adapterConnected: boolean;
  /** Physical robot availability reported by Body Control. */
  connected: boolean;
  active: boolean;
  ready: boolean;
  error?: string;
}

export interface BridgeEndpoint { url: string; remote?: boolean }

const DEFAULT_RECONNECT_BASE_MS = 2000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

function backoffDelayMs(failures: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(exponent, 10)));
}

function reconnect(
  signal: AbortSignal,
  delayMs = DEFAULT_RECONNECT_BASE_MS,
  wakeRegistry?: Set<() => void>,
  onWake?: () => void,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      wakeRegistry?.delete(wake);
    };
    const finish = () => { cleanup(); resolve(); };
    const wake = () => { onWake?.(); finish(); };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
    wakeRegistry?.add(wake);
  });
}

/** One Body Control stream remains usable when its physical robot is absent. */
export async function runBodyConnection(options: {
  endpoints: BridgeEndpoint[];
  token: string;
  robotId?: string;
  connect: (url: string, signal: AbortSignal, ready: () => void) => Promise<void>;
  changed: (connections: BodyConnection[]) => Promise<void>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}, signal: AbortSignal): Promise<void> {
  const reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = Math.max(reconnectBaseMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS);
  const states: BodyConnection[] = options.endpoints.map(endpoint => ({
    endpoint: endpoint.url, adapterConnected: false, connected: false, active: false, ready: false,
  }));
  let followedRobot = options.robotId;
  let active: { identity: string; controller: AbortController; done: Promise<void> } | undefined;
  let selection = Promise.resolve();
  let publication = Promise.resolve();
  let lastAvailabilityError: string | undefined;
  let hasActiveRobot = false;
  const wakeWatchers = new Set<() => void>();
  const report = createCoalescedTaskRunner(async () => {
    try {
      await options.changed(states.map(state => ({ ...state })));
      lastAvailabilityError = undefined;
    } catch (error) {
      const message = (error as Error).message;
      if (message !== lastAvailabilityError) {
        lastAvailabilityError = message;
        console.error(`[environment-bridge] availability reporting failed: ${message}`);
      }
    }
  });
  const publish = () => { publication = report(); };
  const notifyRobotAvailability = () => {
    const nowHasActiveRobot = states.some(state => state.active && state.connected);
    const lostActiveRobot = hasActiveRobot && !nowHasActiveRobot;
    hasActiveRobot = nowHasActiveRobot;
    publish();
    if (lostActiveRobot) {
      for (const wake of [...wakeWatchers]) wake();
    }
  };
  const choose = () => {
    if (signal.aborted) return undefined;
    const available = states.filter(state => state.adapterConnected
      && (!state.connected || !followedRobot || state.robotId === followedRobot));
    const bodies = available.filter(state => state.connected && state.robotId);
    return bodies.find(state => state.active) ?? bodies[0]
      ?? available.find(state => state.active) ?? available[0];
  };
  const reconcile = () => {
    // Body Control owns robot changes within its stream. Host changes retire it.
    selection = selection.then(async () => {
      const selected = choose();
      if (states.length > 1 && selected?.connected) followedRobot ??= selected.robotId;
      const identity = selected && `${selected.endpoint}\n${selected.gatewayInstance}`;
      if (active?.identity === identity) { notifyRobotAvailability(); return; }
      if (active) { active.controller.abort(); await active.done; active = undefined; }
      for (const state of states) { state.active = false; state.ready = false; }
      const next = choose();
      if (next) {
        // Automatic following keeps the same body even when another gateway
        // advertises a different robot. Single-host manual selection is unchanged.
        if (states.length > 1 && next.connected) followedRobot ??= next.robotId;
        next.active = true;
        const controller = new AbortController();
        let lastConnectionError: string | undefined;
        const done = (async () => {
          while (!controller.signal.aborted) {
            try {
              await options.connect(next.endpoint, controller.signal, () => {
                if (controller.signal.aborted) return;
                lastConnectionError = undefined;
                next.ready = true;
                next.error = undefined;
                publish();
              });
            }
            catch (error) {
              if (!controller.signal.aborted) {
                next.error = (error as Error).message;
                if (next.error !== lastConnectionError) {
                  lastConnectionError = next.error;
                  console.error(`[environment-bridge] connection failed: ${next.error}`);
                }
              }
            }
            next.ready = false;
            publish();
            if (!controller.signal.aborted) await reconnect(controller.signal, reconnectBaseMs);
          }
        })();
        active = { identity: `${next.endpoint}\n${next.gatewayInstance}`, controller, done };
      }
      notifyRobotAvailability();
    });
  };
  const stop = () => { active?.controller.abort(); reconcile(); };
  signal.addEventListener('abort', stop, { once: true });
  publish();
  async function watch(endpoint: BridgeEndpoint, state: BodyConnection) {
    let forwarder: ReturnType<typeof startRemoteForwarder> | undefined;
    let consecutiveFailures = 0;
    try {
      while (!signal.aborted) {
        let socket: WebSocket | undefined;
        let connectionSignal = signal;
        const close = () => socket?.terminate();
        try {
          if (endpoint.remote) {
            forwarder ??= startRemoteForwarder(endpoint.url, signal);
            connectionSignal = forwarder.signal;
            if (forwarder.failure()) throw forwarder.failure();
            forwarder.clearDetail();
          }
          await new Promise<void>((resolve, reject) => {
            socket = new WebSocket(endpoint.url, { maxPayload: 0, perMessageDeflate: false });
            connectionSignal.addEventListener('abort', close, { once: true });
            socket.on('error', reject);
            socket.once('close', (code, reason) => {
              if (!connectionSignal.aborted) reject(new Error(`Body Control connection closed (${code}): ${reason.toString()}`));
              else resolve();
            });
            socket.once('open', () => socket!.send(JSON.stringify({ type: 'bridge.watch', version: 1, token: options.token })));
            socket.on('message', raw => {
              try {
                const message = JSON.parse(raw.toString());
                if (message.type !== 'bridge.availability' || message.version !== 1) throw new Error('Expected bridge.availability version 1');
                consecutiveFailures = 0;
                forwarder?.clearDetail();
                Object.assign(state, { sessionId: message.sessionId, gatewayInstance: message.gatewayInstance,
                  robotId: message.robotId || undefined, adapterConnected: true, connected: message.connected === true });
                if (!state.active) state.error = undefined;
                reconcile();
              } catch (error) { reject(error); }
            });
            if (connectionSignal.aborted) close();
          });
          if (forwarder?.failure()) throw forwarder.failure();
        } catch (error) {
          consecutiveFailures += 1;
          if (!signal.aborted) {
            let message = (error as Error).message;
            if (forwarder && !forwarder.signal.aborted) {
              const detail = forwarder.detail();
              if (detail && !message.includes(detail)) message = `${message} (${detail})`;
            }
            state.error = message;
          }
        } finally {
          connectionSignal.removeEventListener('abort', close);
          socket?.terminate();
          state.adapterConnected = false;
          state.connected = false;
          state.ready = false;
          reconcile();
          if (forwarder?.signal.aborted) { await forwarder.stop(); forwarder = undefined; }
        }
        if (!signal.aborted) {
          const watchedForwarder = forwarder;
          const onForwarderAbort = () => {
            const failure = watchedForwarder?.failure();
            if (failure && !signal.aborted && state.error !== failure.message) {
              state.error = failure.message;
              publish();
            }
          };
          watchedForwarder?.signal.addEventListener('abort', onForwarderAbort, { once: true });
          try {
            const delayMs = backoffDelayMs(Math.max(1, consecutiveFailures), reconnectBaseMs, reconnectMaxMs);
            await reconnect(signal, delayMs, wakeWatchers, () => { consecutiveFailures = 0; });
          } finally {
            watchedForwarder?.signal.removeEventListener('abort', onForwarderAbort);
          }
          if (forwarder?.signal.aborted) { await forwarder.stop(); forwarder = undefined; }
        }
      }
    } finally { await forwarder?.stop(); }
  }
  try {
    await Promise.all(options.endpoints.map((endpoint, index) => watch(endpoint, states[index])));
  } finally {
    signal.removeEventListener('abort', stop);
    active?.controller.abort();
    reconcile();
    await selection;
    await publication;
  }
}
