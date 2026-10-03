import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'
import { Select } from './ui/Select'
import { cn } from '../lib/utils'
import type { PlanningModelsResult, PlanningProviderId } from '../../shared/planning'

/**
 * Provider model list with Refresh. A failed refresh keeps the previous list
 * and shows why; model ids are shown exactly as returned.
 */
export function PlanningModelPicker({
  target,
  value,
  onChange,
  ariaLabel,
  disabled = false
}: {
  target: PlanningProviderId
  value: string
  onChange: (modelId: string) => void
  ariaLabel: string
  disabled?: boolean
}): React.JSX.Element {
  const [result, setResult] = useState<PlanningModelsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setLoading(true)
    try {
      setResult(await getApi().planning.models(refresh, target))
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not load models from this provider'))
    } finally {
      setLoading(false)
    }
  }, [target])

  useEffect(() => { void load(false) }, [load])

  const options = (result?.models ?? []).map((model) => ({ value: model, label: model }))
  const listError = error ?? result?.error ?? null

  return (
    <div>
      <div className="flex items-center gap-2">
        <Select
          className="min-w-0 flex-1"
          aria-label={ariaLabel}
          value={value}
          options={options}
          placeholder={options.length ? 'Pick a model' : 'No models loaded'}
          searchable={options.length > 8}
          disabled={disabled}
          onChange={onChange}
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
          disabled={disabled || loading}
          onClick={() => void load(true)}
        >
          Refresh models
        </Button>
      </div>
      {listError && <p role="alert" className="mt-1.5 text-2xs text-warning">{listError}</p>}
      {!listError && result && result.models.length > 0 && (
        <p className="mt-1.5 text-2xs text-ink-subtle">{result.models.length} model{result.models.length === 1 ? '' : 's'} from this provider.</p>
      )}
    </div>
  )
}
