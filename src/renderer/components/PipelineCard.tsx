import { AudioLines, ListFilter, Lock, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../store/use-settings-store'
import { StatusDot } from './ui/Badge'
import { Segmented } from './ui/Segmented'
import { IconTile } from './ui/IconTile'
import { PanelHeader } from './ui/Panel'
import { localModel } from '../../shared/transcription'
import { pipelinePrivacyLine, planningStageLabel, type PlanningSource } from '../../shared/planning'

/** The per-stage source toggles: the only place a pipeline source is switched. */
export function PipelineCard(): React.JSX.Element {
  const transcription = useSettingsStore((s) => s.transcription)
  const planning = useSettingsStore((s) => s.planning)
  const openrouterConfigured = useSettingsStore((s) => s.openrouterConfigured)
  const saveTranscription = useSettingsStore((s) => s.saveTranscription)
  const savePlanning = useSettingsStore((s) => s.savePlanning)

  const localModelLabel = transcription.localModelId ? localModel(transcription.localModelId).label : 'choose a model below'
  const transcriptionLabel = transcription.provider === 'local'
    ? `Local - ${localModelLabel}`
    : 'Cloud - OpenRouter'

  const changeTranscription = (provider: 'openrouter' | 'local'): void => {
    if (provider === transcription.provider) return
    // Local needs a model to mean anything; the recommendation is chosen when
    // one is already downloaded in the Local setup section.
    const localModelId = provider === 'local' && !transcription.localModelId ? null : transcription.localModelId
    void saveTranscription({ provider, localModelId })
  }

  return (
    <>
      <PanelHeader
        icon={<IconTile tone="accent"><Sparkles /></IconTile>}
        title="Pipeline"
        description="Each stage chooses its own source. Cloud and local can be mixed freely."
      />
      <div className="mt-4 space-y-2">
        <div className="glass-tile flex flex-wrap items-center justify-between gap-3 rounded-2xl px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <AudioLines className="h-4 w-4 shrink-0 text-ink-subtle" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Transcription</p>
              <p className="truncate text-xs text-ink-muted" title={transcriptionLabel}>{transcriptionLabel}</p>
            </div>
          </div>
          <Segmented<'openrouter' | 'local'>
            size="sm"
            label="Transcription source"
            value={transcription.provider}
            options={[
              { value: 'openrouter', label: <span className="inline-flex items-center gap-1.5">Cloud API <StatusDot active={transcription.provider === 'openrouter'} /></span> },
              { value: 'local', label: <span className="inline-flex items-center gap-1.5">Local <StatusDot active={transcription.provider === 'local'} /></span> }
            ]}
            onChange={changeTranscription}
          />
        </div>

        <div className="glass-tile flex flex-wrap items-center justify-between gap-3 rounded-2xl px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <ListFilter className="h-4 w-4 shrink-0 text-ink-subtle" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Clip planning</p>
              <p className="truncate text-xs text-ink-muted" title={planningStageLabel(planning)}>{planningStageLabel(planning)}</p>
            </div>
          </div>
          <Segmented<PlanningSource>
            size="sm"
            label="Clip planning source"
            value={planning.source}
            options={[
              { value: 'cloud', label: <span className="inline-flex items-center gap-1.5">Cloud API <StatusDot active={planning.source === 'cloud'} /></span> },
              { value: 'local', label: <span className="inline-flex items-center gap-1.5">Local <StatusDot active={planning.source === 'local'} /></span> }
            ]}
            onChange={(source) => void savePlanning({ source })}
          />
        </div>

        <div className="glass-tile flex flex-wrap items-center justify-between gap-3 rounded-2xl px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Lock className="h-4 w-4 shrink-0 text-ink-subtle" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Extras</p>
              <p className="text-xs text-ink-muted">
                {openrouterConfigured ? 'Cloud API (OpenRouter) only' : 'Needs an OpenRouter key'}
              </p>
            </div>
          </div>
          <StatusDot active={openrouterConfigured} />
        </div>
      </div>

      <p className="mt-3 px-1 text-xs leading-relaxed text-ink-subtle">{pipelinePrivacyLine({ transcription, planning })}</p>
      <p className="mt-1 px-1 text-2xs text-ink-subtle">
        Jev review, framing checks, source research and metadata are not switchable; they always use OpenRouter when enabled.
      </p>
    </>
  )
}
