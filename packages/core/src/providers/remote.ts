/**
 * Direct remote inference transports.
 *
 * RunPod delegates to the canonical cloud provider implementation. The other
 * transports cover user-supplied Anthropic, OpenRouter, and OpenAI credentials.
 */

import { RunPodServerlessProvider } from './runpod.js'
import {
  parseProviderImageDataUrl,
  providerImagePolicyFromOptions,
  type ProviderMessage,
  type ProviderOptions,
  type ProviderResponse,
} from './types.js'

export type RemoteProviderName = 'runpod' | 'claude' | 'openrouter' | 'openai' | 'gemini'

export interface RemoteProviderCredentials {
  provider: RemoteProviderName
  apiKey: string
  endpoint?: string
  model?: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function requireTextMessages(messages: ProviderMessage[], provider: string): Array<{
  role: ProviderMessage['role']
  content: string
}> {
  return messages.map(message => {
    if (typeof message.content !== 'string') {
      throw new Error(`${provider} does not support image content through this adapter`)
    }
    return { role: message.role, content: message.content }
  })
}

function usageFromOpenAI(value: unknown): ProviderResponse['usage'] | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const promptTokens = numberValue(usage.prompt_tokens)
  const completionTokens = numberValue(usage.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: numberValue(usage.total_tokens) || promptTokens + completionTokens,
  }
}

async function requestJson(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs = 120_000,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`${provider} request failed (${response.status}): ${body || response.statusText}`)
    }
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new Error(`${provider} returned invalid JSON`)
    }
  } catch (error) {
    init.signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${provider} request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function callClaude(
  messages: ProviderMessage[],
  credentials: RemoteProviderCredentials,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  const textMessages = requireTextMessages(messages, 'Anthropic')
  const system = textMessages.find(message => message.role === 'system')?.content
  const conversation = textMessages.filter(message => message.role !== 'system')
  const model = options.model || credentials.model || 'claude-3-5-sonnet-20241022'
  const data = asRecord(await requestJson('Anthropic', 'https://api.anthropic.com/v1/messages', {
    signal: options.signal,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': credentials.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: conversation,
      ...(system ? { system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }),
  }))
  const firstContent = asRecord(asArray(data?.content)[0])
  const content = stringValue(firstContent?.text)
  if (!content) throw new Error('Anthropic response did not contain text')
  const usage = asRecord(data?.usage)
  const promptTokens = numberValue(usage?.input_tokens)
  const completionTokens = numberValue(usage?.output_tokens)
  return {
    content,
    model: stringValue(data?.model) || model,
    provider: 'claude',
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  }
}

async function callOpenAICompatible(
  provider: 'openai' | 'openrouter',
  messages: ProviderMessage[],
  credentials: RemoteProviderCredentials,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  const isOpenRouter = provider === 'openrouter'
  const model = options.model || credentials.model || (isOpenRouter
    ? 'anthropic/claude-3.5-sonnet'
    : 'gpt-4o')
  const data = asRecord(await requestJson(
    isOpenRouter ? 'OpenRouter' : 'OpenAI',
    isOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : credentials.endpoint || 'https://api.openai.com/v1/chat/completions',
    {
      signal: options.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${credentials.apiKey}`,
        ...(isOpenRouter ? {
          'HTTP-Referer': 'https://metahuman.dev',
          'X-Title': 'MetaHuman OS',
        } : {}),
      },
      body: JSON.stringify({
        model,
        messages: requireTextMessages(messages, isOpenRouter ? 'OpenRouter' : 'OpenAI'),
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        top_p: options.topP ?? 0.9,
      }),
    },
  ))
  const choice = asRecord(asArray(data?.choices)[0])
  const message = asRecord(choice?.message)
  const content = stringValue(message?.content)
  if (!content) throw new Error(`${isOpenRouter ? 'OpenRouter' : 'OpenAI'} response did not contain text`)
  return {
    content,
    model: stringValue(data?.model) || model,
    provider,
    usage: usageFromOpenAI(data?.usage),
  }
}

function normalizeGeminiJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGeminiJsonSchema)
  if (!value || typeof value !== 'object') return value
  const record = value as JsonRecord
  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === 'const') {
      const inferredType = typeof item === 'boolean'
        ? 'boolean'
        : typeof item === 'number'
          ? 'number'
          : 'string'
      if (!Object.hasOwn(record, 'type')) result.type = inferredType
      result.enum = [item]
    } else {
      result[key] = normalizeGeminiJsonSchema(item)
    }
  }
  return result
}

async function callGemini(
  messages: ProviderMessage[],
  credentials: RemoteProviderCredentials,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  const imagePolicy = providerImagePolicyFromOptions(options)
  const rawModel = options.model || credentials.model || 'gemini-3.5-flash-lite'
  const model = rawModel.replace(/^models\//, '')

  const systemParts: Array<{ text: string }> = []
  const contents: Array<{ role: 'user' | 'model'; parts: Array<JsonRecord> }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
      if (text.trim()) systemParts.push({ text })
      continue
    }

    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: Array<JsonRecord> = []
    if (typeof message.content === 'string') {
      if (message.content) parts.push({ text: message.content })
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text) parts.push({ text: part.text })
        } else if (part.type === 'image_url') {
          const parsed = parseProviderImageDataUrl(part.image_url.url, imagePolicy)
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.base64,
            },
          })
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts })
  }

  const generationConfig: JsonRecord = {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  }

  if (options.jsonSchema || options.format === 'json') {
    generationConfig.responseMimeType = 'application/json'
    if (options.jsonSchema) {
      generationConfig.responseJsonSchema = normalizeGeminiJsonSchema(options.jsonSchema)
    }
  }

  // Disable hidden thinking delay on thinking-capable Flash models unless explicitly requested;
  // gemini-3.5-flash-lite is natively non-thinking and rejects thinkingConfig.
  if (!model.includes('3.5-flash-lite')) {
    if (options.enableThinking === true) {
      generationConfig.thinkingConfig = { includeThoughts: true }
    } else if (model.startsWith('gemini-3.8-') || model.startsWith('gemini-3.1-flash-lite')) {
      generationConfig.thinkingConfig = { thinkingLevel: model.includes('flash-lite') ? 'MINIMAL' : 'LOW' }
    } else if (model.startsWith('gemini-3.5-flash') || model.startsWith('gemini-2.5-flash')) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 }
    }
  }

  const baseUrl = (credentials.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credentials.apiKey)}`

  const data = asRecord(await requestJson('Gemini', url, {
    signal: options.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
      contents,
      generationConfig,
    }),
  }))

  const candidate = asRecord(asArray(data?.candidates)[0])
  const contentRecord = asRecord(candidate?.content)
  const parts = asArray(contentRecord?.parts).map(asRecord).filter((p): p is JsonRecord => Boolean(p))
  const textParts = parts.filter(p => p.thought !== true && typeof p.text === 'string').map(p => String(p.text))
  const thoughtParts = parts.filter(p => p.thought === true && typeof p.text === 'string').map(p => String(p.text))
  const content = textParts.join('')
  if (!content) {
    const finishReason = stringValue(candidate?.finishReason) || 'unknown'
    throw new Error(`Gemini response did not contain text (finishReason: ${finishReason})`)
  }

  const usage = asRecord(data?.usageMetadata)
  const promptTokens = numberValue(usage?.promptTokenCount)
  const completionTokens = numberValue(usage?.candidatesTokenCount)
  return {
    content,
    ...(thoughtParts.length > 0 ? { thinking: thoughtParts.join('') } : {}),
    model: stringValue(data?.modelVersion) || model,
    provider: 'gemini',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: numberValue(usage?.totalTokenCount) || promptTokens + completionTokens,
    },
  }
}

export async function callRemoteProvider(
  credentials: RemoteProviderCredentials,
  messages: ProviderMessage[],
  options: ProviderOptions = {},
): Promise<ProviderResponse> {
  if (!credentials.apiKey?.trim()) throw new TypeError(`${credentials.provider} API key is required`)

  switch (credentials.provider) {
    case 'runpod': {
      if (!credentials.endpoint?.trim()) throw new TypeError('RunPod endpoint ID is required')
      return new RunPodServerlessProvider({
        apiKey: credentials.apiKey,
        endpointId: credentials.endpoint,
      }).generate(messages, options)
    }
    case 'claude':
      return callClaude(messages, credentials, options)
    case 'gemini':
      return callGemini(messages, credentials, options)
    case 'openrouter':
    case 'openai':
      return callOpenAICompatible(credentials.provider, messages, credentials, options)
  }
}

export async function testRemoteProvider(credentials: RemoteProviderCredentials): Promise<{
  success: boolean
  error?: string
  latencyMs: number
}> {
  const startedAt = Date.now()
  try {
    await callRemoteProvider(credentials, [{ role: 'user', content: 'Hi' }], { maxTokens: 10 })
    return { success: true, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    }
  }
}
