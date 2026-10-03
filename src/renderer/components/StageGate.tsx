import type { ReactNode } from 'react'
import { Button } from './ui/Button'

interface StageGateProps {
  /** When true, the children are dimmed and truly unfocusable. */
  locked: boolean
  /** One line telling the user which stage blocks the content. */
  message: string
  actionLabel: string
  onUnlock: () => void
  children: ReactNode
  label: string
}

/**
 * Dimmed gray-out for a block whose stage is set to the other source.
 *
 * `inert` removes the content from the tab order and blocks pointer events,
 * `aria-disabled` carries the state to assistive technology, and the visible
 * message with a flip button stays interactive outside the inert wrapper.
 * Note: `inert` is supported by current Chromium; React 19 writes it as an
 * HTML boolean attribute.
 */
export function StageGate({ locked, message, actionLabel, onUnlock, children, label }: StageGateProps): React.JSX.Element {
  if (!locked) return <section aria-label={label}>{children}</section>
  return (
    <section aria-label={label} aria-disabled="true">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2">
        <p className="text-xs text-ink-muted">{message}</p>
        <Button size="sm" variant="secondary" onClick={onUnlock}>{actionLabel}</Button>
      </div>
      <div inert className="pointer-events-none mt-2 opacity-45 saturate-50 select-none">
        {children}
      </div>
    </section>
  )
}
