/**
 * Clip-planning settings: each pipeline stage picks its own source.
 *
 * Transcription has its own Cloud/Local choice (shared/transcription.ts).
 * Clip planning defaults to OpenRouter in the cloud and can run against
 * OpenRouter, OpenCode Zen, OpenCode Go, a custom OpenAI-compatible endpoint,
 * or a local OpenAI-compatible server the user already runs.
 *
 * Extras (Jev review, framing checks, source research, metadata) are not
 * switchable: they always use OpenRouter.
 */

export type PlanningSource = 'cloud' | 'local'

export type PlanningCloudProviderId = 'openrouter' | 'opencode-zen' | 'opencode-go' | 'custom'

export type LocalPlanningPresetId = 'ollama' | 'lmstudio' | 'llamacpp' | 'other'

/** A provider a model list or Test connection can target, including the local server. */
export type PlanningProviderId = PlanningCloudProviderId | 'local'

export interface PlanningModelsResult {
  models: string[]
  fetchedAt: string | null
  /** A failed refresh keeps the previous list and reports why. */
  error: string | null
}

export type PlanningTestKind = 'ok' | 'invalid-key' | 'rate-limited' | 'model-unavailable' | 'timeout' | 'server-error' | 'unreachable' | 'invalid-url' | 'incomplete'

export interface PlanningTestResult {
  ok: boolean
  kind: PlanningTestKind
  message: string
}

/** Provider keys that are stored on their own in secure storage. */
export type PlanningKeyName = 'opencode-zen' | 'opencode-go' | 'custom' | 'local'

export interface PlanningLocalSettings {
  preset: LocalPlanningPresetId
  baseUrl: string
  modelId: string
  contextTokens: number
}

export interface PlanningSettings {
  source: PlanningSource
  cloudProvider: PlanningCloudProviderId
  /** One remembered model id per cloud provider. OpenRouter uses the Create-screen presets. */
  cloudModels: Record<PlanningCloudProviderId, string>
  /** The "custom" cloud provider's https:// base URL. Ignored by the fixed providers. */
  cloudBaseUrl: string
  local: PlanningLocalSettings
}

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

export const PLANNING_CONTEXT_DEFAULT = 8192
export const PLANNING_CONTEXT_MIN = 1024
export const PLANNING_CONTEXT_MAX = 1048576
/** Prompt-size estimate: characters / 3 approximates tokens for English text. */
export const PLANNING_CHARS_PER_TOKEN = 3
/** Reserved for the JSON answer when checking a prompt against the context window. */
export const PLANNING_OUTPUT_ALLOWANCE_TOKENS = 2048

export const PLANNING_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/

export function isPlanningProviderId(value: unknown): value is PlanningProviderId {
  return value === 'local' || isPlanningCloudProvider(value)
}

export const PLANNING_DEFAULTS: PlanningSettings = {
  source: 'cloud',
  cloudProvider: 'openrouter',
  cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: '' },
  cloudBaseUrl: '',
  local: {
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: '',
    contextTokens: PLANNING_CONTEXT_DEFAULT
  }
}

export interface CloudProviderOption {
  id: PlanningCloudProviderId
  label: string
  /** Fixed, documented base URL. Custom endpoints bring their own. */
  baseUrl: string | null
  keyLabel: string
}

export const CLOUD_PLANNING_PROVIDERS: readonly CloudProviderOption[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyLabel: 'OpenRouter' },
  { id: 'opencode-zen', label: 'OpenCode Zen', baseUrl: OPENCODE_ZEN_BASE_URL, keyLabel: 'OpenCode' },
  { id: 'opencode-go', label: 'OpenCode Go', baseUrl: OPENCODE_GO_BASE_URL, keyLabel: 'OpenCode' },
  { id: 'custom', label: 'Custom endpoint', baseUrl: null, keyLabel: 'Custom endpoint' }
]

export function cloudPlanningProvider(id: PlanningCloudProviderId): CloudProviderOption {
  const found = CLOUD_PLANNING_PROVIDERS.find((provider) => provider.id === id)
  if (!found) throw new Error('Unknown cloud planning provider')
  return found
}

export interface LocalPlanningPreset {
  id: LocalPlanningPresetId
  label: string
  baseUrl: string
  hint: string
}

export const LOCAL_PLANNING_PRESETS: readonly LocalPlanningPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    hint: 'Start Ollama and pull a model, then press Refresh models.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    hint: 'In LM Studio, load a model and start the local server, then press Refresh models.'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server',
    baseUrl: 'http://127.0.0.1:8080/v1',
    hint: 'Start llama-server with a model, then press Refresh models.'
  },
  {
    id: 'other',
    label: 'Other (type the address)',
    baseUrl: '',
    hint: 'Any OpenAI-compatible server on this computer. Only loopback addresses are allowed.'
  }
]

export function localPlanningPreset(id: LocalPlanningPresetId): LocalPlanningPreset {
  const found = LOCAL_PLANNING_PRESETS.find((preset) => preset.id === id)
  if (!found) throw new Error('Unknown local planning preset')
  return found
}

export function isPlanningSource(value: unknown): value is PlanningSource {
  return value === 'cloud' || value === 'local'
}

export function isPlanningCloudProvider(value: unknown): value is PlanningCloudProviderId {
  return typeof value === 'string' && CLOUD_PLANNING_PROVIDERS.some((provider) => provider.id === value)
}

export function isLocalPlanningPreset(value: unknown): value is LocalPlanningPresetId {
  return typeof value === 'string' && LOCAL_PLANNING_PRESETS.some((preset) => preset.id === value)
}

export function isPlanningModelId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && PLANNING_MODEL_ID_PATTERN.test(value)
}

export function normalizeContextTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PLANNING_CONTEXT_DEFAULT
  return Math.max(PLANNING_CONTEXT_MIN, Math.min(PLANNING_CONTEXT_MAX, Math.round(value)))
}

/** Keep one unreadable saved field from making the rest of the settings unusable. */
export function normalizePlanningSettings(value: unknown): PlanningSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const cloudModelsRaw = (raw.cloudModels && typeof raw.cloudModels === 'object' ? raw.cloudModels : {}) as Record<string, unknown>
  const localRaw = (raw.local && typeof raw.local === 'object' ? raw.local : {}) as Record<string, unknown>
  const preset = isLocalPlanningPreset(localRaw.preset) ? localRaw.preset : PLANNING_DEFAULTS.local.preset
  const baseUrl = typeof localRaw.baseUrl === 'string' && localRaw.baseUrl.length <= 512
    ? localRaw.baseUrl.trim()
    : PLANNING_DEFAULTS.local.baseUrl
  return {
    source: isPlanningSource(raw.source) ? raw.source : PLANNING_DEFAULTS.source,
    cloudProvider: isPlanningCloudProvider(raw.cloudProvider) ? raw.cloudProvider : PLANNING_DEFAULTS.cloudProvider,
    cloudModels: {
      openrouter: isPlanningModelId(cloudModelsRaw.openrouter) ? cloudModelsRaw.openrouter : '',
      'opencode-zen': isPlanningModelId(cloudModelsRaw['opencode-zen']) ? cloudModelsRaw['opencode-zen'] : '',
      'opencode-go': isPlanningModelId(cloudModelsRaw['opencode-go']) ? cloudModelsRaw['opencode-go'] : '',
      custom: isPlanningModelId(cloudModelsRaw.custom) ? cloudModelsRaw.custom : ''
    },
    cloudBaseUrl: typeof raw.cloudBaseUrl === 'string' && raw.cloudBaseUrl.length <= 512 ? raw.cloudBaseUrl.trim() : '',
    local: {
      preset,
      baseUrl,
      modelId: isPlanningModelId(localRaw.modelId) ? localRaw.modelId : '',
      contextTokens: normalizeContextTokens(localRaw.contextTokens)
    }
  }
}

/** Apply a partial update over the saved planning settings; omitted fields keep their values. */
export function mergePlanningSettings(current: unknown, patch: unknown): PlanningSettings {
  const base = normalizePlanningSettings(current)
  const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const patchCloudModels = (raw.cloudModels && typeof raw.cloudModels === 'object' ? raw.cloudModels : {}) as Record<string, unknown>
  const patchLocal = (raw.local && typeof raw.local === 'object' ? raw.local : {}) as Record<string, unknown>
  const modelFor = (id: PlanningCloudProviderId): string => {
    if (!Object.hasOwn(patchCloudModels, id)) return base.cloudModels[id]
    return isPlanningModelId(patchCloudModels[id]) ? patchCloudModels[id] : ''
  }
  return {
    source: isPlanningSource(raw.source) ? raw.source : base.source,
    cloudProvider: isPlanningCloudProvider(raw.cloudProvider) ? raw.cloudProvider : base.cloudProvider,
    cloudModels: {
      openrouter: modelFor('openrouter'),
      'opencode-zen': modelFor('opencode-zen'),
      'opencode-go': modelFor('opencode-go'),
      custom: modelFor('custom')
    },
    cloudBaseUrl: Object.hasOwn(raw, 'cloudBaseUrl')
      ? (typeof raw.cloudBaseUrl === 'string' ? raw.cloudBaseUrl.trim().slice(0, 512) : '')
      : base.cloudBaseUrl,
    local: {
      preset: isLocalPlanningPreset(patchLocal.preset) ? patchLocal.preset : base.local.preset,
      baseUrl: Object.hasOwn(patchLocal, 'baseUrl')
        ? (typeof patchLocal.baseUrl === 'string' ? patchLocal.baseUrl.trim().slice(0, 512) : base.local.baseUrl)
        : base.local.baseUrl,
      modelId: Object.hasOwn(patchLocal, 'modelId')
        ? (isPlanningModelId(patchLocal.modelId) ? patchLocal.modelId : '')
        : base.local.modelId,
      contextTokens: Object.hasOwn(patchLocal, 'contextTokens')
        ? normalizeContextTokens(patchLocal.contextTokens)
        : base.local.contextTokens
    }
  }
}

/**
 * True for the hosts a local planning server may use: this computer only.
 *
 * The same three names are the bridge's allowlist, so a saved value that the UI
 * accepts can never be refused later by `_validate_planning_config`.
 */
export function isLoopbackPlanningHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export interface BaseUrlInfo {
  url: string
  hostname: string
  port: string
}

/**
 * Parse a planning base URL, returning null when it is malformed or carries
 * credentials. `hostname` is unbracketed, matching what the Python bridge and
 * the socket guard see for an IPv6 literal (`::1`, not `[::1]`).
 */
export function parsePlanningBaseUrl(value: unknown): BaseUrlInfo | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) return null
  try {
    const url = new URL(value.trim())
    if (url.username || url.password) return null
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return { url: url.toString().replace(/\/$/, ''), hostname: url.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return null
  }
}

/** The exact host a cloud planning request goes to, for the privacy line. */
export function planningDestinationHost(planning: PlanningSettings): string | null {
  if (planning.source === 'local') return null
  if (planning.cloudProvider === 'custom') {
    const info = parsePlanningBaseUrl(planning.cloudBaseUrl)
    return info ? info.hostname : null
  }
  const provider = cloudPlanningProvider(planning.cloudProvider)
  const info = parsePlanningBaseUrl(provider.baseUrl)
  return info ? info.hostname : null
}

/** A short stage label, e.g. "Cloud - OpenCode Zen - some-model". */
export function planningStageLabel(planning: PlanningSettings): string {
  if (planning.source === 'local') {
    const preset = localPlanningPreset(planning.local.preset)
    return planning.local.modelId ? `Local - ${preset.label} - ${planning.local.modelId}` : `Local - ${preset.label}`
  }
  const provider = cloudPlanningProvider(planning.cloudProvider)
  const model = planning.cloudModels[provider.id]
  return model && provider.id !== 'openrouter' ? `Cloud - ${provider.label} - ${model}` : `Cloud - ${provider.label}`
}

/**
 * The Settings privacy line, computed from both stages. `customHost` is used for
 * a custom endpoint; `null` there means the address is not usable yet.
 */
export function pipelinePrivacyLine(settings: {
  transcription: { provider: 'openrouter' | 'local' }
  planning: PlanningSettings
}): string {
  const audioLocal = settings.transcription.provider === 'local'
  const planningLocal = settings.planning.source === 'local'
  const planningHost = planningDestinationHost(settings.planning)
  const planningTarget = planningHost ?? 'this computer'
  const extras = 'Extras (Jev review, framing checks, source research, metadata) use OpenRouter when you turn them on.'
  if (audioLocal && planningLocal) {
    return `Audio and transcripts stay on this computer. ${extras}`
  }
  if (audioLocal) {
    return `Audio stays on this computer. Transcript text goes to: ${planningTarget}. ${extras}`
  }
  if (planningLocal) {
    return `Audio goes to OpenRouter for transcription. Clip planning stays on this computer. ${extras}`
  }
  if (planningHost && planningHost !== 'openrouter.ai') {
    return `Audio and transcript text go to OpenRouter. Transcript text also goes to: ${planningHost}. ${extras}`
  }
  return `Audio and transcript text go to OpenRouter. ${extras}`
}

/** The planning source as the Create screen shows it, with model ids exactly as returned. */
export interface PlanningStageStatus {
  configured: boolean
  reason: string | null
}

/**
 * Whether clip planning can run with the saved settings. `keys` reports which
 * provider keys exist in secure storage; the renderer only sees those booleans.
 */
export function planningStatus(planning: PlanningSettings, keys: Partial<Record<PlanningKeyName, boolean>>): PlanningStageStatus {
  if (planning.source === 'local') {
    const info = parsePlanningBaseUrl(planning.local.baseUrl)
    if (!info || !isLoopbackPlanningHost(info.hostname)) return { configured: false, reason: 'Set the local server address in Settings.' }
    if (!planning.local.modelId) return { configured: false, reason: 'Pick or type a model in Settings.' }
    return { configured: true, reason: null }
  }
  const provider = planning.cloudProvider
  if (provider === 'custom') {
    const info = parsePlanningBaseUrl(planning.cloudBaseUrl)
    if (!info || !info.url.startsWith('https://')) return { configured: false, reason: 'Set an https:// custom endpoint in Settings.' }
    if (!planning.cloudModels.custom) return { configured: false, reason: 'Type a model id in Settings.' }
    return { configured: true, reason: null }
  }
  if (provider !== 'openrouter' && !keys[provider]) {
    return { configured: false, reason: `Add and test the ${cloudPlanningProvider(provider).label} key in Settings.` }
  }
  if (provider !== 'openrouter' && !planning.cloudModels[provider]) {
    return { configured: false, reason: `Pick a model in Settings.` }
  }
  return { configured: true, reason: null }
}
