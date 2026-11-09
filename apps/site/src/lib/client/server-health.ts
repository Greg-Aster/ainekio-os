/**
 * Server Health Monitor
 *
 * Mobile checks its local Node.js server; local web checks the same origin.
 * The hosted UI monitors the selected backend using the same transport owner.
 * Profile sync destinations remain independent.
 */

import { writable, type Writable } from 'svelte/store';
import { apiUrl, getApiBaseUrl, isHostedUi, isReactNativeWebView } from './api-config';

export interface HealthStatus {
  connected: boolean;
  latencyMs: number;
  quality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
  lastCheck: Date;
  consecutiveFailures: number;
  serverVersion?: string;
  error?: string;
}

// Quality thresholds (in milliseconds)
const QUALITY_THRESHOLDS = {
  excellent: 100,   // < 100ms
  good: 250,        // < 250ms
  fair: 500,        // < 500ms
};

const CHECK_INTERVAL_MS = 30000;

// Current health status store
const healthStatus: Writable<HealthStatus> = writable({
  connected: false,
  latencyMs: 0,
  quality: 'offline',
  lastCheck: new Date(),
  consecutiveFailures: 0,
});

// Health check interval reference
let checkInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Calculate quality rating based on latency
 */
function calculateQuality(latencyMs: number, connected: boolean): HealthStatus['quality'] {
  if (!connected) return 'offline';
  if (latencyMs < QUALITY_THRESHOLDS.excellent) return 'excellent';
  if (latencyMs < QUALITY_THRESHOLDS.good) return 'good';
  if (latencyMs < QUALITY_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

/**
 * Perform a single health check
 *
 * Check the current API server without reporting an unauthenticated health
 * response as a session failure.
 */
export async function checkHealth(): Promise<HealthStatus> {
  let status: HealthStatus;
  const start = Date.now();

  // Determine health check URL based on platform
  // Check the existing session endpoint; the full status report probes backends and memory.
  const healthUrl = isReactNativeWebView()
    ? 'http://127.0.0.1:4322/api/auth/me'
    : apiUrl('/api/auth/me');

  // Check server health
  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      credentials: getApiBaseUrl() ? 'include' : 'same-origin',
      signal: AbortSignal.timeout(5000),
    });

    const latencyMs = Date.now() - start;

    // 401/403 means server is reachable, just needs auth
    if (response.ok || response.status === 401 || response.status === 403) {
      let version: string | undefined;
      if (response.ok) {
        try {
          const data = await response.json();
          version = data.version;
        } catch { /* ignore */ }
      }

      status = {
        connected: true,
        latencyMs,
        quality: calculateQuality(latencyMs, true),
        lastCheck: new Date(),
        consecutiveFailures: 0,
        serverVersion: version,
      };
    } else {
      let currentFailures = 0;
      healthStatus.subscribe(s => { currentFailures = s.consecutiveFailures; })();

      status = {
        connected: false,
        latencyMs,
        quality: 'offline',
        lastCheck: new Date(),
        consecutiveFailures: currentFailures + 1,
        error: `Server returned ${response.status}`,
      };
    }
  } catch (err) {
    let currentFailures = 0;
    healthStatus.subscribe(s => { currentFailures = s.consecutiveFailures; })();

    status = {
      connected: false,
      latencyMs: Date.now() - start,
      quality: 'offline',
      lastCheck: new Date(),
      consecutiveFailures: currentFailures + 1,
      error: err instanceof Error ? err.message : 'Health check failed',
    };
  }

  healthStatus.set(status);
  return status;
}

/**
 * Start periodic health monitoring
 */
function startHealthMonitor(): void {
  if (isHostedUi() && !getApiBaseUrl()) return;
  // Stop existing monitor if running
  stopHealthMonitor();

  // Perform initial check
  checkHealth();

  // Start periodic checks
  checkInterval = setInterval(() => {
    checkHealth();
  }, CHECK_INTERVAL_MS);

  console.log('[server-health] Monitor started with interval:', CHECK_INTERVAL_MS, 'ms');
}

/**
 * Stop health monitoring
 */
function stopHealthMonitor(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('[server-health] Monitor stopped');
  }
}

/**
 * Force an immediate health check
 */
export async function forceHealthCheck(): Promise<HealthStatus> {
  return checkHealth();
}

// Export stores
export { healthStatus };

// Auto-start monitor when in browser context
if (typeof window !== 'undefined') {
  // Start after a short delay to allow initial app load
  setTimeout(() => {
    startHealthMonitor();
  }, 1000);

  // Handle visibility changes - pause when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopHealthMonitor();
    } else {
      startHealthMonitor();
    }
  });
}
