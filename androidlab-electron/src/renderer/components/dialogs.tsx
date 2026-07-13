/**
 * Non-modal-feeling feedback dialogs (a themed message box + a text prompt) and
 * a transient toast — the web equivalents of the QMessageBox / QInputDialog /
 * toast patterns used across ui.py, with an optional "Open Folder" action.
 */
import { useEffect, useRef, useState } from 'react'

export interface MessageBoxSpec {
  title: string
  body: string
  /** local folder to reveal via an "Open Folder" button */
  dir?: string
}

export function MessageBox({ spec, onClose }: { spec: MessageBoxSpec; onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="msgbox" onMouseDown={(e) => e.stopPropagation()}>
        <div className="title">{spec.title}</div>
        <div className="body">{spec.body}</div>
        <div className="buttons">
          {spec.dir ? (
            <button onClick={() => void window.androidlab.system.openPath(spec.dir!)}>Open Folder</button>
          ) : null}
          <button className="start" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

export function PromptDialog({
  title,
  label,
  initial,
  onSubmit,
  onCancel
}: {
  title: string
  label: string
  initial: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = (): void => {
    const v = value.trim()
    if (v) onSubmit(v)
    else onCancel()
  }
  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="msgbox" onMouseDown={(e) => e.stopPropagation()}>
        <div className="title">{title}</div>
        <div className="body" style={{ overflow: 'visible' }}>
          <div style={{ marginBottom: 8 }}>{label}</div>
          <input
            ref={ref}
            type="text"
            value={value}
            style={{ width: '100%' }}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              else if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
        <div className="buttons">
          <button onClick={onCancel}>Cancel</button>
          <button className="start" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Yes',
  onConfirm,
  onCancel
}: {
  title: string
  body: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="msgbox" onMouseDown={(e) => e.stopPropagation()}>
        <div className="title">{title}</div>
        <div className="body">{body}</div>
        <div className="buttons">
          <button onClick={onCancel}>No</button>
          <button className="start" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toast({ message }: { message: string }) {
  return <div className="toast">{message}</div>
}
