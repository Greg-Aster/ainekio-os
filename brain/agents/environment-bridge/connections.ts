import WebSocket from 'ws';
import { startRemoteForwarder } from './forwarder.js';
import { createCoalescedTaskRunner } from './async-control.js';

export interface BodyConnection {
  endpoint: string;
  sessionId?: string;
  gatewayInstance?: string;
  robotId?: string;
  connected: boolean;
  active: boolean;
  ready: boolean;
  error?: string;
}

export interface BridgeEndpoint { url: string; remote?: boolean }

function reconnect(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 2000);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Watch saved hosts; one action stream follows the selected physical robot. */
export async function runBodyConnection(options: {
  endpoints: BridgeEndpoint[];
  token: string;
  robotId?: string;
  connect: (url: string, signal: AbortSignal, ready: () => void) => Promise<void>;
  changed: (connections: BodyConnection[]) => Promise<void>;
}, signal: AbortSignal): Promise<void> {
  const states: BodyConnection[] = options.endpoints.map(endpoint => ({
    endpoint: endpoint.url, connected: false, active: false, ready: false,
  }));
  let followedRobot = options.robotId;
  let active: { identity: string; controller: AbortController; done: Promise<void> } | undefined;
  let selection = Promise.resolve();
  let publication = Promise.resolve();
  const report = createCoalescedTaskRunner(async () => {
    try { await options.changed(states.map(state => ({ ...state }))); }
    catch (error) { console.error(`[environment-bridge] availability reporting failed: ${(error as Error).message}`); }
  });
  const publish = () => { publication = report(); };
  const choose = () => {
    if (signal.aborted) return undefined;
    const available = states.filter(state => state.connected && state.robotId
      && (!followedRobot || state.robotId === followedRobot));
    return available.find(state => state.active) ?? available[0];
  };
  const reconcile = () => {
    // A changed body identity retires its previous action stream.
    selection = selection.then(async () => {
      const selected = choose();
      const identity = selected && `${selected.endpoint}\n${selected.gatewayInstance}\n${selected.robotId}`;
      if (active?.identity === identity) { publish(); return; }
      if (active) { active.controller.abort(); await active.done; active = undefined; }
      for (const state of states) { state.active = false; state.ready = false; }
      const next = choose();
      if (next) {
        // Automatic following keeps the same body even when another gateway
        // advertises a different robot. Single-host manual selection is unchanged.
        if (states.length > 1) followedRobot ??= next.robotId;
        next.active = true;
        const controller = new AbortController();
        const done = (async () => {
          while (!controller.signal.aborted) {
            try {
              await options.connect(next.endpoint, controller.signal, () => {
                if (controller.signal.aborted) return;
                next.ready = true;
                next.error = undefined;
                publish();
              });
            }
            catch (error) {
              if (!controller.signal.aborted) {
                next.error = (error as Error).message;
                console.error(`[environment-bridge] connection failed: ${next.error}`);
              }
            }
            next.ready = false;
            publish();
            if (!controller.signal.aborted) await reconnect(controller.signal);
          }
        })();
        active = { identity: `${next.endpoint}\n${next.gatewayInstance}\n${next.robotId}`, controller, done };
      }
      publish();
    });
  };
  const stop = () => { active?.controller.abort(); reconcile(); };
  signal.addEventListener('abort', stop, { once: true });
  publish();
  async function watch(endpoint: BridgeEndpoint, state: BodyConnection) {
    let forwarder: ReturnType<typeof startRemoteForwarder> | undefined;
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
                Object.assign(state, { sessionId: message.sessionId, gatewayInstance: message.gatewayInstance,
                  robotId: message.robotId || undefined, connected: message.connected === true });
                if (!state.active) state.error = undefined;
                reconcile();
              } catch (error) { reject(error); }
            });
            if (connectionSignal.aborted) close();
          });
          if (forwarder?.failure()) throw forwarder.failure();
        } catch (error) {
          if (!signal.aborted) state.error = (error as Error).message;
        } finally {
          connectionSignal.removeEventListener('abort', close);
          socket?.terminate();
          state.connected = false;
          state.ready = false;
          reconcile();
          if (forwarder?.signal.aborted) { await forwarder.stop(); forwarder = undefined; }
        }
        if (!signal.aborted) await reconnect(signal);
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
