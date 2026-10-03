import { JEV_DEFAULTS, JEV_FEATURE_DEFAULTS } from '../../shared/jev-settings'
import { TRANSCRIPTION_DEFAULTS, mergeTranscriptionSettings, type TranscriptionOverview, type TranscriptionSettings } from '../../shared/transcription'
import { PLANNING_DEFAULTS, mergePlanningSettings, planningStatus, type PlanningSettings } from '../../shared/planning'
import { create } from 'zustand'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import type { ApiKeyName, ClipSettings, ToolStatus } from '../../preload/index'

interface SettingsState extends ClipSettings {
  loaded: boolean
  saving: boolean
  toolStatus: ToolStatus | null
  checkingTools: boolean
  toolError: string | null
  load: () => Promise<void>
  save: (settings: Partial<ClipSettings>) => Promise<void>
  /** Save the transcription pickers through the dedicated IPC and keep the store in sync. */
  saveTranscription: (update: Partial<TranscriptionSettings>) => Promise<TranscriptionOverview>
  /** Save part of the clip-planning settings; the store is the only source of truth. */
  savePlanning: (update: Partial<PlanningSettings>) => Promise<void>
  replaceApiKey: (key: ApiKeyName, value: string) => Promise<void>
  checkTools: () => Promise<void>
}

// Queue writes so each partial update merges with the last successful save.
let saveQueue: Promise<void> = Promise.resolve()
let pendingSaves = 0
let latestToolCheck = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  openrouterConfigured: false,
  zernioConfigured: false,
  ...JEV_DEFAULTS,
  ...JEV_FEATURE_DEFAULTS,
  outputDirectory: '',
  pythonPath: 'python3',
  customVocabulary: '',
  transcription: { ...TRANSCRIPTION_DEFAULTS },
  planning: { ...PLANNING_DEFAULTS },
  planningKeysConfigured: { openrouter: false, 'opencode-zen': false, 'opencode-go': false, custom: false, local: false },
  loaded: false,
  saving: false,
  toolStatus: null,
  checkingTools: false,
  toolError: null,

  load: async () => {
    const settings = await getApi().settings.load()
    set({ ...pickSettings(settings), loaded: true })
  },

  save: (updates) => {
    const patch = { ...updates }
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const merged: ClipSettings = { ...pickSettings(get()), ...patch }
      const saved = await getApi().settings.save(merged)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  saveTranscription: (update) => {
    const merged = mergeTranscriptionSettings(get().transcription, update)
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async (): Promise<TranscriptionOverview> => {
      const overview = await getApi().transcription.save(merged)
      // The selects render from the store, so the saved value must land here.
      set({ ...pickSettings(get()), transcription: overview.settings, loaded: true })
      return overview
    })
    saveQueue = task.then(() => undefined).catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  savePlanning: (update) => {
    const merged = mergePlanningSettings(get().planning, update)
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const saved = await getApi().planning.save(merged)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  replaceApiKey: (key, value) => {
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const saved = await getApi().settings.replaceApiKey(key, value)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  checkTools: async () => {
    const request = ++latestToolCheck
    set({ checkingTools: true, toolError: null })
    try {
      const status = await getApi().system.checkTools()
      if (request === latestToolCheck) set({ toolStatus: status })
    } catch (err) {
      if (request === latestToolCheck) {
        set({ toolStatus: null, toolError: errorMessage(err, 'Could not check required tools. Try again in Settings.') })
      }
    } finally {
      if (request === latestToolCheck) set({ checkingTools: false })
    }
  }
}))

function pickSettings(s: ClipSettings): ClipSettings {
  return {
    jevThreshold: s.jevThreshold ?? JEV_DEFAULTS.jevThreshold,
    jevSelfContainedThreshold: s.jevSelfContainedThreshold ?? JEV_DEFAULTS.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: s.jevFaithfulToSourceThreshold ?? JEV_DEFAULTS.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: s.jevTitleSupportedThreshold ?? JEV_DEFAULTS.jevTitleSupportedThreshold,
    jevSponsorThreshold: s.jevSponsorThreshold ?? JEV_DEFAULTS.jevSponsorThreshold,
    jevEvidenceThreshold: s.jevEvidenceThreshold ?? JEV_DEFAULTS.jevEvidenceThreshold,
    jevCutThreshold: s.jevCutThreshold ?? JEV_DEFAULTS.jevCutThreshold,
    openrouterConfigured: s.openrouterConfigured,
    jevEnabled: s.jevEnabled ?? JEV_FEATURE_DEFAULTS.jevEnabled,
    jevVisualContext: s.jevVisualContext ?? JEV_FEATURE_DEFAULTS.jevVisualContext,
    sourceContextWebResearch: s.sourceContextWebResearch ?? JEV_FEATURE_DEFAULTS.sourceContextWebResearch,
    zernioConfigured: s.zernioConfigured,
    outputDirectory: s.outputDirectory,
    pythonPath: s.pythonPath,
    customVocabulary: s.customVocabulary,
    transcription: s.transcription ?? { ...TRANSCRIPTION_DEFAULTS },
    planning: s.planning ?? { ...PLANNING_DEFAULTS },
    planningKeysConfigured: s.planningKeysConfigured ?? { openrouter: false, 'opencode-zen': false, 'opencode-go': false, custom: false, local: false }
  }
}

export type SetupState = {
  ready: boolean
  /** Missing provider keys, named with the stage that needs them. */
  missingKeys: string[]
  /** Everything else that blocks a job, one line per stage. */
  reasons: string[]
  toolsOk: boolean | null
}

/**
 * Whether a clip job can start. Each stage is checked against its own source:
 * a local planner needs no OpenRouter key, while cloud transcription,
 * OpenRouter planning and Review & edit still do.
 */
export function useSetupState(): SetupState {
  const openrouter = useSettingsStore((s) => s.openrouterConfigured)
  const transcription = useSettingsStore((s) => s.transcription)
  const planning = useSettingsStore((s) => s.planning)
  const planningKeys = useSettingsStore((s) => s.planningKeysConfigured)
  const tools = useSettingsStore((s) => s.toolStatus)
  const toolError = useSettingsStore((s) => s.toolError)
  const checkingTools = useSettingsStore((s) => s.checkingTools)

  const missingKeys: string[] = []
  const reasons: string[] = []
  if (transcription.provider === 'openrouter' && !openrouter) missingKeys.push('Transcription: add an OpenRouter key.')
  if (planning.source === 'cloud' && planning.cloudProvider === 'openrouter' && !openrouter) {
    missingKeys.push('Clip planning: add an OpenRouter key.')
  }
  const planningState = planningStatus(planning, planningKeys)
  if (planning.source !== 'cloud' || planning.cloudProvider !== 'openrouter') {
    if (!planningState.configured) reasons.push(`Clip planning: ${planningState.reason ?? 'finish the setup in Settings.'}`)
  }
  if (transcription.provider === 'local' && tools?.localTranscriptionRequested) {
    if (!tools.localTranscriptionRuntime) reasons.push('Transcription: the local runtime is not installed.')
    else if (!tools.localTranscriptionModel) reasons.push('Transcription: download the selected model in Settings.')
  }

  const toolsOk = toolError ? false : tools
    ? tools.python && tools.pythonDeps && tools.ffmpeg && tools.ffprobe && tools.ytdlp && tools.engine && tools.bridgeRunner
    : null
  return {
    ready: missingKeys.length === 0 && reasons.length === 0 && toolsOk === true && !checkingTools,
    missingKeys,
    reasons,
    toolsOk
  }
}
