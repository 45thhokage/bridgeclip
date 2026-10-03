import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Cloud, Laptop, KeyRound, ShieldCheck } from 'lucide-react'
import { useSettingsStore } from '../store/use-settings-store'
import { useSetupStore } from '../store/use-setup-store'
import { useProviderKeyDrafts } from '../hooks/use-provider-key-drafts'
import { getApi } from '../lib/ipc'
import { PROVIDER_LINKS } from '../config/brand'
import { cn } from '../lib/utils'
import { ApiKeyInput } from './ApiKeyInput'
import { Button } from './ui/Button'
import { IconTile } from './ui/IconTile'
import { StatusDot } from './ui/Badge'
import { LocalTranscriptionBlock } from './TranscriptionBlocks'
import { LocalPlanningBlock } from './LocalPlanningBlock'
import { needsFirstRunSetup } from '../../shared/setup'
import { planningStageLabel, planningStatus, type PlanningCloudProviderId, type PlanningTestResult } from '../../shared/planning'
import { transcriptionStageLabel } from '../../shared/transcription'
import type { ApiKeyName } from '../../preload/index'

const OPENCODE_KEY_LINK = 'https://opencode.ai/auth'

const STEP_TITLES = ['Transcription', 'Clip planning', 'Summary'] as const

/**
 * First-run setup, inline on the Create page: three steps that configure the
 * two pipeline stages independently. A fresh install sees it once; closing it
 * ("Later" or Finish) keeps it away until "Run setup again" in Settings.
 */
export function SetupCard({ onOpenSettings, className }: { onOpenSettings: () => void; className?: string }): React.JSX.Element | null {
  const open = useSetupStore((s) => s.open)
  const dismissed = useSetupStore((s) => s.dismissed)
  const dismiss = useSetupStore((s) => s.dismissSetup)
  const closeSetup = useSetupStore((s) => s.closeSetup)

  const transcription = useSettingsStore((s) => s.transcription)
  const planning = useSettingsStore((s) => s.planning)
  const openrouterConfigured = useSettingsStore((s) => s.openrouterConfigured)
  const planningKeysConfigured = useSettingsStore((s) => s.planningKeysConfigured)
  const saveTranscription = useSettingsStore((s) => s.saveTranscription)
  const savePlanning = useSettingsStore((s) => s.savePlanning)

  const [step, setStep] = useState(0)
  const [localTranscription, setLocalTranscription] = useState<{ runtimeInstalled: boolean; modelDownloaded: boolean } | null>(null)
  const [tests, setTests] = useState<Partial<Record<PlanningCloudProviderId | 'local', PlanningTestResult | 'testing'>>>({})
  const keys = useProviderKeyDrafts()

  const firstRun = needsFirstRunSetup({ openrouterConfigured, planningKeysConfigured, transcription, planning })
  const visible = open || (firstRun && !dismissed)

  useEffect(() => {
    if (open) setStep(0)
  }, [open])

  const runTest = useCallback(async (target: PlanningCloudProviderId | 'local'): Promise<void> => {
    setTests((current) => ({ ...current, [target]: 'testing' }))
    const result = await getApi().planning.testConnection(target)
    setTests((current) => ({ ...current, [target]: result }))
  }, [])

  const cloudProvider = planning.cloudProvider
  const cloudKeyName: Record<PlanningCloudProviderId, ApiKeyName | null> = {
    openrouter: 'openrouterApiKey',
    'opencode-zen': 'opencodeZenApiKey',
    'opencode-go': 'opencodeGoApiKey',
    custom: null
  }
  const cloudKeyConfigured = cloudProvider === 'openrouter'
    ? openrouterConfigured
    : Boolean(planningKeysConfigured[cloudProvider as keyof typeof planningKeysConfigured])

  // One automatic test per selected cloud provider: Finish requires a tested key,
  // and the button stays available for a manual retry.
  useEffect(() => {
    if (step !== 1 || planning.source !== 'cloud') return
    if (cloudProvider === 'custom' || !cloudKeyConfigured) return
    if (tests[cloudProvider]) return
    void runTest(cloudProvider)
  }, [step, planning.source, cloudProvider, cloudKeyConfigured, tests, runTest])

  const planningState = planningStatus(planning, planningKeysConfigured)
  const planningTarget: PlanningCloudProviderId | 'local' = planning.source === 'local' ? 'local' : cloudProvider
  const planningTest = tests[planningTarget]
  const planningReady = planningState.configured && Boolean(planningTest && planningTest !== 'testing' && planningTest.ok)
  const transcriptionReady = transcription.provider === 'openrouter'
    ? openrouterConfigured
    : Boolean(localTranscription?.runtimeInstalled && localTranscription.modelDownloaded)

  if (!visible) return null

  const transcriptionKeyInput = (
    <ApiKeyInput
      label="OpenRouter key"
      value={keys.drafts.openrouterApiKey}
      configured={openrouterConfigured}
      onChange={(value) => keys.setDraft('openrouterApiKey', value)}
      onRemove={() => void keys.remove('openrouterApiKey')}
      onBlur={() => void keys.persist()}
      placeholder="sk-or-…"
      description="One key covers cloud transcription, OpenRouter clip planning and Extras."
      getKeyUrl={PROVIDER_LINKS.openrouter}
    />
  )

  return (
    <section
      className={cn(
        'glass relative overflow-hidden rounded-3xl bg-accent/[0.05] animate-fade-in',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.08),inset_0_0_0_1px_rgb(var(--accent)/0.22)]',
        className
      )}
      aria-label="Finish setup"
    >
      <div className="relative flex items-start gap-3 p-3.5">
        <IconTile tone="accent">
          <KeyRound />
        </IconTile>
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-accent">One-time setup · Step {step + 1} of {STEP_TITLES.length}</p>
          <h2 className="mt-0.5 text-base font-semibold text-ink">
            {step === 0 ? 'How should transcription run?' : step === 1 ? 'How should clip planning run?' : 'You are ready to clip'}
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-ink-muted">
            {step === 0
              ? 'Cloud API sends the audio to OpenRouter; Local transcribes on this computer. Clip planning is chosen separately in the next step.'
              : step === 1
                ? 'Each stage picks its own source. Cloud and local can be mixed freely.'
                : 'Both stages are set. You can change any of this later in Settings.'}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={dismiss}>Later</Button>
      </div>

      <div className="relative mx-3 mb-3 space-y-3 rounded-xl bg-black/15 p-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        {step === 0 && (
          <>
            <div role="radiogroup" aria-label="Transcription source" className="grid gap-2 md:grid-cols-2">
              <OptionCard
                selected={transcription.provider === 'openrouter'}
                onSelect={() => void saveTranscription({ provider: 'openrouter' })}
                icon={<Cloud />}
                title="Cloud API"
                description="OpenRouter transcribes the audio with MAI Transcribe 2 or Whisper Turbo. Fast, no download."
              >
                {transcriptionKeyInput}
              </OptionCard>
              <OptionCard
                selected={transcription.provider === 'local'}
                onSelect={() => void saveTranscription({ provider: 'local' })}
                icon={<Laptop />}
                title="Local"
                description="Runs on this computer with a downloaded model. The audio never leaves it."
              >
                <LocalTranscriptionBlock onStatusChange={setLocalTranscription} />
              </OptionCard>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => setStep(1)} disabled={!transcriptionReady}>
                Continue: Clip planning
              </Button>
              <Button
                variant="ghost"
                onClick={() => { void saveTranscription({ provider: 'openrouter' }); setStep(1) }}
                disabled={!openrouterConfigured}
                tooltip={openrouterConfigured ? undefined : 'Add an OpenRouter key to use Cloud API instead.'}
              >
                Finish transcription later with Cloud API
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div role="radiogroup" aria-label="Clip planning source" className="grid gap-2 md:grid-cols-2">
              <OptionCard
                selected={planning.source === 'cloud'}
                onSelect={() => void savePlanning({ source: 'cloud' })}
                icon={<Cloud />}
                title="Cloud API"
                description="OpenRouter, OpenCode Zen, OpenCode Go or a custom endpoint plans the clips."
              >
                <div className="space-y-2" role="radiogroup" aria-label="Cloud planning provider">
                  {(['openrouter', 'opencode-zen', 'opencode-go'] as const).map((id) => (
                    <ProviderRadio
                      key={id}
                      selected={planning.source === 'cloud' && cloudProvider === id}
                      label={id === 'openrouter' ? 'OpenRouter' : id === 'opencode-zen' ? 'OpenCode Zen' : 'OpenCode Go'}
                      onSelect={() => {
                        void savePlanning({ cloudProvider: id })
                        void runTest(id)
                      }}
                    />
                  ))}
                </div>
                {cloudKeyName[cloudProvider] && (
                  <div className="mt-3">
                    <ApiKeyInput
                      label={cloudProvider === 'openrouter' ? 'OpenRouter key' : 'OpenCode key'}
                      value={cloudProvider === 'openrouter' ? keys.drafts.openrouterApiKey : cloudProvider === 'opencode-zen' ? keys.drafts.opencodeZenApiKey : keys.drafts.opencodeGoApiKey}
                      configured={cloudKeyConfigured}
                      onChange={(value) => {
                        const name = cloudKeyName[cloudProvider]
                        if (name) keys.setDraft(name, value)
                      }}
                      onRemove={() => {
                        const name = cloudKeyName[cloudProvider]
                        if (name) void keys.remove(name)
                      }}
                      onBlur={() => void keys.persist()}
                      placeholder="sk-…"
                      description="Stored encrypted on this computer. One OpenCode key works for Zen and Go."
                      getKeyUrl={cloudProvider === 'openrouter' ? PROVIDER_LINKS.openrouter : OPENCODE_KEY_LINK}
                    />
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void runTest(cloudProvider)}
                    disabled={!cloudKeyConfigured || tests[cloudProvider] === 'testing'}
                    tooltip={cloudKeyConfigured ? undefined : 'Save a key for this provider first.'}
                  >
                    Test connection
                  </Button>
                  <TestMessage target={planningTarget} tests={tests} />
                </div>
              </OptionCard>
              <OptionCard
                selected={planning.source === 'local'}
                onSelect={() => void savePlanning({ source: 'local' })}
                icon={<Laptop />}
                title="Local"
                description="Connects to a server you already run: Ollama, LM Studio, llama.cpp or another."
              >
                <LocalPlanningBlock onTestResult={(result) => setTests((current) => ({ ...current, local: result }))} />
              </OptionCard>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => setStep(2)} disabled={!planningReady}>
                Continue: Summary
              </Button>
              <Button
                variant="ghost"
                onClick={() => { void savePlanning({ source: 'cloud', cloudProvider: 'openrouter' }); setStep(2) }}
                disabled={!openrouterConfigured}
                tooltip={openrouterConfigured ? undefined : 'Add an OpenRouter key to plan with OpenRouter instead.'}
              >
                Finish planning later with OpenRouter
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <ul className="space-y-2">
              <SummaryRow label="Transcription" value={transcriptionStageLabel(transcription)} ready={transcriptionReady} />
              <SummaryRow label="Clip planning" value={planningStageLabel(planning)} ready={planningReady} />
            </ul>
            <p className="text-2xs leading-relaxed text-ink-subtle">
              Extras (Jev review, framing checks, source research, metadata) use OpenRouter when you turn them on, so they need an OpenRouter key.
              {openrouterConfigured ? ' Your key is ready.' : ' You can add one later in Settings.'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={closeSetup} disabled={!transcriptionReady || !planningReady}>Finish</Button>
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button variant="ghost" onClick={onOpenSettings}>Open Settings</Button>
            </div>
          </>
        )}
      </div>

      <p className="relative flex items-center gap-1.5 px-3.5 pb-3 text-2xs text-ink-subtle">
        <ShieldCheck className="h-3.5 w-3.5 text-success/80" />
        Keys are encrypted on this computer with your system keychain.
      </p>
      {keys.error && <p role="alert" className="relative -mt-2 px-4 pb-4 text-xs text-danger">{keys.error}</p>}
    </section>
  )
}

function OptionCard({ selected, onSelect, icon, title, description, children }: {
  selected: boolean
  onSelect: () => void
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl p-3 transition-colors duration-200',
        selected
          ? 'bg-accent/[0.06] shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.35)]'
          : 'bg-white/[0.03] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)] hover:bg-white/[0.05]'
      )}
    >
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="flex w-full items-start gap-2.5 text-left">
        <span className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-muted',
          selected ? 'bg-accent/20 text-accent' : 'bg-white/[0.06]'
        )}>
          <span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-ink">
            {title}
            <StatusDot active={selected} />
          </span>
          <span className="mt-0.5 block text-2xs leading-relaxed text-ink-muted">{description}</span>
        </span>
      </button>
      {selected && <div className="mt-3 animate-fade-in">{children}</div>}
    </div>
  )
}

function ProviderRadio({ selected, label, onSelect }: { selected: boolean; label: string; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left', selected ? 'glass-selected glass-tile' : 'glass-tile glass-tile-hover')}
    >
      <span className={cn('h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px]', selected ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_rgb(var(--canvas))]' : 'border-ink-subtle')} />
      <span className="min-w-0 flex-1 text-sm font-medium text-ink">{label}</span>
      <StatusDot active={selected} />
    </button>
  )
}

function TestMessage({ target, tests }: {
  target: PlanningCloudProviderId | 'local'
  tests: Partial<Record<PlanningCloudProviderId | 'local', PlanningTestResult | 'testing'>>
}): React.JSX.Element | null {
  const result = tests[target]
  if (!result) return null
  if (result === 'testing') return <span className="text-2xs text-ink-subtle">Testing…</span>
  return <span className={cn('text-2xs', result.ok ? 'text-success' : 'text-danger')} role={result.ok ? 'status' : 'alert'}>{result.message}</span>
}

function SummaryRow({ label, value, ready }: { label: string; value: string; ready: boolean }): React.JSX.Element {
  return (
    <li className="glass-tile flex items-center gap-2.5 rounded-xl px-3 py-2.5">
      <StatusDot active={ready} />
      <span className="min-w-0 flex-1">
        <span className="block text-2xs text-ink-subtle">{label}</span>
        <span className="block truncate text-sm text-ink" title={value}>{value}</span>
      </span>
    </li>
  )
}
