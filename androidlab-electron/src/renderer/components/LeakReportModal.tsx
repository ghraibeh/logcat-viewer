/**
 * Memory-leak report — the web equivalent of leakdetect.py's LeakDetectWorker +
 * LeakReportWindow, shown as a full-screen modal over the app so a long capture/
 * analyze survives tab switches. While detection runs it streams progress lines
 * (with a Cancel); on success it renders Shark's visual report (banner + metadata
 * tiles + colorized leak traces) with Save-report / Open-.hprof-folder actions.
 *
 * Mounted at the App level (like the mirror dock) so the flow keeps running while
 * the user browses other tabs. The report HTML is built by the pure core module
 * and injected here; its stylesheet ships inline from the same core source.
 */
import { useEffect, useRef, useState } from 'react'
import {
  LEAK_REPORT_CSS,
  buildReportBody,
  buildReportDocument,
  leakSummary,
  type LeakPalette
} from '@core/leakdetect'
import { PALETTE } from '../theme'
import type { LeakDone, SaveResult } from '@shared/types'

type Phase = 'running' | 'ok' | 'error'

const palette = (): LeakPalette => ({
  BG: PALETTE.BG,
  SURFACE: PALETTE.SURFACE,
  SURFACE_2: PALETTE.SURFACE_2,
  BORDER: PALETTE.BORDER,
  TEXT: PALETTE.TEXT,
  TEXT_DIM: PALETTE.TEXT_DIM,
  ACCENT: PALETTE.ACCENT,
  GREEN: PALETTE.GREEN,
  RED: PALETTE.RED,
  AMBER: PALETTE.AMBER
})

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))

export function LeakReportModal({
  serial,
  pkg,
  onClose,
  onSaved
}: {
  serial: string
  pkg: string
  onClose: () => void
  onSaved: (r: SaveResult) => void
}) {
  const [phase, setPhase] = useState<Phase>('running')
  const [progress, setProgress] = useState('Starting…')
  const [report, setReport] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [hprofPath, setHprofPath] = useState('')
  const startedRef = useRef(false)

  // Subscribe first, then kick off the run once (StrictMode double-invoke safe).
  useEffect(() => {
    const offProgress = window.androidlab.leak.onProgress((m) => setProgress(m))
    const offDone = window.androidlab.leak.onDone((d: LeakDone) => {
      setHprofPath(d.hprofPath)
      if (d.ok) {
        setReport(d.report)
        setPhase('ok')
      } else {
        setErrorMsg(d.report)
        setPhase('error')
      }
    })
    if (!startedRef.current) {
      startedRef.current = true
      void window.androidlab.leak.start(serial, pkg)
    }
    return () => {
      offProgress()
      offDone()
    }
  }, [serial, pkg])

  const close = (): void => {
    if (phase === 'running') void window.androidlab.leak.cancel()
    onClose()
  }

  const save = async (): Promise<void> => {
    const doc = buildReportDocument(pkg, report, palette())
    const r = await window.androidlab.leak.saveReport(doc, pkg)
    if (r.message !== 'cancelled') onSaved(r)
  }

  const headline = phase === 'ok' ? leakSummary(report) : phase === 'error' ? 'Detection failed' : 'Detecting…'
  const leaks = phase === 'ok' && !headline.startsWith('No application')
  const dotColor = phase === 'error' || leaks ? PALETTE.RED : phase === 'ok' ? PALETTE.GREEN : PALETTE.ACCENT

  return (
    <div className="scrim" onMouseDown={close}>
      <style>{LEAK_REPORT_CSS}</style>
      <div className="leak-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="leak-bar">
          <span className="leak-dot" style={{ color: dotColor }}>
            ●
          </span>
          <span className="leak-title">
            {pkg}
            <span className="leak-sep">·</span>
            {headline}
          </span>
          <span className="grow" />
          {phase === 'ok' ? (
            <>
              <button onClick={() => void save()}>Save report…</button>
              <button
                disabled={!hprofPath}
                onClick={() => void window.androidlab.system.openPath(dirOf(hprofPath))}
              >
                Open .hprof folder
              </button>
            </>
          ) : null}
          <button className="start" onClick={close}>
            {phase === 'running' ? 'Cancel' : 'Close'}
          </button>
        </div>

        {phase === 'running' ? (
          <div className="leak-progress">
            <div className="leak-spinner" />
            <div className="leak-status">{progress}</div>
            <div className="leak-hint">
              Capturing a managed heap dump, pulling it, and analyzing with LeakCanary&apos;s Shark.
              The app must be <b>debuggable</b> (or the device rooted). First run downloads the
              analyzer — later runs are faster.
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="leak-error">
            <div className="leak-error-head">⚠️ Couldn&apos;t detect leaks</div>
            <pre className="leak-error-body">{errorMsg}</pre>
          </div>
        ) : (
          <div
            className="leak-report leak-report-scroll"
            dangerouslySetInnerHTML={{ __html: buildReportBody(pkg, report) }}
          />
        )}
      </div>
    </div>
  )
}
