import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Download, Loader2, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import { useSettingsStore } from '../store/use-settings-store'
import { Badge, StatusDot } from './ui/Badge'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from './ui/ConfirmDialog'
import { ProgressBar } from './ui/ProgressBar'
import { Select } from './ui/Select'
import {
  GPU_FAMILY_OPTIONS,
  GPU_HINT,
  VRAM_OPTIONS,
  type LocalModelId,
  type ModelDownloadState,
  type TranscriptionOverview
} from '../../shared/transcription'

/** Size labels rounded like the catalog's real snapshot totals. */
function sizeLabel(approxSizeMB: number): string {
  return approxSizeMB >= 1000 ? `${(approxSizeMB / 1000).toFixed(1)} GB` : `${approxSizeMB} MB`
}

/** The cloud half of the Transcription block (dimmed when Transcription is Local). */
export function CloudTranscriptionBlock(): React.JSX.Element {
  return (
    <p className="text-xs leading-relaxed text-ink-muted">
      Audio is transcribed in the cloud by the model for the selected clipping mode: MAI Transcribe 2 in Quality and
      Advanced, Whisper Turbo in Economy. Audio goes to OpenRouter.
    </p>
  )
}

/**
 * The local half of the Transcription block: GPU picker, runtime status, the
 * model catalog with downloads and the selected model.
 */
export function LocalTranscriptionBlock({ onStatusChange }: {
  /** Reports whether the runtime and the selected model are ready to run. */
  onStatusChange?: (status: { runtimeInstalled: boolean; modelDownloaded: boolean }) => void
} = {}): React.JSX.Element {
  const transcription = useSettingsStore((s) => s.transcription)
  const saveTranscription = useSettingsStore((s) => s.saveTranscription)
  const loadSettings = useSettingsStore((s) => s.load)
  const [overview, setOverview] = useState<TranscriptionOverview | null>(null)
  const [download, setDownload] = useState<ModelDownloadState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setOverview(await getApi().transcription.overview())
    } catch (err) {
      setError(errorMessage(err, 'Could not read the local transcription setup'))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!overview) return
    onStatusChange?.({
      runtimeInstalled: overview.runtimeInstalled === true,
      modelDownloaded: Boolean(overview.models.find((model) => model.active)?.downloaded)
    })
  }, [overview, onStatusChange])

  useEffect(() => getApi().transcription.onDownloadProgress((state) => {
    setDownload(state)
    // A finished or failed download changes what is on disk.
    if (state.percent >= 100 || state.failed) void refresh()
  }), [refresh])

  const commit = async (patch: Partial<TranscriptionOverview['settings']>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setOverview(await saveTranscription(patch))
    } catch (err) {
      setError(errorMessage(err, 'Could not save the transcription setting'))
    } finally {
      setBusy(false)
    }
  }

  const startDownload = async (modelId: LocalModelId): Promise<void> => {
    setError(null)
    const result = await getApi().transcription.download(modelId)
    if (!result.ok) setError(result.error ?? 'Could not start the download')
  }

  const cancelDownload = async (): Promise<void> => {
    await getApi().transcription.cancelDownload()
    setDownload(null)
    await refresh()
  }

  const removeModel = async (modelId: LocalModelId): Promise<void> => {
    try {
      await getApi().transcription.deleteModel(modelId)
      await loadSettings()
      await refresh()
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the model'))
    }
  }

  const copyInstallCommand = async (): Promise<void> => {
    if (!overview) return
    try {
      await navigator.clipboard.writeText(overview.installCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy the command. Select it and copy it manually.')
    }
  }

  const recommended = overview?.recommendation
  const downloading = download && download.percent < 100 && !download.failed ? download : null
  const gpuOption = GPU_FAMILY_OPTIONS.find((option) => option.id === transcription.gpuFamily)

  return (
    <div className="space-y-3">
      <div className="glass-tile rounded-2xl px-3 py-3">
        <p className="text-sm font-medium text-ink">What GPU do you have?</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Select
            aria-label="GPU family"
            value={transcription.gpuFamily}
            options={GPU_FAMILY_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(gpuFamily) => void commit({ gpuFamily: gpuFamily as typeof transcription.gpuFamily })}
          />
          {gpuOption?.nvidia && (
            <Select
              aria-label="GPU memory"
              value={transcription.vram}
              options={VRAM_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
              onChange={(vram) => void commit({ vram: vram as typeof transcription.vram })}
            />
          )}
        </div>
        <p className="mt-2 text-xs text-ink-subtle">{GPU_HINT}</p>
        {recommended && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={3} />
            {recommended.reason}
          </p>
        )}
      </div>

      {overview?.runtimeInstalled === false && (
        <Callout
          tone="warning"
          title="The local transcription runtime is not installed"
          action={<Button size="sm" icon={<RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />} onClick={() => void refresh()}>Check again</Button>}
        >
          <p className="text-xs leading-relaxed text-ink-muted">
            Install it once into the Python environment BridgeClip already uses, then select Check again:
          </p>
          <div className="mt-2 flex items-start gap-2">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-black/20 p-2 font-mono text-2xs text-ink" data-selectable>
              <code>{overview.installCommand}</code>
            </pre>
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              onClick={() => void copyInstallCommand()}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Callout>
      )}

      <div className="space-y-2">
        {(overview?.models ?? []).map((model) => {
          const isDownloading = downloading?.modelId === model.id
          const failed = download?.modelId === model.id && download.failed
          return (
            <div key={model.id} className={cn('glass-tile rounded-2xl px-3 py-2.5', model.active && 'glass-selected')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{model.label}</p>
                    <StatusDot active={model.active} />
                    {model.recommended && <Badge tone="accent">Recommended</Badge>}
                    {model.tag && <Badge>{model.tag}</Badge>}
                    {model.experimental && !model.tag && <Badge tone="warning">Experimental</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{model.description}</p>
                  <p className="mt-1 font-mono text-2xs text-ink-subtle">
                    {sizeLabel(model.approxSizeMB)} · {model.license}
                    {model.downloaded ? ' · Downloaded' : ''}
                  </p>
                  {model.warning && (
                    <p className="mt-1 flex items-center gap-1.5 text-2xs text-warning">
                      <TriangleAlert className="h-3 w-3" /> {model.warning}
                    </p>
                  )}
                  {isDownloading && (
                    <div className="mt-2">
                      <ProgressBar value={downloading.percent} />
                      <p className="mt-1 font-mono text-2xs text-ink-subtle">Downloading… {downloading.percent}%</p>
                    </div>
                  )}
                  {failed && <p className="mt-1 text-2xs text-danger">{download.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isDownloading ? (
                    <Button size="sm" variant="ghost" onClick={() => void cancelDownload()}>Cancel</Button>
                  ) : model.downloaded ? (
                    <>
                      <Button
                        size="sm"
                        variant={model.active ? 'secondary' : 'primary'}
                        disabled={model.active || busy}
                        onClick={() => void commit({ localModelId: model.id })}
                      >
                        {model.active ? 'Selected' : 'Use this model'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        aria-label={`Delete ${model.label}`}
                        disabled={busy}
                        onClick={() => setConfirm({
                          title: `Delete ${model.label}?`,
                          body: 'The downloaded model files are removed from this computer. You can download them again later.',
                          confirmLabel: 'Delete',
                          onConfirm: () => void removeModel(model.id)
                        })}
                      />
                    </>
                  ) : (
                    <Button
                      size="sm"
                      icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      disabled={Boolean(downloading) || busy}
                      onClick={() => void startDownload(model.id)}
                    >
                      Download
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
