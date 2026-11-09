/**
 * GPU Status API Handlers
 *
 * Unified handlers for GPU status monitoring.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { execFileSync } from 'node:child_process';

interface GPUInfo {
  index: number;
  name: string;
  memory: {
    total: number;
    used: number;
    free: number;
    usedPercent: number;
    freePercent: number;
  };
  utilization: {
    gpu: number;
    memory: number;
  };
}

interface GPUProcess {
  pid: number;
  name: string;
  memory: number;
}

/**
 * GET /api/gpu-status - Get measured GPU status
 */
export async function handleGetGpuStatus(_req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    // Get GPU information
    const gpuQuery = execFileSync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8' });

    const lines = gpuQuery.trim().split('\n');
    const gpus: GPUInfo[] = lines.map(line => {
      const [index, name, total, used, free, gpuUtil, memUtil] = line
        .split(',')
        .map(s => s.trim());

      const totalNum = parseInt(total, 10);
      const usedNum = parseInt(used, 10);
      const freeNum = parseInt(free, 10);

      return {
        index: parseInt(index, 10),
        name,
        memory: {
          total: totalNum,
          used: usedNum,
          free: freeNum,
          usedPercent: Math.round((usedNum * 100) / totalNum),
          freePercent: Math.round((freeNum * 100) / totalNum),
        },
        utilization: {
          gpu: parseInt(gpuUtil, 10),
          memory: parseInt(memUtil, 10),
        },
      };
    });

    const processOutput = execFileSync('nvidia-smi', [
      '--query-compute-apps=pid,process_name,used_memory',
      '--format=csv,noheader',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const processes: GPUProcess[] = processOutput
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        const [pid, name, mem] = line.split(',').map(s => s.trim());
        return { pid: parseInt(pid, 10), name, memory: parseInt(mem, 10) };
      });

    return successResponse({
      available: true,
      gpus,
      processes,
    });
  } catch (error) {
    console.error('[gpu-status] GET error:', error);
    return {
      status: 500,
      error: String(error),
    };
  }
}
