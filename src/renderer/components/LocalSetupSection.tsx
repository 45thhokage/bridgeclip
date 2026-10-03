import { HardDrive } from 'lucide-react'
import { useSettingsStore } from '../store/use-settings-store'
import { IconTile } from './ui/IconTile'
import { PanelHeader } from './ui/Panel'
import { LocalTranscriptionBlock } from './TranscriptionBlocks'
import { LocalPlanningBlock } from './LocalPlanningBlock'
import { StageGate } from './StageGate'

/** Settings → Local setup: local transcription and the local clip-planning server. */
export function LocalSetupSection(): React.JSX.Element {
  const planning = useSettingsStore((s) => s.planning)
  const transcriptionProvider = useSettingsStore((s) => s.transcription.provider)
  const saveTranscription = useSettingsStore((s) => s.saveTranscription)
  const savePlanning = useSettingsStore((s) => s.savePlanning)

  return (
    <>
      <PanelHeader
        icon={<IconTile><HardDrive /></IconTile>}
        title="Local setup"
        description="Run a stage on this computer. BridgeClip connects to what you already installed; it never installs or starts models."
      />

      <div className="mt-4 space-y-4">
        <StageGate
          label="Local transcription"
          locked={transcriptionProvider === 'openrouter'}
          message="Transcription is set to Cloud API. Switch it to Local to edit this."
          actionLabel="Use Local"
          onUnlock={() => void saveTranscription({ provider: 'local' })}
        >
          <LocalTranscriptionBlock />
        </StageGate>

        <StageGate
          label="Local clip planning server"
          locked={planning.source === 'cloud'}
          message="Clip planning is set to Cloud API. Switch it to Local to edit this."
          actionLabel="Use Local"
          onUnlock={() => void savePlanning({ source: 'local' })}
        >
          <LocalPlanningBlock />
        </StageGate>
      </div>
    </>
  )
}
