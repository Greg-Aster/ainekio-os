/**
 * Ollama LoRA packaging support.
 *
 * Ollama does not hot-attach PEFT adapters to an already selected model. It
 * packages a compatible adapter and base model into a normal derived Ollama
 * model. Once created, that model is discovered by the shared artifact registry
 * and uses the same backend/provider path as every other Ollama model.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { audit } from './audit.js'

const execFileAsync = promisify(execFile)

export interface OllamaLoraAdapter extends SourceLoraAdapter {
  compatibleWithTarget: boolean
  supportedByOllama: boolean
  unavailableReason?: string
}

export interface CreateOllamaLoraModelInput {
  profileOutPath: string
  adapterName: string
  baseModel: string
  modelName?: string
  endpoint?: string
  actor?: string
  parameters?: {
    numCtx?: number
    numPredict?: number
    temperature?: number
    topP?: number
    topK?: number
    minP?: number
    repeatPenalty?: number
    seed?: number | null
  }
}

const OLLAMA_SAFETENSORS_ADAPTER_FAMILIES = ['llama', 'mistral', 'gemma']

export function isOllamaSafetensorsAdapterFamilySupported(baseModel: string | undefined): boolean {
  if (!baseModel) return false
  const normalized = baseModel.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  return OLLAMA_SAFETENSORS_ADAPTER_FAMILIES.some(family =>
    normalized.split(' ').some(part => part === family || part.startsWith(family))
  )
}

export function sanitizeOllamaModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 120)
}

export function buildOllamaLoraModelName(baseModel: string, adapterName: string): string {
  const base = sanitizeOllamaModelName(baseModel.replace(/:[^/]+$/, '')) || 'model'
  const adapter = sanitizeOllamaModelName(adapterName) || 'adapter'
  return `${base}-${adapter}:latest`
}

export function buildOllamaLoraModelfile(
  baseModel: string,
  adapterPath: string,
  parameters: CreateOllamaLoraModelInput['parameters'] = {},
): string {
  const lines = [
    `FROM ${baseModel}`,
    `ADAPTER ${JSON.stringify(adapterPath)}`,
  ]
  const values: Array<[string, number | null | undefined]> = [
    ['num_ctx', parameters.numCtx],
    ['num_predict', parameters.numPredict],
    ['temperature', parameters.temperature],
    ['top_p', parameters.topP],
    ['top_k', parameters.topK],
    ['min_p', parameters.minP],
    ['repeat_penalty', parameters.repeatPenalty],
    ['seed', parameters.seed],
  ]
  for (const [name, value] of values) {
    if (value !== undefined && value !== null) lines.push(`PARAMETER ${name} ${value}`)
  }
  return `${lines.join('\n')}\n`
}

export async function discoverOllamaLoraAdapters(
  profileOutPath: string,
  targetModel: string,
): Promise<OllamaLoraAdapter[]> {
  const adapters = await discoverSourceLoraAdapters(profileOutPath)
  return adapters.map(adapter => {
    const compatibleWithTarget = isSourceLoraCompatibleWithModel(adapter.baseModel, targetModel)
    const supportedByOllama = isOllamaSafetensorsAdapterFamilySupported(adapter.baseModel)
    let unavailableReason: string | undefined
    if (!adapter.valid) {
      unavailableReason = 'The adapter files are incomplete.'
    } else if (!compatibleWithTarget) {
      unavailableReason = `This adapter was trained for ${adapter.baseModel || 'an unknown base model'}, not ${targetModel}.`
    } else if (!supportedByOllama) {
      unavailableReason = 'This safetensors adapter family is not supported by Ollama adapter import. Select an already merged Ollama model.'
    }
    return {
      ...adapter,
      compatibleWithTarget,
      supportedByOllama,
      unavailableReason,
    }
  })
}

export async function createOllamaLoraModel(input: CreateOllamaLoraModelInput): Promise<{
  modelName: string
  adapterName: string
  baseModel: string
}> {
  if (!input.baseModel.trim()) throw new Error('A base Ollama model is required')
  const adapters = await discoverOllamaLoraAdapters(input.profileOutPath, input.baseModel)
  const adapter = adapters.find(candidate => candidate.name === input.adapterName)
  if (!adapter) throw new Error(`LoRA adapter not found: ${input.adapterName}`)
  if (fs.existsSync(path.join(path.dirname(adapter.path), 'run.json'))) throw new Error('Review this personalization candidate in Training History; it must use its verified GGUF and activation gate')
  if (adapter.unavailableReason) throw new Error(adapter.unavailableReason)

  const requestedName = input.modelName?.trim()
    ? sanitizeOllamaModelName(input.modelName)
    : buildOllamaLoraModelName(input.baseModel, adapter.name)
  if (!requestedName) throw new Error('The derived Ollama model name is invalid')

  await createFromModelfile(requestedName, buildOllamaLoraModelfile(input.baseModel, adapter.path, input.parameters), input.endpoint)

  audit({
    level: 'info',
    category: 'action',
    event: 'ollama_lora_model_created',
    actor: input.actor || 'system',
    details: {
      modelName: requestedName,
      baseModel: input.baseModel,
      adapterName: adapter.name,
    },
  })

  return {
    modelName: requestedName,
    adapterName: adapter.name,
    baseModel: input.baseModel,
  }
}
/** One packaging command for both compatible adapters and merged GGUF candidates. */
async function createFromModelfile(modelName: string, modelfile: string, endpoint?: string): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-ollama-import-'))
  try {
    const file = path.join(tempDir, 'Modelfile')
    fs.writeFileSync(file, modelfile, { mode: 0o600 })
    await execFileAsync('ollama', ['create', modelName, '-f', file], {
      env: { ...process.env, ...(endpoint ? { OLLAMA_HOST: endpoint } : {}) },
      timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024,
    })
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new Error('Ollama import failed: ' + (failure.stderr?.trim() || failure.message))
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
}

export async function createOllamaGgufModel(modelName: string, ggufPath: string, endpoint: string): Promise<void> {
  if (sanitizeOllamaModelName(modelName) !== modelName) throw new Error('Invalid candidate model name')
  if (!fs.statSync(ggufPath).isFile()) throw new Error('GGUF candidate is missing')
  await createFromModelfile(modelName, 'FROM ' + JSON.stringify(path.resolve(ggufPath)) + '\n', endpoint)
}

interface SourceLoraAdapter {
  /** Unique identifier (e.g., "greggles-2025-12-04") */
  name: string;
  /** Absolute path to adapter directory containing safetensors */
  path: string;
  /** Date from directory name (YYYY-MM-DD) */
  createdAt: string;
  /** Has required files (adapter_model.safetensors + adapter_config.json) */
  valid: boolean;
  /** Base model from adapter_config.json */
  baseModel?: string;
  /** LoRA rank from adapter_config.json */
  loraRank?: number;
  /** File size of adapter_model.safetensors in bytes */
  sizeBytes?: number;
}

function normalizedModelReference(reference: string): string {
  return reference
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
}

function getSourceLoraModelCompatibilityKey(reference: string): string {
  const normalized = normalizedModelReference(reference);
  const sizedModel = normalized.match(/^(.*?)[_-](\d+(?:\.\d+)?b)(?:[_-].*)?$/i);
  if (!sizedModel) return normalized;
  return `${sizedModel[1]}:${sizedModel[2]}`;
}

function isSourceLoraCompatibleWithModel(
  adapterBaseModel: string | undefined,
  targetModel: string | undefined,
): boolean {
  if (!adapterBaseModel || !targetModel) return false;
  return getSourceLoraModelCompatibilityKey(adapterBaseModel)
    === getSourceLoraModelCompatibilityKey(targetModel);
}

async function discoverSourceLoraAdapters(
  profileOutPath: string
): Promise<SourceLoraAdapter[]> {
  const adaptersDir = path.join(profileOutPath, 'adapters');

  if (!fs.existsSync(adaptersDir)) {
    return [];
  }

  const adapters: SourceLoraAdapter[] = [];

  try {
    // List date directories (e.g., 2025-12-04)
    const dateDirs = fs.readdirSync(adaptersDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map(d => d.name);

    for (const dateDir of dateDirs) {
      const datePath = path.join(adaptersDir, dateDir);

      // List timestamp directories within date (e.g., 2025-12-04-004433-5a4ffd)
      const timestampDirs = fs.readdirSync(datePath, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const timestampDir of timestampDirs) {
        const adapterBasePath = path.join(datePath, timestampDir.name);
        const adapterPath = path.join(adapterBasePath, 'adapter');

        // Check if this has safetensors format (Ollama compatible)
        const validation = await validateSourceLoraAdapter(adapterPath);

        if (validation.hasSafetensors) {
          // Generate a unique name from the date/timestamp
          const name = timestampDir.name;

          adapters.push({
            name,
            path: adapterPath,
            createdAt: dateDir,
            valid: validation.valid,
            baseModel: validation.baseModel,
            loraRank: validation.loraRank,
            sizeBytes: validation.sizeBytes,
          });
        }
      }
    }
  } catch (error) {
    console.error('[ollama-lora] Error discovering adapters:', error);
  }

  // Sort by date (newest first) and deduplicate by name
  const seen = new Set<string>();
  return adapters
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });
}

async function validateSourceLoraAdapter(adapterPath: string): Promise<{
  valid: boolean;
  hasSafetensors: boolean;
  hasConfig: boolean;
  baseModel?: string;
  loraRank?: number;
  sizeBytes?: number;
  error?: string;
}> {
  const safetensorsPath = path.join(adapterPath, 'adapter_model.safetensors');
  const configPath = path.join(adapterPath, 'adapter_config.json');

  const hasSafetensors = fs.existsSync(safetensorsPath);
  const hasConfig = fs.existsSync(configPath);

  if (!hasSafetensors) {
    return { valid: false, hasSafetensors: false, hasConfig };
  }

  let baseModel: string | undefined;
  let loraRank: number | undefined;
  let sizeBytes: number | undefined;

  // Get file size
  try {
    const stats = fs.statSync(safetensorsPath);
    sizeBytes = stats.size;
  } catch { /* ignore */ }

  // Parse adapter config
  if (hasConfig) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      baseModel = config.base_model_name_or_path;
      loraRank = config.r;
    } catch (error) {
      console.warn('[ollama-lora] Failed to parse adapter_config.json:', error);
    }
  }

  return {
    valid: hasSafetensors && hasConfig,
    hasSafetensors,
    hasConfig,
    baseModel,
    loraRank,
    sizeBytes,
  };
}
