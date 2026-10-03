import { readResponseText } from './http-response'
import { assertPublicWebUrl } from './network-policy'
import { loadSettings, type AppSettings } from './settings-store'
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  PLANNING_CONTEXT_DEFAULT,
  cloudPlanningProvider,
  isLoopbackPlanningHost,
  normalizePlanningSettings,
  parsePlanningBaseUrl,
  type PlanningKeyName,
  type PlanningModelsResult,
  type PlanningProviderId,
  type PlanningSettings,
  type PlanningTestResult
} from '../shared/planning'

/**
 * Main-process side of clip planning.
 *
 * The renderer never sends a base URL, model or key at job time: main resolves
 * every value from the saved settings, validates it and passes the non-secret
 * options to the engine. Keys stay in the main process and reach the worker
 * through its environment only.
 *
 * Model lists and connection tests use the same hardened request shape as the
 * OpenRouter calls: fixed hosts (or an explicit, validated custom URL), no
 * redirects, bounded responses and short timeouts. Key values and request
 * bodies are never logged.
 */

const MODELS_TIMEOUT_MS = 15_000
const MODELS_RESPONSE_BYTES = 4 * 1024 * 1024
const CHAT_TIMEOUT_MS = 90_000
const CHAT_RESPONSE_BYTES = 2 * 1024 * 1024
const MODELS_CACHE_MS = 10 * 60 * 1000

export interface ResolvedPlanningProvider {
  provider: PlanningProviderId
  /** null for the OpenRouter preset path, which the engine already knows. */
  baseUrl: string | null
  modelId: string | null
  key: string
  contextTokens: number | null
}

const keyForProvider: Record<PlanningProviderId, (settings: AppSettings) => string> = {
  openrouter: (settings) => settings.openrouterApiKey,
  'opencode-zen': (settings) => settings.opencodeZenApiKey,
  'opencode-go': (settings) => settings.opencodeGoApiKey,
  custom: (settings) => settings.planningCustomApiKey,
  local: (settings) => settings.planningLocalApiKey
}

export function planningProviderKeyName(settings: PlanningSettings): PlanningKeyName | 'openrouter' {
  const planning = normalizePlanningSettings(settings)
  if (planning.source === 'local') return 'local'
  return planning.cloudProvider
}

/** The provider a Test connection button applies to. */
export function activePlanningTarget(settings: PlanningSettings): PlanningProviderId {
  const planning = normalizePlanningSettings(settings)
  return planning.source === 'local' ? 'local' : planning.cloudProvider
}

/**
 * Resolve just the connection a model list needs. Listing models must work
 * before one is chosen: that is how the user picks a model, and Refresh
 * re-reads the list without touching the current selection.
 */
export function resolvePlanningModelsProvider(target: PlanningProviderId, settings: AppSettings = loadSettings()): ResolvedPlanningProvider {
  const planning = normalizePlanningSettings(settings.planning)
  if (target === 'openrouter') {
    return { provider: target, baseUrl: 'https://openrouter.ai/api/v1', modelId: null, key: settings.openrouterApiKey, contextTokens: null }
  }
  if (target === 'local') {
    const info = parsePlanningBaseUrl(planning.local.baseUrl)
    if (!info) throw new Error('Set a valid local planning server address in Settings.')
    if (!info.url.startsWith('http://')) throw new Error('A local planning server must use http:// on this computer.')
    if (!isLoopbackPlanningHost(info.hostname)) throw new Error('A local planning server must run on this computer (127.0.0.1, ::1 or localhost).')
    return { provider: target, baseUrl: info.url, modelId: planning.local.modelId || null, key: settings.planningLocalApiKey, contextTokens: planning.local.contextTokens }
  }
  if (target === 'custom') {
    const info = parsePlanningBaseUrl(planning.cloudBaseUrl)
    if (!info || !info.url.startsWith('https://')) throw new Error('A custom planning endpoint must use an https:// address.')
    return { provider: target, baseUrl: info.url, modelId: planning.cloudModels.custom || null, key: settings.planningCustomApiKey, contextTokens: null }
  }
  return {
    provider: target,
    baseUrl: target === 'opencode-zen' ? OPENCODE_ZEN_BASE_URL : OPENCODE_GO_BASE_URL,
    modelId: planning.cloudModels[target] || null,
    key: keyForProvider[target](settings),
    contextTokens: null
  }
}

/**
 * Resolve one explicit provider target (a B3 key row or the active provider),
 * validating the values a job or a connection test needs. Unlike a model list,
 * this requires the model that planning would actually use.
 */
export function resolvePlanningTarget(target: PlanningProviderId, settings: AppSettings = loadSettings()): ResolvedPlanningProvider {
  const resolved = resolvePlanningModelsProvider(target, settings)
  if (target === 'openrouter') return resolved
  const modelId = resolved.modelId
  if (!modelId) {
    if (target === 'local') throw new Error('Pick or type a model for local clip planning in Settings.')
    throw new Error(`Pick a ${cloudPlanningProvider(target).label} model in Settings.`)
  }
  return { ...resolved, modelId }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * Resolve the effective provider from saved settings, validating every value.
 * Throws a message that names the setting to fix; used before queueing a job
 * and by the model list and test-connection calls.
 */
export function resolvePlanningProvider(settings: AppSettings = loadSettings()): ResolvedPlanningProvider {
  const planning = normalizePlanningSettings(settings.planning)
  if (planning.source === 'local') return resolvePlanningTarget('local', settings)
  if (planning.cloudProvider === 'openrouter') {
    // The preset planner models and the OpenRouter request path stay in charge.
    return { provider: 'openrouter', baseUrl: null, modelId: null, key: settings.openrouterApiKey, contextTokens: null }
  }
  const provider = planning.cloudProvider
  const resolved = resolvePlanningTarget(provider, settings)
  if (!resolved.key && provider !== 'custom') throw new Error(`Add and test the ${cloudPlanningProvider(provider).label} key in Settings.`)
  return resolved
}

/** Resolve now so a job cannot be queued with an unusable provider. Custom hosts are DNS-checked. */
export async function validatePlanningSettings(settings: AppSettings = loadSettings()): Promise<void> {
  const resolved = resolvePlanningProvider(settings)
  if (resolved.provider === 'custom' && resolved.baseUrl) await assertPublicWebUrl(resolved.baseUrl)
}

/** The non-secret planning options sent to the engine in the job config. */
export function planningJobOptions(settings: AppSettings = loadSettings()): Record<string, string | number> {
  const resolved = resolvePlanningProvider(settings)
  if (resolved.provider === 'openrouter') {
    return { planning_source: 'cloud', planning_provider: 'openrouter' }
  }
  const options: Record<string, string | number> = {
    planning_source: normalizePlanningSettings(settings.planning).source,
    planning_provider: resolved.provider,
    planning_model_id: resolved.modelId!,
    planning_base_url: resolved.baseUrl!
  }
  if (resolved.provider === 'local') {
    const info = parsePlanningBaseUrl(resolved.baseUrl!)!
    options.planning_context_tokens = resolved.contextTokens ?? PLANNING_CONTEXT_DEFAULT
    options.planning_local_host = info.hostname
    options.planning_local_port = Number(info.port)
  }
  return options
}

/** The provider key as an environment value for the worker; never written to stdin. */
export function planningKeyEnvironment(settings: AppSettings = loadSettings()): Record<string, string> {
  const resolved = resolvePlanningProvider(settings)
  return resolved.key ? { PLANNING_API_KEY: resolved.key } : {}
}

/** True when clip planning itself needs the OpenRouter key. */
export function planningUsesOpenRouter(settings: AppSettings = loadSettings()): boolean {
  const planning = normalizePlanningSettings(settings.planning)
  return planning.source === 'cloud' && planning.cloudProvider === 'openrouter'
}

function providerLabel(provider: PlanningProviderId): string {
  if (provider === 'local') return 'Local planning server'
  if (provider === 'custom') return 'Custom endpoint'
  return cloudPlanningProvider(provider).label
}

const modelsCache = new Map<string, { models: string[]; fetchedAt: string }>()

function cacheKey(resolved: ResolvedPlanningProvider): string {
  return `${resolved.provider}\0${resolved.baseUrl ?? 'openrouter'}`
}

async function fetchModelIds(resolved: ResolvedPlanningProvider): Promise<string[]> {
  if (resolved.provider === 'custom') await assertPublicWebUrl(resolved.baseUrl!)
  const url = joinUrl(resolved.baseUrl!, 'models')
  const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'identity' }
  if (resolved.key) headers.Authorization = `Bearer ${resolved.key}`
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${providerLabel(resolved.provider)} returned an error (HTTP ${response.status}).`)
  }
  const body = JSON.parse(await readResponseText(response, MODELS_RESPONSE_BYTES, 'The model list is too large.'))
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data) || data.length > 5000) throw new Error(`${providerLabel(resolved.provider)} returned an invalid model list.`)
  const models: string[] = []
  for (const entry of data) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null
    if (typeof id === 'string' && id && id.length <= 200 && !models.includes(id)) models.push(id)
    if (models.length >= 2000) break
  }
  if (!models.length) throw new Error(`${providerLabel(resolved.provider)} returned no models. Make sure the server has a model loaded, then refresh.`)
  return models
}

/**
 * The provider's model list. A failed refresh keeps the previously loaded list
 * and reports the error; nothing is cached across providers.
 */
export async function listPlanningModels(refresh: unknown = false, target?: PlanningProviderId): Promise<PlanningModelsResult> {
  if (typeof refresh !== 'boolean') throw new Error('Invalid model refresh option')
  const settings = loadSettings()
  let resolved: ResolvedPlanningProvider
  try {
    resolved = resolvePlanningModelsProvider(target ?? activePlanningTarget(settings.planning), settings)
  } catch (error) {
    // A half-configured provider reports why instead of throwing over IPC,
    // so the picker can show the address or key that still needs saving.
    return { models: [], fetchedAt: null, error: error instanceof Error ? error.message : 'Could not load the model list.' }
  }
  const key = cacheKey(resolved)
  const cached = modelsCache.get(key)
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < MODELS_CACHE_MS) {
    return { models: cached.models, fetchedAt: cached.fetchedAt, error: null }
  }
  try {
    const models = await fetchModelIds(resolved)
    const fetchedAt = new Date().toISOString()
    modelsCache.set(key, { models, fetchedAt })
    return { models, fetchedAt, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load the model list.'
    if (cached) return { models: cached.models, fetchedAt: cached.fetchedAt, error: message }
    return { models: [], fetchedAt: null, error: message }
  }
}

function timeoutMessage(): string {
  return 'The provider did not answer in time.'
}

function unreachableMessage(provider: PlanningProviderId): string {
  if (provider === 'local') return 'Could not reach the local server. Check that it is running and that the address is correct.'
  return 'Could not reach the provider. Check your connection and try again.'
}

function freeModelMessage(): string {
  return 'This free model may be restricted for third-party apps. Pick a paid model or try again later.'
}

/**
 * One tiny chat completion with the selected model. Classified failures stay
 * actionable without exposing provider internals, keys or request bodies.
 */
export async function testPlanningConnection(target?: PlanningProviderId, settings: AppSettings = loadSettings()): Promise<PlanningTestResult> {
  const targetId = target ?? activePlanningTarget(settings.planning)
  let resolved: ResolvedPlanningProvider
  try {
    resolved = resolvePlanningTarget(targetId, settings)
  } catch (error) {
    // Without a key there is no model list to pick a model from, so name the
    // key first instead of asking for a model that cannot exist yet.
    if (targetId !== 'local' && targetId !== 'custom' && !keyForProvider[targetId](settings)) {
      return { ok: false, kind: 'incomplete', message: `Add and test the ${cloudPlanningProvider(targetId).label} key in Settings.` }
    }
    return { ok: false, kind: 'incomplete', message: error instanceof Error ? error.message : 'Finish the planning setup first.' }
  }
  if (resolved.provider === 'openrouter') return testOpenRouterKey(settings)
  if (resolved.provider === 'custom') {
    try { await assertPublicWebUrl(resolved.baseUrl!) } catch { return { ok: false, kind: 'invalid-url', message: 'This address must be a public https:// endpoint.' } }
  }
  // A local server must answer a model list before the chat request; a missing
  // model is clearer than a chat failure.
  if (resolved.provider === 'local') {
    try {
      const models = await fetchModelIds(resolved)
      if (!models.includes(resolved.modelId!)) {
        return { ok: false, kind: 'model-unavailable', message: `The server does not list "${resolved.modelId}". Load it, refresh the model list and pick it.` }
      }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return {
        ok: false,
        kind: timedOut ? 'timeout' : 'unreachable',
        message: timedOut ? timeoutMessage() : error instanceof Error ? error.message : 'Could not reach the local server.'
      }
    }
  }

  const url = joinUrl(resolved.baseUrl!, 'chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
  if (resolved.key) headers.Authorization = `Bearer ${resolved.key}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      body: JSON.stringify({
        model: resolved.modelId,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
      })
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return { ok: false, kind: timedOut ? 'timeout' : 'unreachable', message: timedOut ? timeoutMessage() : unreachableMessage(resolved.provider) }
  }
  if (!response.ok) {
    let bodyText = ''
    try { bodyText = (await readResponseText(response, 64 * 1024)).slice(0, 2000) } catch { /* Classification is best effort. */ }
    const freeModel = /(:free$|[-_]free$)/i.test(resolved.modelId!) || /free/i.test(bodyText)
    if (response.status === 429) {
      return { ok: false, kind: 'rate-limited', message: freeModel ? freeModelMessage() : 'The provider is rate limiting requests. Try again in a moment.' }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'invalid-key', message: freeModel ? freeModelMessage() : 'The provider rejected this key. Check the key and try again.' }
    }
    if (response.status === 404 || /model/i.test(bodyText) && /not (found|available|supported)|unavailable|no such/i.test(bodyText)) {
      return { ok: false, kind: 'model-unavailable', message: `The provider does not offer "${resolved.modelId}". Pick another model from the list.` }
    }
    if (response.status >= 500) return { ok: false, kind: 'server-error', message: `The provider had a server error (HTTP ${response.status}). Try again later.` }
    return { ok: false, kind: 'server-error', message: `The provider rejected the test request (HTTP ${response.status}).` }
  }
  try {
    await readResponseText(response, CHAT_RESPONSE_BYTES, 'The provider response is too large.')
  } catch {
    return { ok: false, kind: 'server-error', message: 'The provider returned an unusable response.' }
  }
  return { ok: true, kind: 'ok', message: 'Connection works. This model answered.' }
}

/** A read-only key check for OpenRouter: no inference request and no charge. */
async function testOpenRouterKey(settings: AppSettings): Promise<PlanningTestResult> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${settings.openrouterApiKey}`, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      redirect: 'error',
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
    })
    if (response.ok) {
      await response.body?.cancel()
      return { ok: true, kind: 'ok', message: 'The OpenRouter key works.' }
    }
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) return { ok: false, kind: 'invalid-key', message: 'OpenRouter rejected this key. Check it and try again.' }
    if (response.status === 429) return { ok: false, kind: 'rate-limited', message: 'OpenRouter is rate limiting requests. Try again in a moment.' }
    if (response.status >= 500) return { ok: false, kind: 'server-error', message: `OpenRouter had a server error (HTTP ${response.status}). Try again later.` }
    return { ok: false, kind: 'server-error', message: `OpenRouter rejected the key check (HTTP ${response.status}).` }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return { ok: false, kind: timedOut ? 'timeout' : 'unreachable', message: timedOut ? timeoutMessage() : unreachableMessage('openrouter') }
  }
}

/** Clear the cached model list; used by tests. */
export function clearPlanningModelCache(): void {
  modelsCache.clear()
}
