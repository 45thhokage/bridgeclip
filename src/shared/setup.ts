/**
 * First-launch setup signals.
 *
 * The setup card is for a fresh install that has nothing configured yet. A
 * user whose settings already carry any provider key, a downloaded local
 * transcription model or a configured local planning server must never see it
 * again, so the check is a pure function of saved settings.
 */

import type { PlanningKeyName, PlanningSettings } from './planning'
import type { TranscriptionSettings } from './transcription'

export interface SetupSignals {
  openrouterConfigured: boolean
  planningKeysConfigured: Partial<Record<PlanningKeyName | 'openrouter', boolean>>
  transcription: Pick<TranscriptionSettings, 'localModelId'>
  planning: Pick<PlanningSettings, 'local'>
}

/** True only for a fresh configuration with no key and no local stage set up. */
export function needsFirstRunSetup(signals: SetupSignals): boolean {
  if (signals.openrouterConfigured) return false
  if (Object.values(signals.planningKeysConfigured).some((configured) => configured === true)) return false
  if (signals.transcription.localModelId) return false
  if (signals.planning.local.modelId) return false
  return true
}
