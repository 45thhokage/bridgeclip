import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { promisify } from 'util'
import { createInterface } from 'readline'
import { getBridgeRunnerPath, getEnginePath, preflightCheck, resolvePythonPath, runtimeEnvironment } from './pipeline-runner'
import { loadSettings, type AppSettings } from './settings-store'
import { logger } from './logger'
import {
  LOCAL_TRANSCRIPTION_MODELS,
  LOCAL_MODEL_TAGS,
  isLocalModelId,
  localModel,
  localModelWarning,
  recommendTranscription,
  type LocalModelId,
  type LocalModelStatus,
  type ModelDownloadState,
  type TranscriptionOverview,
  type TranscriptionRecommendation,
  type TranscriptionSettings
} from '../shared/transcription'

const execFileAsync = promisify(execFile)

/**
 * Local transcription models live in one folder under the app data directory.
 * Main owns that folder: the renderer can only name a catalog id, never a
 * repository, URL or path. Downloads run as their own short-lived bridge
 * process, so they never take a clipping slot.
 */

export type { LocalModelStatus, ModelDownloadState, TranscriptionOverview }

let activeDownload: { modelId: LocalModelId; process: ChildProcess; state: ModelDownloadState } | null = null

export function modelsRoot(): string {
  const root = join(app.getPath('userData'), 'models')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid local model directory')
  return root
}

/** The one folder a model id may name. Anything outside the root is rejected. */
export function modelDirectory(modelId: LocalModelId): string {
  if (!isLocalModelId(modelId)) throw new Error('Unknown local transcription model')
  const root = resolve(modelsRoot())
  const dir = resolve(join(root, modelId))
  if (dir === root || !dir.startsWith(`${root}${sep}`)) throw new Error('Invalid local model directory')
  return dir
}

function modelDownloaded(modelId: LocalModelId): boolean {
  try {
    const dir = modelDirectory(modelId)
    return existsSync(dir) && readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/** Whether the model selected in Settings is on disk. */
export function selectedModelDownloaded(settings: AppSettings): boolean {
  const id = settings.transcription.localModelId
  return isLocalModelId(id) ? modelDownloaded(id) : false
}

export function transcriptionRecommendation(settings: TranscriptionSettings): TranscriptionRecommendation {
  return recommendTranscription(settings.gpuFamily, settings.vram)
}

export function getDownloadState(): ModelDownloadState | null {
  return activeDownload?.state ?? null
}

export function listLocalModels(settings: AppSettings): LocalModelStatus[] {
  const transcription = settings.transcription
  const recommendation = transcriptionRecommendation(transcription)
  const alsoAvailable = new Set(recommendation.alsoAvailable)
  return LOCAL_TRANSCRIPTION_MODELS.map((model) => ({
    ...model,
    downloaded: modelDownloaded(model.id),
    recommended: model.id === recommendation.recommendedModelId,
    // The recommendation decides which alternatives carry their speed label.
    tag: alsoAvailable.has(model.id) ? LOCAL_MODEL_TAGS[model.id] ?? null : null,
    warning: localModelWarning(model.id, transcription.gpuFamily, transcription.vram),
    active: transcription.localModelId === model.id
  }))
}

/**
 * The exact copy-paste command for the local runtime, matching the interpreter
 * and engine paths this installation actually uses. The CUDA lock is included
 * only for a CUDA recommendation; nothing is installed automatically.
 */
export function localRuntimeInstallCommand(settings: AppSettings = loadSettings()): string {
  const enginePath = getEnginePath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)
  const recommendation = transcriptionRecommendation(settings.transcription)
  const locks = [join(enginePath, 'requirements-local.lock')]
  if (recommendation.device === 'cuda') locks.push(join(enginePath, 'requirements-local-cuda.lock'))
  const quote = (value: string): string => process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`
  const prefix = process.platform === 'win32' ? '& ' : ''
  const python = `${prefix}${quote(pythonPath)}`
  const install = `${python} -m pip install --require-hashes ${locks.map((lock) => `-r ${quote(lock)}`).join(' ')}`
  // uv-created virtual environments ship without pip; bootstrapping it is a
  // harmless no-op when pip is already present.
  return `${python} -m ensurepip\n${install}`
}

export async function checkLocalRuntime(settings: AppSettings = loadSettings()): Promise<boolean> {
  const enginePath = getEnginePath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)
  // The selected backend needs its own module; the Parakeet backend is not
  // covered by faster-whisper's install.
  const id = settings.transcription.localModelId
  const backend = isLocalModelId(id) ? localModel(id).backend : null
  const probe = backend === 'onnx-parakeet' ? 'import onnx_asr' : 'import faster_whisper'
  try {
    await execFileAsync(pythonPath, ['-c', probe], {
      cwd: enginePath,
      env: { ...runtimeEnvironment(), PYTHONPATH: enginePath },
      timeout: 10000
    })
    return true
  } catch {
    return false
  }
}

/** Everything the Settings screen needs in one call. */
export async function localTranscriptionOverview(): Promise<TranscriptionOverview> {
  const settings = loadSettings()
  cleanStaleDownloads()
  const models = listLocalModels(settings)
  // Only pay for the interpreter import when a local model is in play.
  const runtimeInstalled = settings.transcription.provider === 'local' ? await checkLocalRuntime(settings) : null
  return {
    settings: settings.transcription,
    recommendation: transcriptionRecommendation(settings.transcription),
    models,
    download: getDownloadState(),
    runtimeInstalled,
    installCommand: localRuntimeInstallCommand(settings)
  }
}

/**
 * The local model, device and compute type for a job. Main derives these from
 * the catalog and the GPU choice; the renderer never sends them.
 */
export function localTranscriptionJobOptions(settings: AppSettings): Record<string, string | number> {
  if (settings.transcription.provider !== 'local') return {}
  const modelId = settings.transcription.localModelId
  if (!isLocalModelId(modelId)) throw new Error('Choose a local transcription model in Settings')
  const model = localModel(modelId)
  const recommendation = transcriptionRecommendation(settings.transcription)
  const dir = modelDirectory(modelId)
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    throw new Error('Download the selected local transcription model in Settings')
  }
  return {
    transcription_provider: 'local',
    local_transcription_model_id: model.id,
    local_transcription_model_dir: dir,
    local_transcription_backend: model.backend,
    local_transcription_device: recommendation.device,
    local_transcription_compute_type: recommendation.computeType
  }
}

/** Remove half-finished staging folders left by a cancelled or killed download. */
export function cleanStaleDownloads(): void {
  try {
    const root = modelsRoot()
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.includes('.downloading-')) rmSync(join(root, entry.name), { recursive: true, force: true })
    }
  } catch { logger.warn('models.stagingCleanupFailed') }
}

/** Start one catalog model download. Returns an error string when it cannot run. */
export function startModelDownload(modelId: unknown, onProgress: (state: ModelDownloadState) => void): { ok: boolean; error?: string } {
  if (!isLocalModelId(modelId)) return { ok: false, error: 'Unknown local transcription model' }
  if (activeDownload) return { ok: false, error: 'Another model download is already running' }
  const model = localModel(modelId)
  let dir: string
  try {
    dir = modelDirectory(modelId)
  } catch {
    return { ok: false, error: 'Invalid local model directory' }
  }

  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath()
  const settings = loadSettings()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)
  const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
  if (!preflight.ok) return { ok: false, error: preflight.error ?? 'The clipping engine is unavailable' }

  let child: ChildProcess
  try {
    child = spawn(pythonPath, [bridgePath], {
      cwd: enginePath,
      env: {
        ...runtimeEnvironment(),
        PYTHONPATH: enginePath,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
  } catch {
    return { ok: false, error: 'Could not start the model download' }
  }

  const state: ModelDownloadState = { modelId, percent: 0, bytesDone: 0, bytesTotal: 0, failed: false, error: null }
  activeDownload = { modelId, process: child, state }
  const publish = (): void => onProgress({ ...state })

  const fail = (error: string): void => {
    state.failed = true
    state.error = error
    publish()
  }
  const settle = (error: string | null): void => {
    if (activeDownload?.process === child) activeDownload = null
    if (error) fail(error)
    else {
      state.percent = 100
      publish()
    }
  }

  child.stdin?.on('error', () => { /* The close handler reports failures. */ })
  child.stdin?.end(JSON.stringify({
    command: 'download_model',
    model_id: model.id,
    repo: model.repo,
    revision: model.revision,
    model_dir: dir,
    approx_size_mb: model.approxSizeMB
  }))

  let stdoutBytes = 0
  const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null
  lines?.on('line', (line: string) => {
    if (stdoutBytes > 1024 * 1024) return
    stdoutBytes += Buffer.byteLength(line)
    try {
      const message = JSON.parse(line) as { type?: string; percent?: number; bytes_done?: number; bytes_total?: number; message?: string }
      if (message.type === 'progress') {
        state.percent = typeof message.percent === 'number' && Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : state.percent
        state.bytesDone = typeof message.bytes_done === 'number' ? message.bytes_done : state.bytesDone
        state.bytesTotal = typeof message.bytes_total === 'number' ? message.bytes_total : state.bytesTotal
        publish()
      } else if (message.type === 'error') {
        // The bridge's message is already user-safe.
        state.error = typeof message.message === 'string' ? message.message : 'The model download failed'
      }
    } catch { /* Ignore non-protocol lines. */ }
  })
  child.stderr?.on('data', () => { /* Engine logs stay in the child. */ })
  child.on('error', () => settle('Could not start the model download'))
  child.on('close', (code) => {
    if (state.failed) return settle(state.error)
    if (state.error) return settle(state.error)
    settle(code === 0 ? null : 'The model download did not finish')
  })

  logger.info('models.download.start', { modelId: model.id })
  return { ok: true }
}

export function cancelModelDownload(): boolean {
  const active = activeDownload
  if (!active) return false
  const child = active.process
  logger.info('models.download.cancel', { modelId: active.modelId })
  activeDownload = null
  if (!child.pid) return true
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {})
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
  }
  cleanStaleDownloads()
  return true
}

/** Delete one model folder, and only that folder. */
export function deleteModel(modelId: unknown): LocalModelId {
  if (!isLocalModelId(modelId)) throw new Error('Unknown local transcription model')
  const dir = modelDirectory(modelId)
  if (!isAbsolute(dir)) throw new Error('Invalid local model directory')
  const stat = existsSync(dir) ? lstatSync(dir) : null
  if (stat?.isSymbolicLink()) throw new Error('Invalid local model directory')
  if (stat) rmSync(dir, { recursive: true, force: true })
  logger.info('models.delete', { modelId })
  return modelId
}

/** A job failure that the engine reports without local paths gets the fix inline. */
export function localFailureHint(failureCode: string | null | undefined): string | null {
  if (failureCode === 'transcription.local_runtime_missing') {
    return `Install the local transcription runtime, then run again:\n${localRuntimeInstallCommand()}`
  }
  if (failureCode === 'transcription.local_model_missing') {
    return 'Open Settings → Transcription and download the selected model, then run again.'
  }
  if (failureCode === 'transcription.local_gpu_unavailable') {
    return "GPU failed to load. Choose 'AMD, Intel, or no dedicated GPU' in Settings to run on CPU."
  }
  return null
}
