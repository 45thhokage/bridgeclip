import { useState } from 'react'
import { Cloud, Loader2, TriangleAlert } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { useSettingsStore } from '../store/use-settings-store'
import { useProviderKeyDrafts } from '../hooks/use-provider-key-drafts'
import { PROVIDER_LINKS } from '../config/brand'
import { ApiKeyInput } from './ApiKeyInput'
import { Badge, StatusDot } from './ui/Badge'
import { Button } from './ui/Button'
import { Field, TextInput } from './ui/Field'
import { SettingRow } from './ui/SettingRow'
import { Switch } from './ui/Switch'
import { IconTile } from './ui/IconTile'
import { PanelHeader } from './ui/Panel'
import { onRadioKeyDown } from './ui/Segmented'
import { CloudTranscriptionBlock } from './TranscriptionBlocks'
import { PlanningModelPicker } from './PlanningModelPicker'
import { StageGate } from './StageGate'
import { isPlanningModelId, type PlanningCloudProviderId, type PlanningProviderId, type PlanningTestResult } from '../../shared/planning'
import { cn } from '../lib/utils'

/** Every key name the drafts hook accepts. */
type ProviderKeyName = Parameters<ReturnType<typeof useProviderKeyDrafts>['setDraft']>[0]

const OPENCODE_KEY_LINK = 'https://opencode.ai/auth'

/** Settings → Cloud API: the cloud blocks for both stages plus every provider key. */
export function CloudApiSection(): React.JSX.Element {
  const transcription = useSettingsStore((s) => s.transcription)
  const planning = useSettingsStore((s) => s.planning)
  const zernioConfigured = useSettingsStore((s) => s.zernioConfigured)
  const openrouterConfigured = useSettingsStore((s) => s.openrouterConfigured)
  const sourceContextWebResearch = useSettingsStore((s) => s.sourceContextWebResearch)
  const planningKeysConfigured = useSettingsStore((s) => s.planningKeysConfigured)
  const saveTranscription = useSettingsStore((s) => s.saveTranscription)
  const savePlanning = useSettingsStore((s) => s.savePlanning)
  const save = useSettingsStore((s) => s.save)
  const keys = useProviderKeyDrafts()
  const [tests, setTests] = useState<Partial<Record<PlanningProviderId | 'zernio', PlanningTestResult | 'testing'>>>({})
  const [customUrlDraft, setCustomUrlDraft] = useState<string | null>(null)
  const [customModelDraft, setCustomModelDraft] = useState<string | null>(null)
  // A typed id the pattern rejects is never saved; say so rather than leaving
  // a value on screen that is not in effect.
  const customModelDraftInvalid = customModelDraft !== null && customModelDraft.trim() !== '' && !isPlanningModelId(customModelDraft.trim())

  const test = async (target: PlanningProviderId): Promise<void> => {
    setTests((current) => ({ ...current, [target]: 'testing' }))
    const result = await getApi().planning.testConnection(target)
    setTests((current) => ({ ...current, [target]: result }))
  }

  const usedBy = (target: PlanningProviderId): string => {
    const used: string[] = []
    if (target === 'openrouter') {
      used.push('Extras')
      if (transcription.provider === 'openrouter') used.push('Transcription')
      if (planning.source === 'cloud' && planning.cloudProvider === 'openrouter') used.push('Clip planning')
    } else if (planning.source === 'cloud' && planning.cloudProvider === target) {
      used.push('Clip planning')
    }
    return used.join(' / ')
  }

  const keyConfigured = (target: PlanningProviderId): boolean => {
    if (target === 'local') return planningKeysConfigured.local
    return planningKeysConfigured[target]
  }

  const testResult = (target: PlanningProviderId): React.JSX.Element | null => {
    const result = tests[target]
    if (!result) return null
    if (result === 'testing') return <span className="inline-flex items-center gap-1 text-2xs text-ink-subtle"><Loader2 className="h-3 w-3 animate-spin" /> Testing…</span>
    return <span className={cn('text-2xs', result.ok ? 'text-success' : 'text-danger')} role={result.ok ? 'status' : 'alert'}>{result.message}</span>
  }

  const cloudProviderRow = (id: PlanningCloudProviderId, label: string): React.JSX.Element => {
    const selected = planning.source === 'cloud' && planning.cloudProvider === id
    return (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        onKeyDown={onRadioKeyDown}
        onClick={() => void savePlanning({ cloudProvider: id })}
        className={cn('glass-tile glass-tile-hover flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left', selected && 'glass-selected')}
      >
        <span className={cn('h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px]', selected ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_rgb(var(--canvas))]' : 'border-ink-subtle')} />
        <span className="min-w-0 flex-1 text-sm font-medium text-ink">{label}</span>
        <StatusDot active={selected} />
      </button>
    )
  }

  const keyRow = (target: PlanningProviderId, label: string, options: {
    keyName: ProviderKeyName
    placeholder: string
    description: string
    getKeyUrl?: string
  }): React.JSX.Element => {
    const configured = keyConfigured(target)
    const used = usedBy(target)
    return (
      <div key={target} className="glass-tile rounded-2xl px-3 py-2.5">
        <ApiKeyInput
          label={label}
          value={keys.drafts[options.keyName]}
          configured={configured}
          onChange={(value) => keys.setDraft(options.keyName, value)}
          onRemove={() => void keys.remove(options.keyName)}
          onBlur={() => void keys.persist()}
          placeholder={options.placeholder}
          description={options.description}
          getKeyUrl={options.getKeyUrl}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void test(target)} disabled={tests[target] === 'testing'}>
            Test connection
          </Button>
          {testResult(target)}
          <span className="min-w-0 flex-1 text-right text-2xs text-ink-subtle">
            {used ? `Used by: ${used}` : 'Not used by any stage right now.'}
          </span>
          <StatusDot active={Boolean(used)} />
        </div>
      </div>
    )
  }

  return (
    <>
      <PanelHeader
        icon={<IconTile><Cloud /></IconTile>}
        title="Cloud API"
        description="Cloud blocks for each stage, plus every provider key. Keys are encrypted with your system keychain."
      />

      <div className="mt-4 space-y-4">
        <StageGate
          label="Cloud transcription"
          locked={transcription.provider === 'local'}
          message="Transcription is set to Local. Switch it to Cloud API to edit this."
          actionLabel="Use Cloud API"
          onUnlock={() => void saveTranscription({ provider: 'openrouter' })}
        >
          <CloudTranscriptionBlock />
        </StageGate>

        <StageGate
          label="Cloud clip planning"
          locked={planning.source === 'local'}
          message="Clip planning is set to Local. Switch it to Cloud API to edit this."
          actionLabel="Use Cloud API"
          onUnlock={() => void savePlanning({ source: 'cloud' })}
        >
          <div className="space-y-2" role="radiogroup" aria-label="Cloud clip planning provider">
            {cloudProviderRow('openrouter', 'OpenRouter')}
            {cloudProviderRow('opencode-zen', 'OpenCode Zen')}
            {cloudProviderRow('opencode-go', 'OpenCode Go')}
            {cloudProviderRow('custom', 'Custom endpoint')}
          </div>

          {planning.source === 'cloud' && planning.cloudProvider === 'openrouter' && (
            <p className="mt-2 text-xs text-ink-muted">
              OpenRouter uses the Quality, Economy or Advanced model presets you choose on the Create screen.
            </p>
          )}

          {planning.source === 'cloud' && (planning.cloudProvider === 'opencode-zen' || planning.cloudProvider === 'opencode-go') && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-ink-muted">
                OpenAI-compatible endpoint at {planning.cloudProvider === 'opencode-zen' ? 'opencode.ai/zen/v1' : 'opencode.ai/zen/go/v1'}.
                Pick a model from the list; free models may be restricted for third-party apps.
              </p>
              {keyConfigured(planning.cloudProvider) ? (
                <PlanningModelPicker
                  target={planning.cloudProvider}
                  value={planning.cloudModels[planning.cloudProvider]}
                  ariaLabel={`${planning.cloudProvider === 'opencode-zen' ? 'OpenCode Zen' : 'OpenCode Go'} model`}
                  onChange={(modelId) => void savePlanning({
                    cloudModels: { ...planning.cloudModels, [planning.cloudProvider]: modelId }
                  })}
                />
              ) : (
                <p className="text-2xs text-ink-subtle">Save a key for this provider to load its models.</p>
              )}
            </div>
          )}

          {planning.source === 'cloud' && planning.cloudProvider === 'custom' && (
            <div className="mt-3 space-y-3">
              <Field label="Endpoint URL" hint="https:// only. BridgeClip sends transcript text and prompts to this address.">
                <TextInput
                  mono
                  value={customUrlDraft ?? planning.cloudBaseUrl}
                  placeholder="https://example.com/v1"
                  aria-label="Custom endpoint URL"
                  onChange={(event) => setCustomUrlDraft(event.target.value)}
                  onBlur={() => {
                    if (customUrlDraft === null) return
                    void savePlanning({ cloudBaseUrl: customUrlDraft.trim() })
                    setCustomUrlDraft(null)
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                />
              </Field>
              {planning.cloudBaseUrl && !planning.cloudBaseUrl.startsWith('https://') && (
                <p role="alert" className="text-2xs text-danger">The address must start with https://.</p>
              )}
              <Field label="Model id" hint="Type the model id the endpoint expects.">
                <TextInput
                  mono
                  value={customModelDraft ?? planning.cloudModels.custom}
                  placeholder="model-id"
                  aria-label="Custom endpoint model"
                  onChange={(event) => setCustomModelDraft(event.target.value)}
                  onBlur={() => {
                    if (customModelDraft === null || !isPlanningModelId(customModelDraft.trim())) return
                    void savePlanning({ cloudModels: { ...planning.cloudModels, custom: customModelDraft.trim() } })
                    setCustomModelDraft(null)
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                />
              </Field>
              {customModelDraftInvalid && (
                <p role="alert" className="text-2xs text-danger">Model ids use letters, numbers and . _ : / - only (up to 160 characters).</p>
              )}
              <p className="flex items-start gap-1.5 text-2xs text-warning">
                <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                Only connect to services you trust. BridgeClip sends transcript text and prompts to this address.
              </p>
              <PlanningModelPicker
                target="custom"
                value={planning.cloudModels.custom}
                ariaLabel="Custom endpoint model list"
                onChange={(modelId) => void savePlanning({ cloudModels: { ...planning.cloudModels, custom: modelId } })}
              />
            </div>
          )}
        </StageGate>

        <section aria-label="API keys" className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="eyebrow">API keys</p>
            <span className="text-2xs text-ink-subtle">Extras always need the OpenRouter key.</span>
          </div>

          {keyRow('openrouter', 'OpenRouter', {
            keyName: 'openrouterApiKey',
            placeholder: 'sk-or-…',
            description: 'Extras always use it; it covers cloud transcription and OpenRouter clip planning when those are selected.',
            getKeyUrl: PROVIDER_LINKS.openrouter
          })}
          {keyRow('opencode-zen', 'OpenCode (Zen)', {
            keyName: 'opencodeZenApiKey',
            placeholder: 'sk-…',
            description: 'Used by clip planning with OpenCode Zen. One OpenCode key works for Zen and Go; they are stored separately.',
            getKeyUrl: OPENCODE_KEY_LINK
          })}
          {keyRow('opencode-go', 'OpenCode (Go)', {
            keyName: 'opencodeGoApiKey',
            placeholder: 'sk-…',
            description: 'Used by clip planning with OpenCode Go.',
            getKeyUrl: OPENCODE_KEY_LINK
          })}
          {keyRow('custom', 'Custom endpoint (optional key)', {
            keyName: 'planningCustomApiKey',
            placeholder: 'optional',
            description: 'Some custom endpoints need a bearer key.'
          })}
          {keyRow('local', 'Local server (optional key)', {
            keyName: 'planningLocalApiKey',
            placeholder: 'optional',
            description: 'Only needed when your local server requires a key.'
          })}

          <p className="eyebrow px-1 pt-2">Optional</p>
          <div className="glass-tile rounded-2xl px-3 py-2.5">
            <ApiKeyInput
              label="Zernio (optional)"
              value={keys.drafts.zernioApiKey}
              configured={zernioConfigured}
              onChange={(value) => keys.setDraft('zernioApiKey', value)}
              onRemove={() => void keys.remove('zernioApiKey')}
              onBlur={() => void keys.persist()}
              placeholder="sk_…"
              description="Connects your social accounts so you can post and schedule clips. Manage them under Accounts."
              getKeyUrl={PROVIDER_LINKS.zernio}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <span className="text-2xs text-ink-subtle">Not used by any pipeline stage.</span>
              <Badge>Posting</Badge>
            </div>
          </div>
          {keys.error && <p role="alert" className="px-1 text-xs text-danger">{keys.error}</p>}

          <p className="eyebrow px-1 pt-2">Extras</p>
          <SettingRow
            title={<span>Research the source before clipping <Badge tone="warning" className="ml-1 align-middle">Beta</Badge></span>}
            description={openrouterConfigured
              ? 'Sends the video’s title, description and channel to OpenRouter web search before transcription. Adds provider time and cost.'
              : 'Needs an OpenRouter key. Extras always use OpenRouter.'}
            control={<Switch
              label="Research the source before clipping"
              checked={sourceContextWebResearch === 'on'}
              disabled={!openrouterConfigured}
              onChange={(on) => void save({ sourceContextWebResearch: on ? 'on' : 'off' })}
            />}
          />
        </section>
      </div>
    </>
  )
}
