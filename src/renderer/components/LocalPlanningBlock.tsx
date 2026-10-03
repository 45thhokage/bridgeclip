import { useState } from 'react'
import { Loader2, Server } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { useSettingsStore } from '../store/use-settings-store'
import { Button } from './ui/Button'
import { StatusDot } from './ui/Badge'
import { Field, TextInput } from './ui/Field'
import { Select } from './ui/Select'
import { PlanningModelPicker } from './PlanningModelPicker'
import {
  LOCAL_PLANNING_PRESETS,
  PLANNING_CONTEXT_DEFAULT,
  isLoopbackPlanningHost,
  isPlanningModelId,
  localPlanningPreset,
  normalizeContextTokens,
  parsePlanningBaseUrl,
  type LocalPlanningPresetId,
  type PlanningTestResult
} from '../../shared/planning'
import { cn } from '../lib/utils'

/**
 * The local clip-planning server fields, shared by Settings → Local setup and
 * the first-run setup card. BridgeClip never installs or starts a model; it
 * connects to a server the user already runs on this computer.
 */
export function LocalPlanningBlock({ onTestResult }: { onTestResult?: (result: PlanningTestResult) => void }): React.JSX.Element {
  const planning = useSettingsStore((s) => s.planning)
  const savePlanning = useSettingsStore((s) => s.savePlanning)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const [contextDraft, setContextDraft] = useState<string | null>(null)
  const [test, setTest] = useState<PlanningTestResult | 'testing' | null>(null)

  const preset = localPlanningPreset(planning.local.preset)
  // A typed id that the pattern rejects is never saved, so say so instead of
  // leaving a value on screen that is not in effect.
  const modelDraftInvalid = modelDraft !== null && modelDraft.trim() !== '' && !isPlanningModelId(modelDraft.trim())
  const urlInfo = parsePlanningBaseUrl(planning.local.baseUrl)
  const urlError = !urlInfo
    ? 'Enter a full http:// address.'
    : !urlInfo.url.startsWith('http://')
      ? 'A local server uses plain http:// on this computer.'
      : !isLoopbackPlanningHost(urlInfo.hostname)
        ? 'Only 127.0.0.1, ::1 or localhost are allowed for a local server.'
        : null

  const changePreset = (id: LocalPlanningPresetId): void => {
    const chosen = LOCAL_PLANNING_PRESETS.find((option) => option.id === id)
    if (!chosen) return
    const baseUrl = id === 'other' ? planning.local.baseUrl : chosen.baseUrl
    void savePlanning({ local: { ...planning.local, preset: id, baseUrl } })
  }

  const runTest = async (): Promise<void> => {
    setTest('testing')
    const result = await getApi().planning.testConnection('local')
    setTest(result)
    onTestResult?.(result)
  }

  return (
    <div className="space-y-3">
      <Field label={<span className="inline-flex items-center gap-1.5">Server <StatusDot active={planning.source === 'local'} /></span>} hint={preset.hint}>
        <Select
          aria-label="Local planning server"
          value={planning.local.preset}
          options={LOCAL_PLANNING_PRESETS.map((option) => ({ value: option.id, label: option.label }))}
          onChange={(value) => changePreset(value as LocalPlanningPresetId)}
        />
      </Field>

      <Field label="Base URL" hint="Editable. Only a server on this computer is allowed.">
        <TextInput
          mono
          value={urlDraft ?? planning.local.baseUrl}
          placeholder="http://127.0.0.1:11434/v1"
          aria-label="Local planning base URL"
          aria-invalid={Boolean(urlError)}
          onChange={(event) => setUrlDraft(event.target.value)}
          onBlur={() => {
            if (urlDraft === null) return
            const value = urlDraft.trim()
            if (!parsePlanningBaseUrl(value)) {
              setUrlDraft(null)
              return
            }
            void savePlanning({ local: { ...planning.local, baseUrl: value } })
            setUrlDraft(null)
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
      </Field>
      {urlError && <p role="alert" className="text-2xs text-danger">{urlError}</p>}

      <Field label="Model" hint="Pick one from the server or type the id it expects.">
        <div className="space-y-2">
          <TextInput
            mono
            value={modelDraft ?? planning.local.modelId}
            placeholder="model-id"
            aria-label="Local planning model"
            onChange={(event) => setModelDraft(event.target.value)}
            onBlur={() => {
              if (modelDraft === null || !isPlanningModelId(modelDraft.trim())) return
              void savePlanning({ local: { ...planning.local, modelId: modelDraft.trim() } })
              setModelDraft(null)
            }}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
          {modelDraftInvalid && (
            <p role="alert" className="text-2xs text-danger">Model ids use letters, numbers and . _ : / - only (up to 160 characters).</p>
          )}
          {!urlError && (
            <PlanningModelPicker
              target="local"
              value={planning.local.modelId}
              ariaLabel="Local planning model list"
              onChange={(modelId) => void savePlanning({ local: { ...planning.local, modelId } })}
            />
          )}
        </div>
      </Field>

      <Field label="Context window (tokens)" hint="Must match the context size your server is running with. Transcripts that do not fit are refused, never truncated.">
        <TextInput
          mono
          inputMode="numeric"
          value={contextDraft ?? String(planning.local.contextTokens)}
          aria-label="Local planning context window"
          onChange={(event) => setContextDraft(event.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (contextDraft === null) return
            const value = normalizeContextTokens(Number(contextDraft || PLANNING_CONTEXT_DEFAULT))
            void savePlanning({ local: { ...planning.local, contextTokens: value } })
            setContextDraft(null)
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon={<Server className="h-3.5 w-3.5" />} onClick={() => void runTest()} disabled={test === 'testing'}>
          Test connection
        </Button>
        {test === 'testing' && <span className="inline-flex items-center gap-1 text-2xs text-ink-subtle"><Loader2 className="h-3 w-3 animate-spin" /> Testing…</span>}
        {test && test !== 'testing' && (
          <span className={cn('text-2xs', test.ok ? 'text-success' : 'text-danger')} role={test.ok ? 'status' : 'alert'}>{test.message}</span>
        )}
      </div>
      <p className="text-2xs text-ink-subtle">
        Small local models pick clips less reliably than frontier cloud models. If results disappoint, try a larger model or cloud planning.
      </p>
    </div>
  )
}
