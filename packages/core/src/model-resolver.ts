/**
 * Model Resolver
 *
 * Resolves model roles to concrete model configurations from the registry.
 * Enables configuration-driven model selection and hot-swapping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProfilePaths } from './path-builder.js';
import { safeWriteJSON } from './safe-file.js';
import { getUserContext } from './context.js';
import { loadFreshOperatorConfig } from './config.js';
import { MODEL_ROLES, type ModelRole } from './model-roles.js';
export { MODEL_ROLES, isModelRole, normalizeModelRole, type ModelRole } from './model-roles.js';
import {
  DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL,
  DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID,
  LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID,
  LEGACY_ENVIRONMENT_ROUTER_ROLE,
} from './model-defaults.js';

const LOG_PREFIX = '[model-resolver]';

export type ModelProvider = 'big-brother' | 'llama-cpp' | 'ollama' | 'openai' | 'openrouter' | 'claude' | 'gemini' | 'local' | 'runpod_serverless' | 'huggingface' | 'remote-server';
export type ModelCapability = 'text' | 'image';

export interface ModelDefinition {
  provider: ModelProvider;
  model: string;
  adapters: string[];
  baseModel?: string;
  roles: string[];
  /** Input modalities supported by this model, from config or provider discovery. */
  capabilities?: ModelCapability[];
  description: string;
  options: {
    contextWindow?: number;
    temperature?: number;
    topP?: number;
    repeatPenalty?: number;
    // Additional model-specific options - intentionally flexible
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  metadata?: {
    priority?: 'high' | 'medium' | 'low';
    alwaysLoaded?: boolean;
    estimatedLatency?: 'fast' | 'medium' | 'slow';
    adapterLoadTime?: number;
    trainedOn?: string;
    // Additional metadata fields - intentionally flexible for different model types
    [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

export interface ModelRegistry {
  version: string;
  description: string;
  globalSettings?: {
    includePersonaSummary?: boolean;
  };
  defaults: Partial<Record<ModelRole, string>>;
  models: Record<string, ModelDefinition>;
  roleHierarchy?: Partial<Record<ModelRole, string[]>>;
  cognitiveModeMappings?: Record<string, Record<string, string | null | undefined>>;
  providers?: Partial<Record<ModelProvider, {
    baseUrl: string;
    timeout: number;
    retries: number;
  }>>;
}

/** The selectable CLI deployment follows Backend Settings; roles own its use. */
export const BIG_BROTHER_MODEL_ID = 'big-brother.configured';
export const BIG_BROTHER_CODEX_MODEL_ID = 'big-brother.codex';
export const BIG_BROTHER_GEMINI_MODEL_ID = 'big-brother.gemini';
export const BIG_BROTHER_MODEL_IDS = [
  BIG_BROTHER_MODEL_ID,
  BIG_BROTHER_CODEX_MODEL_ID,
  BIG_BROTHER_GEMINI_MODEL_ID,
] as const;

export function isBigBrotherModelId(modelId: string): boolean {
  return (BIG_BROTHER_MODEL_IDS as readonly string[]).includes(modelId);
}

export function configuredBigBrotherModel(username?: string): ModelDefinition {
  const owner = username ?? getUserContext()?.username;
  const config = owner ? loadFreshOperatorConfig(owner).bigBrotherMode : undefined;
  const provider = config?.provider || 'claude-code';
  return {
    provider: 'big-brother', model: config?.model || provider, adapters: [], roles: [],
    capabilities: (provider === 'codex' || provider === 'gemini') ? ['text', 'image'] : ['text'],
    description: `Big Brother (${provider})`, options: {}, metadata: { cliProvider: provider },
  };
}

export function bigBrotherModelDefinition(modelId: string, username?: string): ModelDefinition {
  const owner = username ?? getUserContext()?.username;
  const config = owner ? loadFreshOperatorConfig(owner).bigBrotherMode : undefined;
  if (modelId === BIG_BROTHER_CODEX_MODEL_ID) {
    const model = (config?.provider === 'codex' && config?.model) ? config.model : 'gpt-6.1-sol';
    const configuredEffort = config?.provider === 'codex' ? config?.reasoningEffort : undefined;
    const reasoningEffort = (configuredEffort && !(model === 'gpt-6.1-sol' && configuredEffort === 'none'))
      ? configuredEffort
      : 'low';
    return {
      provider: 'big-brother',
      model,
      baseModel: 'BB-Codex',
      adapters: [],
      roles: [],
      capabilities: ['text', 'image'],
      description: `BB-Codex (${model}, fast, reasoning ${reasoningEffort})`,
      options: {},
      metadata: { cliProvider: 'codex', reasoningEffort, preset: 'bb-codex' },
    };
  }
  if (modelId === BIG_BROTHER_GEMINI_MODEL_ID) {
    const model = (config?.provider === 'gemini' && config?.model) ? config.model : 'gemini-3.8-flash-low';
    const reasoningEffort = (config?.provider === 'gemini' && config?.reasoningEffort) ? config.reasoningEffort : 'low';
    return {
      provider: 'big-brother',
      model,
      baseModel: 'BB-Gemini',
      adapters: [],
      roles: [],
      capabilities: ['text', 'image'],
      description: `BB-Gemini (${model}, effort ${reasoningEffort})`,
      options: {},
      metadata: { cliProvider: 'gemini', reasoningEffort, preset: 'bb-gemini' },
    };
  }
  return configuredBigBrotherModel(username);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseModelRegistry(value: unknown): ModelRegistry {
  if (!isRecord(value)) throw new Error('Invalid model registry: expected an object');
  if (typeof value.version !== 'string' || !value.version) {
    throw new Error('Invalid model registry: version must be a non-empty string');
  }
  if (typeof value.description !== 'string') {
    throw new Error('Invalid model registry: description must be a string');
  }
  if (!isRecord(value.defaults) || !isRecord(value.models)) {
    throw new Error('Invalid model registry: missing required fields (defaults, models)');
  }
  return value as unknown as ModelRegistry;
}

export interface ResolvedModel {
  id: string;
  provider: ModelProvider;
  model: string;
  adapters: string[];
  baseModel?: string;
  roles: string[];
  capabilities: ModelCapability[];
  options: Record<string, unknown>; // Model options - intentionally flexible
  metadata: Record<string, unknown>; // Model metadata - intentionally flexible
}

const registryCache = new Map<string, { registry: ModelRegistry; revision: string }>();

function registryRevision(registryPath: string): string {
  const stat = fs.statSync(registryPath, { bigint: true });
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export interface ModelRegistryMigrationResult {
  registry: ModelRegistry;
  changed: boolean;
}

/**
 * Migrate the retired advisory Environment Router role to the one full-output
 * action-selector role. The text-only 0.8B selector is also retired from this
 * role because direct Environment observations require image input.
 */
export function migrateModelRegistry(
  input: ModelRegistry,
): ModelRegistryMigrationResult {
  const registry = structuredClone(input);
  const before = JSON.stringify(registry);
  const defaults = registry.defaults as Record<string, string>;
  delete defaults[LEGACY_ENVIRONMENT_ROUTER_ROLE];
  if (
    !defaults.environmentActionSelector
    || defaults.environmentActionSelector === LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID
  ) defaults.environmentActionSelector = DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID;

  const mappings = registry.cognitiveModeMappings ?? {};
  for (const mapping of Object.values(mappings)) {
    delete mapping[LEGACY_ENVIRONMENT_ROUTER_ROLE];
  }
  mappings.environment ??= {};
  if (
    !mappings.environment.environmentActionSelector
    || mappings.environment.environmentActionSelector === LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID
  ) mappings.environment.environmentActionSelector = DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID;
  registry.cognitiveModeMappings = mappings;

  const hierarchy = (registry.roleHierarchy ?? {}) as Record<string, string[]>;
  delete hierarchy[LEGACY_ENVIRONMENT_ROUTER_ROLE];
  hierarchy.environmentActionSelector = Array.from(new Set(
    (hierarchy.environmentActionSelector ?? [DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID])
      .map(id => id === LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID
        ? DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID
        : id),
  ));
  registry.roleHierarchy = hierarchy as ModelRegistry['roleHierarchy'];

  for (const [id, definition] of Object.entries(registry.models)) {
    const hadLegacyRole = definition.roles.includes(LEGACY_ENVIRONMENT_ROUTER_ROLE);
    definition.roles = Array.from(new Set(
      definition.roles.filter(role => (
        role !== LEGACY_ENVIRONMENT_ROUTER_ROLE
        && !(id === LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID && role === 'environmentActionSelector')
      )),
    ));
    if ((hadLegacyRole || id === LEGACY_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID) && definition.roles.length === 0) {
      delete registry.models[id];
    }
  }
  registry.models[DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID] ??= {
    provider: 'ollama',
    model: DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL,
    adapters: [],
    roles: ['environmentActionSelector'],
    capabilities: ['text', 'image'],
    description: 'Vision-capable orchestrator used by the universal Environment selector',
    options: {
      contextWindow: 2048,
      temperature: 0.1,
      topP: 0.9,
      repeatPenalty: 1.05,
      enableThinking: false,
    },
    metadata: {
      priority: 'high',
      alwaysLoaded: true,
      estimatedLatency: 'fast',
      purpose: 'Vision-grounded Environment intent and typed action selection',
      systemOwned: true,
    },
  };
  const selectorDefinition = registry.models[DEFAULT_ENVIRONMENT_ACTION_SELECTOR_MODEL_ID]!;
  selectorDefinition.roles = Array.from(new Set([
    ...selectorDefinition.roles,
    'environmentActionSelector',
  ]));
  selectorDefinition.capabilities = Array.from(new Set([
    ...(selectorDefinition.capabilities ?? []),
    'text',
    'image',
  ]));

  // Consolidate request routing under orchestrator, preserving the old Intent
  // assignment rather than the unrelated general-orchestration assignment.
  const hadIntentDefault = Object.hasOwn(defaults, 'environmentIntent');
  if (hadIntentDefault) defaults.orchestrator = defaults.environmentIntent;
  delete defaults.environmentIntent;
  for (const mapping of Object.values(mappings)) {
    if (Object.hasOwn(mapping, 'environmentIntent')) {
      mapping.orchestrator = mapping.environmentIntent;
    } else if (hadIntentDefault) {
      // An omitted old Intent assignment inherited its default even when the
      // former general orchestrator had a mode-specific override.
      delete mapping.orchestrator;
    }
    delete mapping.environmentIntent;
  }
  if (Object.hasOwn(hierarchy, 'environmentIntent')) hierarchy.orchestrator = hierarchy.environmentIntent;
  delete hierarchy.environmentIntent;
  for (const definition of Object.values(registry.models)) {
    definition.roles = Array.from(new Set(definition.roles.map(role => role === 'environmentIntent' ? 'orchestrator' : role)));
  }

  // The autonomous planners previously selected Persona. Preserve that exact
  // assignment (including per-mode disabled/inherited choices) until reassigned.
  if (!Object.hasOwn(defaults, 'autonomy') && Object.hasOwn(defaults, 'persona')) {
    defaults.autonomy = defaults.persona;
    for (const mapping of Object.values(mappings)) {
      if (!Object.hasOwn(mapping, 'autonomy') && Object.hasOwn(mapping, 'persona')) {
        mapping.autonomy = mapping.persona;
      }
    }
  }

  return {
    registry,
    changed: before !== JSON.stringify(registry),
  };
}

function persistMigratedRegistry(registryPath: string, registry: ModelRegistry): void {
  const temporaryPath = `${registryPath}.migration-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, registryPath);
}


/**
 * Invalidate the model registry cache
 * Call this after updating the registry to force a reload
 */
export function invalidateModelCache(): void {
  registryCache.clear();
}

/** All persona controls update the same profile registry; model selection belongs to role assignments. */
export function updateModelGlobalSettings(username: string, settings: unknown): NonNullable<ModelRegistry['globalSettings']> {
  if (!isRecord(settings) || Object.keys(settings).some(key => key !== 'includePersonaSummary')
      || typeof settings.includePersonaSummary !== 'boolean') {
    throw new Error('Supply includePersonaSummary as a boolean. Select trained models through Model Settings role assignments.');
  }
  const registry = loadModelRegistry(true, username);
  registry.globalSettings = { includePersonaSummary: settings.includePersonaSummary };
  safeWriteJSON(resolveRegistryPath(username), registry);
  invalidateModelCache();
  return registry.globalSettings;
}

/**
 * Load and parse the model registry from etc/models.json
 *
 * NOTE: Uses context-aware paths.etc which resolves to:
 * - profiles/{username}/etc/models.json when user context is set
 * - etc/models.json at root when no context is set
 *
 * This allows each user to have their own base models and preferences!
 *
 * @param forceFresh - If true, bypass cache and reload from disk
 * @param username - Optional username to explicitly resolve user's profile path
 */
export function loadModelRegistry(forceFresh = false, username?: string): ModelRegistry {
  const registryPath = resolveRegistryPath(username);
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Model registry not found at ${registryPath}`);
  }

  try {
    const revision = registryRevision(registryPath);
    const cached = registryCache.get(registryPath);
    if (!forceFresh && cached?.revision === revision) return cached.registry;

    const content = fs.readFileSync(registryPath, 'utf-8');
    const parsedRegistry = parseModelRegistry(JSON.parse(content));
    const migration = migrateModelRegistry(parsedRegistry);
    const registry = migration.registry;
    if (migration.changed) persistMigratedRegistry(registryPath, registry);

    registryCache.set(registryPath, { registry,
      revision: migration.changed ? registryRevision(registryPath) : revision });

    return registry;
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to load model registry from ${registryPath}:`, error);
    throw new Error(`Failed to load model registry: ${(error as Error).message}`);
  }
}

function resolveRegistryPath(username?: string): string {
  // Username is REQUIRED - no fallback to system config
  if (!username) {
    throw new Error(`Username is required to load model registry. System fallback is disabled.`);
  }

  // Validate username to prevent path traversal attacks
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(username) || username.length > 50) {
    throw new Error(`Invalid username: must be alphanumeric with underscores/hyphens, max 50 chars`);
  }

  // Use getProfilePaths which correctly handles mobile vs desktop paths
  try {
    const profilePaths = getProfilePaths(username);
    const modelsPath = path.join(profilePaths.etc, 'models.json');

    if (fs.existsSync(modelsPath)) {
      return modelsPath;
    } else {
      throw new Error(`User models.json not found at ${modelsPath}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('models.json not found')) {
      console.error(`${LOG_PREFIX} User models.json not found for ${username}:`, err);
      throw err;
    }
    console.error(`${LOG_PREFIX} Failed to resolve user models.json path for '${username}':`, err);
    throw new Error(`Failed to resolve user models.json path for '${username}': ${err}`);
  }
}

/**
 * Resolve a model role to its concrete configuration
 */
export function resolveModel(
  role: ModelRole,
  overrides?: Partial<ResolvedModel>,
  username?: string
): ResolvedModel {


  // Input validation
  if (!role || typeof role !== 'string') {
    throw new Error(`Invalid role parameter: ${role}`);
  }
  if (username !== undefined && typeof username !== 'string') {
    throw new Error(`Invalid username parameter: ${username}`);
  }

  const registry = loadModelRegistry(false, username);

  // Get the default model ID for this role
  const defaultModelId = registry.defaults[role];
  if (!defaultModelId) {
    throw new Error(`No default model configured for role: ${role}`);
  }

  // Look up the model definition
  const savedModel = registry.models[defaultModelId];
  const modelDef = isBigBrotherModelId(defaultModelId) || savedModel?.provider === 'big-brother'
    ? { ...bigBrotherModelDefinition(defaultModelId, username), roles: savedModel?.roles || [] } : savedModel;
  if (!modelDef) {
    throw new Error(`Model definition not found for ID: ${defaultModelId}`);
  }

  // Build resolved model
  const resolved: ResolvedModel = {
    id: defaultModelId,
    provider: modelDef.provider,
    model: modelDef.model,
    adapters: modelDef.adapters || [],
    baseModel: modelDef.baseModel,
    roles: modelDef.roles,
    capabilities: modelDef.capabilities || [],
    options: { ...modelDef.options },
    metadata: { ...modelDef.metadata },
  };

  // Apply overrides if provided
  if (overrides) {
    Object.assign(resolved, overrides);
    if (overrides.options) {
      resolved.options = { ...resolved.options, ...overrides.options };
    }
    if (overrides.metadata) {
      resolved.metadata = { ...resolved.metadata, ...overrides.metadata };
    }
  }

  // Preserve the saved deployment; only explicit dynamic slots follow backend settings.
  return resolved;
}

/**
 * Resolve a model by ID instead of role
 */
export function resolveModelById(modelId: string, username?: string): ResolvedModel {
  // Input validation
  if (!modelId || typeof modelId !== 'string') {
    throw new Error(`Invalid modelId parameter: ${modelId}`);
  }
  if (username !== undefined && typeof username !== 'string') {
    throw new Error(`Invalid username parameter: ${username}`);
  }

  const registry = loadModelRegistry(false, username);

  const savedModel = registry.models[modelId];
  const modelDef = isBigBrotherModelId(modelId) || savedModel?.provider === 'big-brother'
    ? { ...bigBrotherModelDefinition(modelId, username), roles: savedModel?.roles || [] } : savedModel;
  if (!modelDef) {
    throw new Error(`Model definition not found for ID: ${modelId}`);
  }

  const resolved: ResolvedModel = {
    id: modelId,
    provider: modelDef.provider,
    model: modelDef.model,
    adapters: modelDef.adapters || [],
    baseModel: modelDef.baseModel,
    roles: modelDef.roles,
    capabilities: modelDef.capabilities || [],
    options: { ...modelDef.options },
    metadata: { ...modelDef.metadata || {} },
  };

  // Preserve the saved deployment; only explicit dynamic slots follow backend settings.
  return resolved;
}

/**
 * Resolve model based on cognitive mode
 *
 */
export function resolveModelForCognitiveMode(
  cognitiveMode: string,
  role: ModelRole,
  username?: string
): ResolvedModel {


  // Input validation
  if (!cognitiveMode || typeof cognitiveMode !== 'string') {
    throw new Error(`Invalid cognitiveMode parameter: ${cognitiveMode}`);
  }
  if (!role || typeof role !== 'string') {
    throw new Error(`Invalid role parameter: ${role}`);
  }
  if (username !== undefined && typeof username !== 'string') {
    throw new Error(`Invalid username parameter: ${username}`);
  }

  const registry = loadModelRegistry(false, username);

  // Check if there's a cognitive mode mapping
  if (registry.cognitiveModeMappings && registry.cognitiveModeMappings[cognitiveMode]) {
    const mapping = registry.cognitiveModeMappings[cognitiveMode];
    const modelId = mapping[role];

    // If null, this role is disabled for this cognitive mode
    if (modelId === null) {
      throw new Error(`Role ${role} is disabled in cognitive mode: ${cognitiveMode}`);
    }

    // If specific model ID provided, use it
    if (modelId && typeof modelId === 'string') return resolveModelById(modelId, username);

    // Cognitive-mode mappings override defaults. Roles omitted from the mode
    // continue through their normal default assignment.
    return resolveModel(role, undefined, username);
  } else {
    return resolveModel(role, undefined, username);
  }
}

/**
 * List all available roles
 */
export function listAvailableRoles(username?: string): ModelRole[] {
  const registry = loadModelRegistry(false, username);
  return Object.keys(registry.defaults) as ModelRole[];
}

/**
 * List all available model IDs
 */
export function listAvailableModels(username?: string): string[] {
  const registry = loadModelRegistry(false, username);
  return Object.keys(registry.models);
}

/**
 * Get all models that can fulfill a specific role
 */
export function getModelsForRole(role: ModelRole, username?: string): string[] {
  const registry = loadModelRegistry(false, username);

  // Check role hierarchy first
  if (registry.roleHierarchy && registry.roleHierarchy[role]) {
    return registry.roleHierarchy[role];
  }

  // Otherwise, find all models that declare this role
  return Object.entries(registry.models)
    .filter(([_, def]) => def.roles.includes(role))
    .map(([id, _]) => id);
}

/**
 * Validate the model registry for correctness
 */
export function validateRegistry(username?: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const registry = loadModelRegistry(true, username); // Force fresh load

    // Check that all default roles point to existing models
    for (const [role, modelId] of Object.entries(registry.defaults)) {
      if (!registry.models[modelId]) {
        errors.push(`Default role '${role}' references non-existent model: ${modelId}`);
      }
    }

    // Check that all role hierarchy references exist
    if (registry.roleHierarchy) {
      for (const [role, modelIds] of Object.entries(registry.roleHierarchy)) {
        for (const modelId of modelIds) {
          if (!registry.models[modelId]) {
            errors.push(`Role hierarchy '${role}' references non-existent model: ${modelId}`);
          }
        }
      }
    }

    // Check that all cognitive mode mappings are valid
    if (registry.cognitiveModeMappings) {
      for (const [mode, mapping] of Object.entries(registry.cognitiveModeMappings)) {
        for (const [role, modelId] of Object.entries(mapping)) {
          if (role === 'description') continue; // Skip description field
          if (modelId !== null && typeof modelId === 'string' && !registry.models[modelId]) {
            errors.push(`Cognitive mode '${mode}' role '${role}' references non-existent model: ${modelId}`);
          }
        }
      }
    }

    // Check that all models have required fields
    for (const [modelId, def] of Object.entries(registry.models)) {
      if (!def.provider) {
        errors.push(`Model '${modelId}' missing required field: provider`);
      }
      if (!def.model) {
        errors.push(`Model '${modelId}' missing required field: model`);
      }
      if (!def.roles || def.roles.length === 0) {
        errors.push(`Model '${modelId}' missing or empty roles array`);
      }
    }

  } catch (error) {
    errors.push(`Failed to load registry: ${(error as Error).message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get provider configuration
 */
export function getProviderConfig(provider: ModelProvider, username?: string): {
  baseUrl: string;
  timeout: number;
  retries: number;
} {
  const registry = loadModelRegistry(false, username);

  if (registry.providers && registry.providers[provider]) {
    return registry.providers[provider];
  }

  // Return defaults if not configured
  return {
    baseUrl: provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1',
    timeout: 120000,
    retries: 2,
  };
}

/** Effective Status-widget assignments only; inventory and legacy fallback entries are not startup requests. */
export function resolveAssignedModels(username: string, cognitiveMode?: string, roles: readonly ModelRole[] = MODEL_ROLES): ResolvedModel[] {
  const registry = loadModelRegistry(false, username);
  const mapping = cognitiveMode ? registry.cognitiveModeMappings?.[cognitiveMode] : undefined;
  return roles.filter(role => mapping?.[role] !== null && Boolean(mapping?.[role] || registry.defaults[role])).map(role => cognitiveMode
    ? resolveModelForCognitiveMode(cognitiveMode, role, username)
    : resolveModel(role, undefined, username));
}
