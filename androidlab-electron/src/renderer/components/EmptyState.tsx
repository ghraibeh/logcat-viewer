/**
 * Shared guided-placeholder used wherever a pane would otherwise be blank
 * (the Logs work area, the Databases tree/results, …). It renders one visual
 * language — a glyph tile, a title, a short body, optional action buttons and a
 * hint — so every "nothing here yet" state across the app reads the same. The
 * caller supplies the copy + wired actions; scenario logic stays in each view.
 */
import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface EmptyAction {
  label: string
  icon?: IconName
  primary?: boolean
  onClick: () => void
}

export interface EmptyStateProps {
  icon?: IconName
  /** Green animated "listening" ring instead of the neutral glyph tile. */
  pulse?: boolean
  /** Warm (red) glyph tile for error / can't-do states. */
  tone?: 'accent' | 'warn'
  /** Tighter sizing for narrow side panels (e.g. the DB schema tree). */
  compact?: boolean
  title: string
  body?: ReactNode
  actions?: EmptyAction[]
  hint?: string
}

export function EmptyState({
  icon,
  pulse,
  tone = 'accent',
  compact,
  title,
  body,
  actions,
  hint
}: EmptyStateProps) {
  const glyphSize = compact ? 24 : 30
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      {pulse ? (
        <div className="pulse-ring">{icon ? <Icon name={icon} size={compact ? 22 : 26} /> : null}</div>
      ) : icon ? (
        <div className={`glyph${tone === 'warn' ? ' warn' : ''}`}>
          <Icon name={icon} size={glyphSize} />
        </div>
      ) : null}
      <div className="title">{title}</div>
      {body ? <div className="body">{body}</div> : null}
      {actions && actions.length ? (
        <div className="actions">
          {actions.map((a) => (
            <button key={a.label} className={a.primary ? 'primary' : undefined} onClick={a.onClick}>
              {a.icon ? <Icon name={a.icon} size={15} /> : null}
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}
