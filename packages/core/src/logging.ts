import { audit } from './audit.js';

let actorName = '';
let initialized = false;

/** Attribute console warnings/errors once; routine console output remains on stdout. */
export function initGlobalLogger(actor: string): void {
  actorName = actor;
  if (initialized) return;
  initialized = true;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' ');
      audit({ level, category: 'action', event: message, actor: actorName });
    };
  }
}
