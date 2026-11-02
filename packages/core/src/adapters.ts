import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isTrainingTarget, type TrainingCandidateResult, type TrainingCandidateReview, type TrainingCandidateSummary, type TrainingMessage, type TrainingTarget } from './training-schema.js';
import { getProfilePaths } from './path-builder.js';
import { getUserContext } from './context.js';
import { safeWriteJSON } from './safe-file.js';
import { acquireLock } from './locks.js';
import { resolveModel, resolveModelForCognitiveMode } from './model-resolver.js';
import type { ProviderOptions } from './providers/types.js';


/** Shared receipt validation for local/remote training and candidate review. */
export function parseTrainingCandidateResult(value: unknown, datasetId: string, baseModel: string): TrainingCandidateResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Candidate result is missing');
  const result = value as TrainingCandidateResult;
  if (result.version !== 1 || result.status !== 'candidate' || result.datasetId !== datasetId || result.baseModel !== baseModel) {
    throw new Error('Candidate does not match the submitted run');
  }
  for (const hash of [result.datasetId, result.configSha256, result.templateSha256]) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Candidate identity is incomplete');
  }
  for (const count of [result.trainingSamples, result.evaluationSamples, result.supervisedTokens]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Candidate has no complete training/evaluation evidence');
  }
  if (result.evaluationPolicy !== 'independent' || result.supervision !== 'final-assistant-only'
    || result.activation !== 'not-activated' || result.servingValidation !== 'required') throw new Error('Candidate evaluation contract is invalid');
  if (!['lora', 'full', 'full_finetune'].includes(result.trainingMode)) throw new Error('Candidate training mode is invalid');
  if (![result.baselineLoss, result.candidateLoss].every(loss => typeof loss === 'number' && Number.isFinite(loss) && loss >= 0)) {
    throw new Error('Candidate has no finite baseline and serialized-artifact evaluation');
  }
  if (result.qualityGate !== (result.candidateLoss <= result.baselineLoss ? 'passed' : 'failed')) throw new Error('Candidate quality gate contradicts its evaluation');
  if (!result.artifacts || typeof result.artifacts !== 'object' || Array.isArray(result.artifacts)) throw new Error('Candidate artifact inventory is missing');
  for (const [name, hash] of Object.entries(result.artifacts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('Candidate artifact inventory contains an invalid filename or digest');
    }
  }
  if (!Object.keys(result.artifacts).some(name => name.endsWith('.safetensors'))
    || !result.artifacts['tokenizer_config.json'] || !result.artifacts['artifact-evaluation.json']) {
    throw new Error('Candidate has no complete weights, tokenizer and reload evaluation');
  }
  return result;
}

export async function trainingArtifactHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Verify exact persisted files; this never changes an accepted adapter. */
const verifiedArtifacts = new Map<string, { stamp: string; result: TrainingCandidateResult }>();
export async function verifyTrainingCandidate(
  directory: string,
  expected: { datasetId: string; baseModel: string; configPath: string; evaluationSha256: string; requireGguf: boolean; ggufArtifact?: 'model.gguf' | 'adapter.gguf' },
): Promise<TrainingCandidateResult> {
  const root = fs.realpathSync(directory);
  const receiptPath = fs.realpathSync(path.join(root, 'training-result.json'));
  if (path.dirname(receiptPath) !== root || !fs.statSync(receiptPath).isFile()) throw new Error('Candidate receipt escapes its run directory');
  const result = parseTrainingCandidateResult(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), expected.datasetId, expected.baseModel);
  const stamp = JSON.stringify([expected, [receiptPath, expected.configPath, ...Object.keys(result.artifacts).map(name => path.join(root, name))].map(file => {
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real, { bigint: true });
    return [file, real, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
  })]);
  const cached = verifiedArtifacts.get(root);
  if (cached?.stamp === stamp) return cached.result;
  if (await trainingArtifactHash(expected.configPath) !== result.configSha256) throw new Error('Candidate configuration checksum differs from the submitted configuration');
  if (expected.requireGguf && !result.artifacts[expected.ggufArtifact ?? 'model.gguf']) throw new Error('Requested GGUF was not produced');
  for (const [name, expectedHash] of Object.entries(result.artifacts)) {
    const file = fs.realpathSync(path.join(root, name));
    if (path.dirname(file) !== root || !fs.statSync(file).isFile()) throw new Error('Candidate artifact escapes its run directory');
    if (await trainingArtifactHash(file) !== expectedHash) throw new Error('Candidate artifact checksum mismatch: ' + name);
  }
  const report = JSON.parse(fs.readFileSync(path.join(root, 'artifact-evaluation.json'), 'utf8'));
  if (report.version !== 1 || report.evaluationSha256 !== expected.evaluationSha256 || report.loss !== result.candidateLoss || report.count !== result.evaluationSamples) {
    throw new Error('Serialized-artifact evaluation differs from the candidate receipt');
  }
  if (!report.artifacts || typeof report.artifacts !== 'object' || Array.isArray(report.artifacts)) throw new Error('Serialized-artifact evaluation has no file inventory');
  const evaluatedFiles = Object.keys(result.artifacts).filter(name => !['model.gguf', 'adapter.gguf', 'artifact-evaluation.json'].includes(name)).sort();
  if (JSON.stringify(Object.keys(report.artifacts).sort()) !== JSON.stringify(evaluatedFiles)
    || evaluatedFiles.some(name => report.artifacts[name] !== result.artifacts[name])) throw new Error('Evaluation did not load these exact weights and tokenizer files');
  verifiedArtifacts.set(root, { stamp, result });
  if (verifiedArtifacts.size > 8) verifiedArtifacts.delete(verifiedArtifacts.keys().next().value!);
  return result;
}

export interface ActiveAdapterInfo {
  modelName: string;
  activatedAt: string;
  adapterPath?: string;
  dataset?: string;
  modelfilePath?: string;
  status?: string;
  date?: string;
  trainingMethod?: string;
  runLabel?: string;
  ggufAdapterPath?: string;
  baseModel?: string;
  activatedBy?: string;
  target?: string;
}


const RUN_LABEL = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
function candidateRoot(username: string, runLabel: string): string {
  if (!RUN_LABEL.test(runLabel)) throw new Error('Invalid training run label');
  const root = path.join(getProfilePaths(username).out, 'adapters');
  const directory = path.join(root, runLabel.slice(0, 10), runLabel);
  if (fs.existsSync(directory) && fs.realpathSync(directory) !== path.join(fs.realpathSync(root), runLabel.slice(0, 10), runLabel)) {
    throw new Error('Training candidate directory escapes its profile');
  }
  return directory;
}
function readJSON(file: string): any { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function hashJSON(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function listTrainingCandidates(username: string): TrainingCandidateSummary[] {
  const root = path.join(getProfilePaths(username).out, 'adapters');
  if (!fs.existsSync(root)) return [];
  const candidates: TrainingCandidateSummary[] = [];
  for (const date of fs.readdirSync(root, { withFileTypes: true })) {
    if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
    for (const entry of fs.readdirSync(path.join(root, date.name), { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_LABEL.test(entry.name)) continue;
      const directory = candidateRoot(username, entry.name);
      if (!fs.existsSync(path.join(directory, 'run.json'))) continue;
      const run = readJSON(path.join(directory, 'run.json'));
      if (run.username !== username || run.runLabel !== entry.name) throw new Error('Training candidate profile identity is invalid');
      const configPath = path.join(directory, 'config.json');
      const target = fs.existsSync(configPath) ? readJSON(configPath).trainingTarget : run.trainingTarget;
      if (typeof target !== 'string' || !target.trim()) throw new Error('Training run has no recorded serving target: ' + entry.name);
      const reviewPath = path.join(directory, 'review.json');
      candidates.push({
        runLabel: entry.name, status: run.status, method: run.method, baseModel: run.baseModel,
        target, datasetId: run.datasetId,
        candidateDirectory: path.join(directory, run.method === 'fine-tune' ? 'model' : 'adapter'),
        trainingSamples: run.trainingSamples, evaluationSamples: run.evaluationSamples,
        baselineLoss: run.baselineLoss, candidateLoss: run.candidateLoss, qualityGate: run.qualityGate,
        error: run.error, ...(fs.existsSync(reviewPath) ? { review: readJSON(reviewPath) } : {}),
      });
    }
  }
  return candidates.sort((a, b) => b.runLabel.localeCompare(a.runLabel));
}

async function candidateForReview(username: string, runLabel: string) {
  const summary = listTrainingCandidates(username).find(candidate => candidate.runLabel === runLabel);
  if (!summary || summary.status !== 'candidate') throw new Error('This run has no passing candidate to review');
  if (!isTrainingTarget(summary.target)) throw new Error('This historical candidate uses a retired serving provider: ' + summary.target);
  const root = candidateRoot(username, runLabel);
  const manifest = readJSON(path.join(root, 'dataset-manifest.json'));
  const { datasetId, ...snapshot } = manifest;
  if (hashJSON(snapshot) !== datasetId || datasetId !== summary.datasetId) throw new Error('Candidate dataset manifest changed');
  const result = await verifyTrainingCandidate(summary.candidateDirectory, {
    datasetId, baseModel: summary.baseModel, configPath: path.join(root, 'config.json'),
    evaluationSha256: manifest.evaluation.sha256, requireGguf: true,
    ggufArtifact: summary.target === 'llama-cpp' && summary.method !== 'fine-tune' ? 'adapter.gguf' : 'model.gguf',
  });
  if (result.qualityGate !== 'passed') throw new Error('The independent evaluation gate failed');
  return { summary, root, manifest, result };
}

export function trainingCandidateModelName(username: string, runLabel: string, target: string): string {
  if (!RUN_LABEL.test(runLabel)) throw new Error('Invalid training run label');
  return target === 'ollama' ? ('personalization-' + username + '-' + runLabel).toLowerCase() + ':candidate' : runLabel;
}

async function inspectCandidateServing(username: string, candidate: Awaited<ReturnType<typeof candidateForReview>>, signal?: AbortSignal,
  configuration?: NonNullable<TrainingCandidateReview['servingConfiguration']>) {
  const { loadBackendConfig } = await import('./llm-backend.js');
  const config = loadBackendConfig();
  const { summary, result } = candidate;
  const model = configuration?.model ?? trainingCandidateModelName(username, summary.runLabel, summary.target);
  if (summary.target === 'llama-cpp') {
    const { callLlamaCpp, getLlamaCppAdapters, getLlamaCppProperties } = await import('./providers/llama-cpp.js');
    const selected = configuration ? undefined : resolveModel('persona', undefined, username);
    const serving = { ...config.llamaCpp,
      ...(selected?.provider === 'llama-cpp' ? { ...selected.options, model: selected.model } : {}),
      ...(summary.method === 'fine-tune' ? { model } : {}),
      ...(configuration ? { endpoint: configuration.endpoint, model: configuration.model } : {}), enableThinking: false };
    const properties = await getLlamaCppProperties(serving, signal);
    if (typeof properties.chat_template !== 'string' || !properties.chat_template.trim()) {
      throw new Error('llama.cpp did not confirm an installed chat template');
    }
    const artifact = path.join(summary.candidateDirectory, summary.method === 'fine-tune' ? 'model.gguf' : 'adapter.gguf');
    const loaded = summary.method === 'fine-tune' ? undefined
      : (await getLlamaCppAdapters(serving, signal)).find(adapter => adapter.path === artifact);
    if (summary.method === 'fine-tune'
      ? properties.model_path !== artifact : !loaded) {
      throw new Error('Load this exact candidate artifact through the existing llama.cpp service before review: ' + artifact);
    }
    const lora = loaded ? [{ path: artifact, scale: 1 }] : [];
    return { model: serving.model, config: serving,
      configuration: { endpoint: serving.endpoint, model: serving.model, lora },
      identity: hashJSON({ endpoint: serving.endpoint, model: serving.model, modelPath: properties.model_path,
        template: properties.chat_template, parameters: properties.default_generation_settings, lora,
        artifact: result.artifacts[path.basename(artifact)] }),
      chat: async (model: string, messages: TrainingMessage[]) => (await callLlamaCpp({ ...serving, model }, messages,
        { temperature: 0, maxTokens: 512, enableThinking: false, lora })).content };
  }
  if (summary.target === 'ollama') {
    const { OllamaClient } = await import('./ollama.js');
    const endpoint = configuration?.endpoint ?? config.ollama.endpoint;
    const client = new OllamaClient(endpoint);
    const detail = await client.showModel(model);
    if (typeof detail.template !== 'string' || !detail.template.trim()
        || typeof detail.modelfile !== 'string' || !detail.modelfile.includes('sha256-' + result.artifacts['model.gguf'])) {
      throw new Error('Ollama did not confirm this exact GGUF and an installed chat template');
    }
    return { model, configuration: { endpoint, model, lora: [] }, identity: hashJSON({ endpoint, model, template: detail.template,
      parameters: detail.parameters, modelfile: detail.modelfile }),
      chat: async (model: string, messages: TrainingMessage[]) => (await client.chat(model, messages,
        { temperature: 0, num_predict: 512, think: false })).message.content };
  }
  throw new Error('Unsupported candidate serving provider: ' + summary.target);
}

/** Prepare the exact artifact, without changing a role or the backend's default model. */
export async function prepareTrainingCandidate(username: string, runLabel: string): Promise<{ model: string }> {
  candidateRoot(username, runLabel);
  const lock = acquireLock('training-review-' + username + '-' + runLabel, { exitOnSignal: false });
  try {
    const candidate = await candidateForReview(username, runLabel);
    if (candidate.summary.review?.decision === 'accepted') throw new Error('This candidate is already accepted; use Model Settings to assign its existing model');
    const { loadBackendConfig } = await import('./llm-backend.js');
    const config = loadBackendConfig();
    const model = trainingCandidateModelName(username, runLabel, candidate.summary.target);
    if (candidate.summary.target === 'ollama') {
      const { createOllamaGgufModel } = await import('./ollama-lora.js');
      await createOllamaGgufModel(model, path.join(candidate.summary.candidateDirectory, 'model.gguf'), config.ollama.endpoint);
    }
    return { model: (await inspectCandidateServing(username, candidate)).model };
  } finally { lock.release(); }
}

/** Compare bounded user-selected prompts on the actual serving backend. */
export async function testTrainingCandidate(username: string, runLabel: string, input: { baselineModel: string; baselineProvider: TrainingTarget; prompts: string[] }): Promise<TrainingCandidateReview> {
  candidateRoot(username, runLabel);
  if (!isTrainingTarget(input.baselineProvider)) throw new Error('Unsupported baseline serving provider');
  if (typeof input.baselineModel !== 'string' || !input.baselineModel.trim() || input.baselineModel.length > 300
      || !Array.isArray(input.prompts) || input.prompts.length < 3 || input.prompts.length > 8
      || input.prompts.some(prompt => typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000)
      || new Set(input.prompts).size !== input.prompts.length) throw new Error('Supply a baseline model and three to eight distinct review prompts (up to 4000 characters each)');
  const lock = acquireLock('training-review-' + username + '-' + runLabel, { exitOnSignal: false });
  try {
    const candidate = await candidateForReview(username, runLabel);
    if (candidate.summary.review?.decision === 'accepted') throw new Error('An accepted review is immutable; use Models to switch or roll back');
    const serving = await inspectCandidateServing(username, candidate);
    if (input.baselineProvider === candidate.summary.target && input.baselineModel === serving.model
      && !(candidate.summary.target === 'llama-cpp' && candidate.summary.method !== 'fine-tune')) throw new Error('Baseline and candidate must be different models');
    const { loadBackendConfig } = await import('./llm-backend.js');
    const config = loadBackendConfig();
    let baselineChat: (messages: TrainingMessage[]) => Promise<string>;
    if (input.baselineProvider === 'llama-cpp') {
      const { callLlamaCpp, getLlamaCppProperties } = await import('./providers/llama-cpp.js');
      const baseline = { ...config.llamaCpp, ...('config' in serving ? serving.config : {}), model: input.baselineModel };
      await getLlamaCppProperties(baseline);
      baselineChat = async messages => (await callLlamaCpp(baseline, messages,
        { temperature: 0, maxTokens: 512, enableThinking: false, lora: [] })).content;
    } else {
      const { OllamaClient } = await import('./ollama.js');
      const client = new OllamaClient(config.ollama.endpoint);
      await client.showModel(input.baselineModel);
      baselineChat = async messages => (await client.chat(input.baselineModel, messages, { temperature: 0, num_predict: 512, think: false })).message.content;
    }
    const cases: TrainingCandidateReview['cases'] = [];
    for (const prompt of input.prompts) {
      const messages: TrainingMessage[] = [
        ...(candidate.manifest.systemPrompt ? [{ role: 'system' as const, content: candidate.manifest.systemPrompt }] : []),
        { role: 'user', content: prompt },
      ];
      const baseline = await baselineChat(messages);
      const response = await serving.chat(serving.model, messages);
      if (!baseline.trim() || !response.trim()) throw new Error('Serving review returned an empty response');
      cases.push({ prompt, baseline, candidate: response });
    }
    if ((await inspectCandidateServing(username, candidate)).identity !== serving.identity) throw new Error('Serving configuration changed during review');
    const review: TrainingCandidateReview = {
      id: hashJSON({ runLabel, cases, identity: serving.identity, at: new Date().toISOString() }),
      runLabel, datasetId: candidate.manifest.datasetId, provider: candidate.summary.target as TrainingTarget, model: serving.model,
      baselineModel: input.baselineModel, baselineProvider: input.baselineProvider, servingIdentity: serving.identity,
      servingConfiguration: serving.configuration,
      artifactReceiptHash: await trainingArtifactHash(path.join(candidate.summary.candidateDirectory, 'training-result.json')),
      createdAt: new Date().toISOString(), cases,
    };
    safeWriteJSON(path.join(candidate.root, 'review.json'), review);
    return review;
  } finally { lock.release(); }
}

export async function decideTrainingCandidate(username: string, runLabel: string,
  input: { reviewId: string; decision: 'accepted' | 'rejected'; notes: string; checks: boolean[] }): Promise<TrainingCandidateReview> {
  candidateRoot(username, runLabel);
  const lock = acquireLock('training-review-' + username + '-' + runLabel, { exitOnSignal: false });
  try {
    const candidate = await candidateForReview(username, runLabel);
    const review = candidate.summary.review;
    if (!review || review.id !== input.reviewId || review.decision === 'accepted' || review.reopenedAt) throw new Error('The review is missing, superseded, or already accepted; run a fresh comparison');
    if (!['accepted', 'rejected'].includes(input.decision) || typeof input.notes !== 'string' || !input.notes.trim() || input.notes.length > 8000) throw new Error('A review decision and notes are required');
    if (input.decision === 'accepted' && (!Array.isArray(input.checks) || input.checks.length !== review.cases.length || input.checks.some(value => value !== true))) {
      throw new Error('Review every candidate response before acceptance');
    }
    if (review.artifactReceiptHash !== await trainingArtifactHash(path.join(candidate.summary.candidateDirectory, 'training-result.json'))
        || review.servingIdentity !== (await inspectCandidateServing(username, candidate)).identity) throw new Error('Artifact or serving identity changed after review');
    const decided = { ...review, decision: input.decision, notes: input.notes.trim(), reviewedAt: new Date().toISOString() };
    safeWriteJSON(path.join(candidate.root, 'review.json'), decided);
    return decided;
  } finally { lock.release(); }
}

/** Reopening suspends approval until a fresh serving comparison is accepted. */
export async function reopenTrainingCandidateReview(username: string, runLabel: string): Promise<TrainingCandidateReview> {
  candidateRoot(username, runLabel);
  const lock = acquireLock('training-review-' + username + '-' + runLabel, { exitOnSignal: false });
  try {
    const candidate = await candidateForReview(username, runLabel);
    if (!candidate.summary.review) throw new Error('This candidate has no prior serving review');
    const review: TrainingCandidateReview = { ...candidate.summary.review, decision: 'rejected',
      notes: 'Serving review reopened by the owner; approval is suspended until a fresh comparison is accepted.', reopenedAt: new Date().toISOString(), reviewedAt: new Date().toISOString() };
    safeWriteJSON(path.join(candidate.root, 'review.json'), review);
    return review;
  } finally { lock.release(); }
}

/** Existing model-role assignment calls this gate for every known training artifact. */
export async function assertTrainingModelApproved(username: string | undefined, provider: string, model: string,
  options: Pick<ProviderOptions, 'endpoint' | 'lora' | 'signal'> = {}, phase: 'assignment' | 'inference' = 'inference'): Promise<TrainingCandidateSummary | null> {
  const adapterPaths = options.lora?.flatMap(adapter => adapter.path ? [adapter.path] : []) ?? [];
  const candidates = username ? listTrainingCandidates(username) : [];
  const candidate = candidates.find(item => item.target === provider && (item.target === 'llama-cpp' && item.method !== 'fine-tune'
    ? adapterPaths.includes(path.join(item.candidateDirectory, 'adapter.gguf')) : [
    trainingCandidateModelName(username!, item.runLabel, item.target), item.candidateDirectory, item.review?.model,
  ].includes(model)));
  if (!candidate || !username) {
    if (model.startsWith('personalization-') || RUN_LABEL.test(model) || [model, ...adapterPaths].some(value => value.includes('/out/adapters/'))) throw new Error('This personalization artifact has no review owned by your profile');
    return null;
  }
  if (candidate.review?.decision !== 'accepted') throw new Error('Review and accept this candidate in Training History before assigning a model role');
  const verified = await candidateForReview(username, candidate.runLabel);
  const { loadBackendConfig } = await import('./llm-backend.js');
  const backend = loadBackendConfig();
  const requested = { endpoint: options.endpoint ?? (provider === 'llama-cpp' ? backend.llamaCpp.endpoint : backend.ollama.endpoint),
    model, lora: provider === 'llama-cpp' ? (options.lora ?? []).map(adapter => adapter.path
      ? { path: adapter.path, scale: adapter.scale } : { id: adapter.id, scale: adapter.scale }) : [] };
  const recorded = candidate.review.servingConfiguration;
  if (!recorded || hashJSON(recorded) !== hashJSON(requested)) {
    throw new Error('Accepted training serving configuration changed or was not recorded; run a fresh serving comparison');
  }
  if (candidate.review.artifactReceiptHash !== await trainingArtifactHash(path.join(candidate.candidateDirectory, 'training-result.json'))) {
    throw new Error('Accepted training artifact changed');
  }
  if (phase === 'assignment') return candidate;
  const serving = await inspectCandidateServing(username, verified, options.signal, recorded);
  if (candidate.review.servingIdentity !== serving.identity) throw new Error('Accepted training artifact or serving configuration changed');
  return candidate;
}

/** Active personalization is a projection of the profile's actual persona role. */
export function getActiveAdapter(username = getUserContext()?.username, cognitiveMode?: string): ActiveAdapterInfo | null {
  if (!username) return null;
  const file = path.join(getProfilePaths(username).etc, 'models.json');
  if (!fs.existsSync(file)) return null;
  const registry = readJSON(file);
  if (cognitiveMode && registry.cognitiveModeMappings?.[cognitiveMode]?.persona === null) return null;
  const model = cognitiveMode ? resolveModelForCognitiveMode(cognitiveMode, 'persona', username) : resolveModel('persona', undefined, username);
  const runLabel = model?.metadata?.trainingRunLabel;
  if (typeof runLabel !== 'string') return null;
  const candidate = listTrainingCandidates(username).find(item => item.runLabel === runLabel);
  if (!candidate || candidate.review?.decision !== 'accepted') return null;
  const activatedAt = model.metadata.trainingActivatedAt;
  if (typeof activatedAt !== 'string') throw new Error('Assigned training model has no activation timestamp');
  return { modelName: model.model, activatedAt, status: 'active',
    runLabel, trainingMethod: candidate.method, date: runLabel.slice(0, 10), adapterPath: candidate.candidateDirectory,
    baseModel: candidate.baseModel, dataset: candidate.datasetId, target: candidate.target };
}
