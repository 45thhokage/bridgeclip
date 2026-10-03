/**
 * Transcription settings, the local model catalog and the GPU recommendation.
 *
 * OpenRouter (MAI Transcribe 2) stays the default. Local transcription runs the
 * speech-to-text model on this computer; clip planning picks its own source in
 * shared/planning.ts.
 * Hardware is never detected: the GPU dropdown is the only source, so every
 * decision here is a pure function of the chosen family and VRAM.
 */

export type TranscriptionProviderId = 'openrouter' | 'local'

export type GpuFamily =
  | 'nvidia_modern'
  | 'nvidia_pascal'
  | 'nvidia_old'
  | 'cpu_or_other'
  | 'apple_silicon'
  | 'unsure'

export type TranscriptionVram = 'under4' | '4to7' | '8plus'

export type LocalTranscriptionBackend = 'faster-whisper' | 'onnx-parakeet'

export interface TranscriptionSettings {
  provider: TranscriptionProviderId
  gpuFamily: GpuFamily
  vram: TranscriptionVram
  localModelId: LocalModelId | null
}

export const TRANSCRIPTION_DEFAULTS: TranscriptionSettings = {
  provider: 'openrouter',
  gpuFamily: 'unsure',
  vram: '4to7',
  localModelId: null
}

export interface GpuFamilyOption {
  id: GpuFamily
  label: string
  /** NVIDIA families are the only ones that ask about VRAM. */
  nvidia: boolean
}

export const GPU_FAMILY_OPTIONS: readonly GpuFamilyOption[] = [
  { id: 'nvidia_modern', label: 'NVIDIA RTX 20/30/40/50 series or GTX 16 series', nvidia: true },
  { id: 'nvidia_pascal', label: 'NVIDIA GTX 10 series (GTX 1050-1080)', nvidia: true },
  { id: 'nvidia_old', label: 'Older NVIDIA (GTX 900 series or older)', nvidia: true },
  { id: 'cpu_or_other', label: 'AMD, Intel, or no dedicated GPU', nvidia: false },
  { id: 'apple_silicon', label: 'Apple silicon Mac (M1 or newer)', nvidia: false },
  { id: 'unsure', label: "I'm not sure", nvidia: false }
]

export const VRAM_OPTIONS: readonly { id: TranscriptionVram; label: string }[] = [
  { id: 'under4', label: 'Under 4 GB' },
  { id: '4to7', label: '4-7 GB' },
  { id: '8plus', label: '8 GB or more' }
]

export const GPU_HINT = 'Check Task Manager > Performance > GPU (Windows) to see your GPU and its dedicated memory.'

export type LocalModelId =
  | 'distil-large-v3.5'
  | 'large-v3-turbo'
  | 'distil-large-v3'
  | 'small.en'
  | 'parakeet-tdt-0.6b-v2'

export interface LocalTranscriptionModel {
  id: LocalModelId
  label: string
  backend: LocalTranscriptionBackend
  /** Hugging Face repo and pinned commit; main sends these to the bridge. */
  repo: string
  revision: string
  approxSizeMB: number
  license: string
  englishOnly: true
  description: string
  /** Experimental models stay selectable but carry a label in the UI. */
  experimental?: boolean
}

/**
 * The only model ids the app may use. Repos and revisions were resolved from
 * the Hugging Face API on 2026-10-02; sizes are the real snapshot totals.
 */
export const LOCAL_TRANSCRIPTION_MODELS: readonly LocalTranscriptionModel[] = [
  {
    id: 'distil-large-v3.5',
    label: 'Distil Large v3.5',
    backend: 'faster-whisper',
    repo: 'distil-whisper/distil-large-v3.5-ct2',
    revision: '9793ccc07920e0f830e1dba0343efcdf0ef8c903',
    approxSizeMB: 1517,
    license: 'MIT',
    englishOnly: true,
    description: 'Distilled large model: near-large accuracy at several times the speed.'
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo',
    backend: 'faster-whisper',
    repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    approxSizeMB: 1622,
    license: 'MIT',
    englishOnly: true,
    description: 'Full large-v3 accuracy with a faster decoder.'
  },
  {
    id: 'distil-large-v3',
    label: 'Distil Large v3',
    backend: 'faster-whisper',
    repo: 'Systran/faster-distil-whisper-large-v3',
    revision: 'c3058b475261292e64a0412df1d2681c06260fab',
    approxSizeMB: 1517,
    license: 'MIT',
    englishOnly: true,
    description: 'Previous-generation distilled large model.'
  },
  {
    id: 'small.en',
    label: 'Small English',
    backend: 'faster-whisper',
    repo: 'Systran/faster-whisper-small.en',
    revision: 'd1d751a5f8271d482d14ca55d9e2deeebbae577f',
    approxSizeMB: 486,
    license: 'MIT',
    englishOnly: true,
    description: 'Compact English model; the safe choice for smaller GPUs and CPUs.'
  },
  {
    id: 'parakeet-tdt-0.6b-v2',
    label: 'Parakeet TDT 0.6B v2',
    backend: 'onnx-parakeet',
    repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
    revision: '0bbb45a3365852604aef28b538a8f066f4ccaa85',
    approxSizeMB: 3174,
    license: 'CC-BY-4.0',
    englishOnly: true,
    description: 'NVIDIA Parakeet int8 ONNX; built for fast CPU transcription.',
    experimental: true
  }
]

export const LOCAL_TRANSCRIPTION_MODEL_IDS: readonly LocalModelId[] = LOCAL_TRANSCRIPTION_MODELS.map((model) => model.id)

export function isLocalModelId(value: unknown): value is LocalModelId {
  return typeof value === 'string' && (LOCAL_TRANSCRIPTION_MODEL_IDS as readonly string[]).includes(value)
}

export function localModel(modelId: LocalModelId): LocalTranscriptionModel {
  const found = LOCAL_TRANSCRIPTION_MODELS.find((model) => model.id === modelId)
  if (!found) throw new Error('Unknown local transcription model')
  return found
}

export function isTranscriptionProvider(value: unknown): value is TranscriptionProviderId {
  return value === 'openrouter' || value === 'local'
}

/** The Transcription stage as the Settings and Create screens show it. */
export function transcriptionStageLabel(settings: TranscriptionSettings): string {
  if (settings.provider === 'local') {
    return settings.localModelId ? `Local - ${localModel(settings.localModelId).label}` : 'Local - choose a model'
  }
  return 'Cloud - OpenRouter'
}

export function isGpuFamily(value: unknown): value is GpuFamily {
  return typeof value === 'string' && GPU_FAMILY_OPTIONS.some((option) => option.id === value)
}

export function isTranscriptionVram(value: unknown): value is TranscriptionVram {
  return value === 'under4' || value === '4to7' || value === '8plus'
}

/** Keep one unreadable saved field from making the rest of the settings unusable. */
export function normalizeTranscriptionSettings(value: unknown): TranscriptionSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    provider: isTranscriptionProvider(raw.provider) ? raw.provider : TRANSCRIPTION_DEFAULTS.provider,
    gpuFamily: isGpuFamily(raw.gpuFamily) ? raw.gpuFamily : TRANSCRIPTION_DEFAULTS.gpuFamily,
    vram: isTranscriptionVram(raw.vram) ? raw.vram : TRANSCRIPTION_DEFAULTS.vram,
    localModelId: isLocalModelId(raw.localModelId) ? raw.localModelId : TRANSCRIPTION_DEFAULTS.localModelId
  }
}

/**
 * Apply a partial update over the saved transcription settings. Fields the
 * update omits keep their saved values, so changing the GPU never resets the
 * provider, VRAM or selected model. An explicit `localModelId: null` clears it.
 */
export function mergeTranscriptionSettings(current: unknown, patch: unknown): TranscriptionSettings {
  const base = normalizeTranscriptionSettings(current)
  const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const present = (key: keyof TranscriptionSettings): boolean => Object.hasOwn(raw, key)
  return {
    provider: isTranscriptionProvider(raw.provider) ? raw.provider : base.provider,
    gpuFamily: isGpuFamily(raw.gpuFamily) ? raw.gpuFamily : base.gpuFamily,
    vram: isTranscriptionVram(raw.vram) ? raw.vram : base.vram,
    localModelId: !present('localModelId')
      ? base.localModelId
      : isLocalModelId(raw.localModelId) ? raw.localModelId : null
  }
}

export interface TranscriptionRecommendation {
  recommendedModelId: LocalModelId
  /** Other catalog models worth showing with their speed/accuracy label. */
  alsoAvailable: LocalModelId[]
  computeType: 'float16' | 'int8'
  device: 'cuda' | 'cpu'
  reason: string
}

/** A catalog model as the Settings screen shows it. */
export interface LocalModelStatus extends LocalTranscriptionModel {
  downloaded: boolean
  recommended: boolean
  tag: string | null
  warning: string | null
  active: boolean
}

/** One in-flight model download, as pushed to the renderer. */
export interface ModelDownloadState {
  modelId: LocalModelId
  percent: number
  bytesDone: number
  bytesTotal: number
  failed: boolean
  error: string | null
}

export interface TranscriptionOverview {
  settings: TranscriptionSettings
  recommendation: TranscriptionRecommendation
  models: LocalModelStatus[]
  download: ModelDownloadState | null
  runtimeInstalled: boolean | null
  installCommand: string
}

/** Additional labels for models listed in `alsoAvailable`. */
export const LOCAL_MODEL_TAGS: Partial<Record<LocalModelId, string>> = {
  'large-v3-turbo': 'Highest accuracy, slower',
  'parakeet-tdt-0.6b-v2': 'Fastest (experimental)'
}

/**
 * The recommended local setup for a GPU choice. Pure: no hardware probing.
 * Every catalog model stays selectable; this only decides the default, the
 * device/compute type main sends to the engine and what the UI labels.
 */
export function recommendTranscription(gpuFamily: GpuFamily, vram: TranscriptionVram): TranscriptionRecommendation {
  const cuda = gpuFamily === 'nvidia_modern' || gpuFamily === 'nvidia_pascal'
  const int8 = gpuFamily === 'nvidia_pascal' || !cuda
  const computeType = int8 ? 'int8' : 'float16'
  if (cuda && vram !== 'under4') {
    return {
      recommendedModelId: 'distil-large-v3.5',
      alsoAvailable: ['large-v3-turbo', 'distil-large-v3', 'parakeet-tdt-0.6b-v2'],
      computeType,
      device: 'cuda',
      reason: gpuFamily === 'nvidia_pascal'
        ? 'GTX 10 series: no fast fp16, so int8 is used.'
        : 'RTX 20/30/40/50 series: float16 on the GPU is the fastest accurate setup.'
    }
  }
  if (cuda) {
    return {
      recommendedModelId: 'small.en',
      alsoAvailable: ['parakeet-tdt-0.6b-v2'],
      computeType,
      device: 'cuda',
      reason: 'Under 4 GB of VRAM: the smallest English model fits and still runs on the GPU.'
    }
  }
  const reason = {
    nvidia_old: 'Older NVIDIA cards run the CPU (int8) build.',
    cpu_or_other: 'Without a supported NVIDIA GPU, transcription runs on the CPU with int8.',
    apple_silicon: 'Apple silicon runs the CPU (int8) build; no CUDA is needed.',
    unsure: 'Not sure which GPU: the CPU (int8) build works everywhere, and you can switch later.',
    nvidia_modern: '',
    nvidia_pascal: ''
  }[gpuFamily]
  return {
    recommendedModelId: 'small.en',
    alsoAvailable: ['parakeet-tdt-0.6b-v2'],
    computeType: 'int8',
    device: 'cpu',
    reason
  }
}

/**
 * A warning label for models that probably will not fit this setup. Never a
 * block: the warning says what may happen, not what is allowed.
 */
export function localModelWarning(modelId: LocalModelId, gpuFamily: GpuFamily, vram: TranscriptionVram): string | null {
  const model = localModel(modelId)
  const cuda = gpuFamily === 'nvidia_modern' || gpuFamily === 'nvidia_pascal'
  const tooBig = model.approxSizeMB > localModel('small.en').approxSizeMB
  if (cuda) return vram === 'under4' && tooBig ? 'May be slow or run out of memory' : null
  return modelId === 'small.en' || modelId === 'parakeet-tdt-0.6b-v2' ? null : 'May be slow or run out of memory'
}

/** The recommended default for a GPU choice, falling back to the catalog's smallest model. */
export function recommendedModelId(gpuFamily: GpuFamily, vram: TranscriptionVram): LocalModelId {
  return recommendTranscription(gpuFamily, vram).recommendedModelId
}
