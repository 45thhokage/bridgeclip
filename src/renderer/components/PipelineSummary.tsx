import { useSettingsStore } from '../store/use-settings-store'
import { StatusDot } from './ui/Badge'
import { Button } from './ui/Button'
import { planningStageLabel, planningStatus } from '../../shared/planning'
import { transcriptionStageLabel } from '../../shared/transcription'

/**
 * The Create screen's at-a-glance line: both stage sources, a dot per stage
 * that is ready, and a link to where the sources are switched.
 */
export function PipelineSummary({ onOpenSettings, className }: { onOpenSettings: () => void; className?: string }): React.JSX.Element {
  const transcription = useSettingsStore((s) => s.transcription)
  const planning = useSettingsStore((s) => s.planning)
  const openrouterConfigured = useSettingsStore((s) => s.openrouterConfigured)
  const planningKeysConfigured = useSettingsStore((s) => s.planningKeysConfigured)
  const toolStatus = useSettingsStore((s) => s.toolStatus)

  const planningState = planningStatus(planning, planningKeysConfigured)
  const transcriptionReady = transcription.provider === 'openrouter'
    ? openrouterConfigured
    : Boolean(toolStatus?.localTranscriptionRuntime && toolStatus.localTranscriptionModel)
  const transcriptionLabel = transcriptionStageLabel(transcription)
  const planningLabel = planningStageLabel(planning)

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-ink-muted ${className ?? ''}`}>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot active={transcriptionReady} />
        <span className="truncate" title={`Transcription: ${transcriptionLabel}`}>Transcription: {transcriptionLabel}</span>
      </span>
      <span aria-hidden className="text-ink-faint">·</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot active={planningState.configured} />
        <span className="truncate" title={`Planning: ${planningLabel}`}>Planning: {planningLabel}</span>
      </span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpenSettings}>Settings</Button>
    </div>
  )
}
