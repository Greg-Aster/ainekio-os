#!/usr/bin/env npx tsx
import { initGlobalLogger } from '@metahuman/core';
import { runCycle } from './core.js';

async function main() {
  initGlobalLogger('system-code-review');
  const payload = JSON.parse(process.env.MH_TASK_PAYLOAD || '{}');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await runCycle({ username: process.env.MH_TRIGGER_USERNAME, signal: controller.signal,
      taskBrief: payload.graphContext?.taskBrief });
    console.log(JSON.stringify(result));
    if (!result.success) process.exitCode = 1;
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
void main().catch(error => { console.error(`[system-code-review] Failed: ${error.message}`); process.exitCode = 1; });
