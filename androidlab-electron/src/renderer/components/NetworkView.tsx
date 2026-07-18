/**
 * Network HTTP tab — port of intercept.py's InterceptView. A full-width view
 * (follows the device toolbar's serial via c.serial; does NOT follow the app
 * picker — traffic capture is device-wide). Layout: filter bar (top) → flow
 * table | request/response detail (split) → control bar (bottom).
 *
 * The proxy engine + CA + device wiring live in the main process
 * (services/intercept.ts). Flows stream in as batched IPC events into the
 * FlowStore; body decode / curl / export happen in main (zlib) via IPC.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FlowStore } from '@core/flowStore'
import {
  DEFAULT_PORT,
  FlowFilterSpec,
  buildJsonTree,
  headersHtml,
  humanSize,
  methodColor,
  rowAccent,
  statusColor,
  type JsonTreeNode
} from '@core/intercept'
import type { FlowDetail } from '@shared/types'
import type { Controller } from '../state/useAppController'
import { PALETTE } from '../theme'
import { Icon } from './Icon'

const ROW_H = 30
const METHODS = ['All methods', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const STATUS_CLASSES: Array<[string, number]> = [
  ['All status', 0],
  ['2xx', 2],
  ['3xx', 3],
  ['4xx', 4],
  ['5xx', 5]
]

function tint(hex: string): { color: string; background: string } {
  return { color: hex, background: hex + '22' }
}

/** The green Android bugdroid painted in intercept.py's source column. */
function AndroidGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6 A5.5 5.5 0 0 1 13.5 6 Z" fill="#3ddc84" />
      <rect x="2.5" y="6" width="11" height="0.5" fill="#3ddc84" />
      <line x1="4.6" y1="4.4" x2="3.4" y2="2.6" stroke="#3ddc84" strokeWidth="1" strokeLinecap="round" />
      <line x1="11.4" y1="4.4" x2="12.6" y2="2.6" stroke="#3ddc84" strokeWidth="1" strokeLinecap="round" />
      <circle cx="6" cy="4.6" r="0.7" fill="#16171c" />
      <circle cx="10" cy="4.6" r="0.7" fill="#16171c" />
    </svg>
  )
}

/** An Apple glyph for the source column when the device is an iPhone. */
function AppleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.2 8.4c0-1.5 1.2-2.2 1.3-2.3-.7-1-1.8-1.2-2.2-1.2-.9-.1-1.8.5-2.3.5s-1.2-.5-2-.5c-1 0-2 .6-2.5 1.5-1.1 1.9-.3 4.6.8 6.1.5.7 1.1 1.5 1.9 1.5.8 0 1-.5 2-.5s1.1.5 2 .5c.8 0 1.4-.7 1.9-1.4.6-.9.8-1.7.8-1.8 0 0-1.6-.6-1.6-2.4z"
        fill="var(--text-dim)"
      />
      <path d="M9.6 4.1c.4-.5.7-1.2.6-1.9-.6 0-1.4.4-1.8.9-.4.4-.7 1.1-.6 1.8.7.1 1.4-.3 1.8-.8z" fill="var(--text-dim)" />
    </svg>
  )
}

function JsonTreeView({ nodes }: { nodes: JsonTreeNode[] }) {
  return (
    <ul className="net-json">
      {nodes.map((n, i) => (
        <JsonNode key={i} node={n} depth={0} />
      ))}
    </ul>
  )
}

const KIND_COLOR: Record<string, string> = {
  string: '#8fbf6b',
  number: '#e0a45e',
  bool: '#c58fe0',
  null: '#c58fe0'
}

function JsonNode({ node, depth }: { node: JsonTreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const hasChildren = node.children !== undefined
  if (!hasChildren) {
    return (
      <li className="net-json-leaf">
        <span className="net-json-key">{node.key}</span>
        <span className="net-json-val" style={{ color: KIND_COLOR[node.kind] ?? PALETTE.TEXT }}>
          {node.text}
        </span>
      </li>
    )
  }
  return (
    <li>
      <div className="net-json-branch" onClick={() => setOpen((v) => !v)}>
        <span className="net-json-caret">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        </span>
        <span className="net-json-key">{node.key}</span>
        <span className="net-json-count">{node.text}</span>
      </div>
      {open ? (
        <ul className="net-json">
          {node.children!.map((c, i) => (
            <JsonNode key={i} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

interface SectionProps {
  title: string
  headers: Array<[string, string]>
  body: string
  isJson: boolean
}

function Section({ title, headers, body, isJson }: SectionProps) {
  const [tree, setTree] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const nodes = useMemo(() => (isJson && tree ? buildJsonTree(body) : null), [isJson, tree, body])
  const copy = useCallback((text: string) => void navigator.clipboard.writeText(text), [])
  return (
    <div className={`net-section${collapsed ? ' collapsed' : ''}`}>
      <div className="net-section-bar">
        <button className="net-toggle" onClick={() => setCollapsed((v) => !v)} title="Collapse / expand">
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        </button>
        <span className="net-section-title">{title}</span>
        <span className="grow" />
        <button
          className={`net-toggle${tree ? ' active' : ''}`}
          disabled={!isJson}
          title="Switch the body between JSON tree and text"
          onClick={() => setTree((v) => !v)}
        >
          {tree ? 'Text' : 'Tree'}
        </button>
        <button className="net-toggle" title="Copy headers" onClick={() => copy(headers.map(([k, v]) => `${k}: ${v}`).join('\n'))}>
          <Icon name="copy" size={14} />
          Headers
        </button>
        <button className="net-toggle" title="Copy body" onClick={() => copy(body)}>
          <Icon name="copy" size={14} />
          Body
        </button>
      </div>
      {collapsed ? null : (
        <div className="net-section-body">
          {headers.length > 0 ? (
            <div className="net-headers" dangerouslySetInnerHTML={{ __html: headersHtml(headers) }} />
          ) : null}
          {nodes ? (
            <JsonTreeView nodes={nodes} />
          ) : (
            <pre className="net-body-text">{body}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export function NetworkView({ c }: { c: Controller }) {
  const isIos = c.platform === 'ios'
  const store = useMemo(() => new FlowStore(), [])
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [decrypt, setDecrypt] = useState(true) // native MITM always available
  const [statusText, setStatusText] = useState('Select a device, then Enable Intercept')

  const [method, setMethod] = useState('')
  const [statusClass, setStatusClass] = useState(0)
  const [find, setFind] = useState('')
  const [findRegex, setFindRegex] = useState(false)
  const [findError, setFindError] = useState(false)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<FlowDetail | null>(null)
  const [toast, setToast] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const enabledRef = useRef(false)
  enabledRef.current = enabled

  const showToast = useCallback((m: string) => {
    setStatusText(m)
    setToast(m)
  }, [])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(id)
  }, [toast])

  // --- proxy engine event stream (main -> renderer) ----------------------
  useEffect(() => {
    const offFlows = window.androidlab.intercept.onFlows((flows) => {
      const el = scrollRef.current
      const atBottom = el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 4 : true
      stickBottomRef.current = atBottom
      store.appendBatch(flows)
    })
    const offStarted = window.androidlab.intercept.onStarted((p) => {
      setEnabled(true)
      setBusy(false)
      setStatusText(`Intercept on · port ${p}`)
    })
    const offStatus = window.androidlab.intercept.onStatus((m) => setStatusText(m))
    const offFailed = window.androidlab.intercept.onFailed((m) => {
      setEnabled(false)
      setBusy(false)
      setStatusText(m)
      setToast(m)
    })
    return () => {
      offFlows()
      offStarted()
      offStatus()
      offFailed()
    }
  }, [store])

  // Keep autoscrolled to newest while capturing (mirrors scrollToBottom on flush).
  useEffect(() => {
    if (!stickBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [version])

  // --- filtering (immediate — mirrors _apply_filter) ---------------------
  useEffect(() => {
    const spec = new FlowFilterSpec({
      method,
      statusClass,
      textQuery: find.trim(),
      textRegex: findRegex
    }).compile()
    store.setFilter(spec)
    setFindError(spec.hasError('text'))
    setSelectedId(null)
    setDetail(null)
  }, [store, method, statusClass, find, findRegex])

  // Tear down on device switch (mirrors set_serial → _disable).
  useEffect(() => {
    if (enabledRef.current) {
      void window.androidlab.intercept.stop()
      setEnabled(false)
      setStatusText(
        isIos
          ? 'Device changed — intercept stopped; turn off the Wi-Fi proxy on the iPhone'
          : 'Device changed — intercept stopped; device proxy restored'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.serial])

  // --- lifecycle actions -------------------------------------------------
  const toggleEnable = useCallback(() => {
    if (enabled) {
      void window.androidlab.intercept.stop()
      setEnabled(false)
      setStatusText(
        isIos
          ? 'Intercept off — turn OFF the Wi-Fi proxy on the iPhone (Settings ▸ Wi-Fi ▸ (i) ▸ Configure Proxy ▸ Off)'
          : 'Intercept off — device proxy restored'
      )
      return
    }
    if (!c.serial) {
      showToast('No device selected')
      return
    }
    setBusy(true)
    setStatusText(isIos ? 'Starting proxy…' : 'Wiring device proxy…')
    void window.androidlab.intercept.start(c.serial, port, decrypt)
  }, [enabled, c.serial, port, decrypt, showToast, isIos])

  const onDecryptToggle = useCallback(() => {
    setDecrypt((prev) => {
      const next = !prev
      if (enabledRef.current) void window.androidlab.intercept.setDecrypt(next)
      return next
    })
  }, [])

  const installCert = useCallback(() => {
    if (!c.serial) {
      showToast('Select a device first')
      return
    }
    void window.androidlab.intercept.installCert(c.serial).then((r) => showToast(r.message))
  }, [c.serial, showToast])

  // --- selection / detail ------------------------------------------------
  const selectFlow = useCallback((id: number) => {
    setSelectedId(id)
    void window.androidlab.intercept.detail(id).then(setDetail)
  }, [])

  const copyCurl = useCallback(() => {
    if (!detail || !detail.found) {
      showToast('Select a request first')
      return
    }
    void navigator.clipboard.writeText(detail.curl)
    showToast('Copied cURL')
  }, [detail, showToast])

  const saveBody = useCallback(() => {
    if (selectedId === null) {
      showToast('Select a request first')
      return
    }
    void window.androidlab.intercept.saveBody(selectedId).then((r) => {
      if (r.ok) showToast(`✓ ${r.message}`)
      else if (r.message !== 'cancelled') showToast(`✗ ${r.message}`)
    })
  }, [selectedId, showToast])

  const downloadFlow = useCallback(() => {
    if (selectedId === null) {
      showToast('Select a request first')
      return
    }
    void window.androidlab.intercept.downloadFlow(selectedId).then((r) => {
      if (r.ok) showToast(`✓ ${r.message}`)
      else if (r.message !== 'cancelled') showToast(`✗ ${r.message}`)
    })
  }, [selectedId, showToast])

  const clearFlows = useCallback(() => {
    store.clear()
    setSelectedId(null)
    setDetail(null)
  }, [store])

  // --- virtualized flow table --------------------------------------------
  const rowCount = store.rowCount()
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16
  })
  const items = virtualizer.getVirtualItems()

  return (
    <div className="net-view">
      {/* filter bar */}
      <div className="net-filter">
        <span className="label">Method</span>
        <select value={method} onChange={(e) => setMethod(e.target.value === 'All methods' ? '' : e.target.value)}>
          {METHODS.map((m) => (
            <option key={m} value={m === 'All methods' ? '' : m}>
              {m}
            </option>
          ))}
        </select>
        <select value={statusClass} onChange={(e) => setStatusClass(Number(e.target.value))}>
          {STATUS_CLASSES.map(([name, cls]) => (
            <option key={cls} value={cls}>
              {name}
            </option>
          ))}
        </select>
        <span className="label">Find</span>
        <input
          className={`net-find${findError ? ' error' : ''}`}
          placeholder="filter host + path…"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <button
          className={`net-toggle${findRegex ? ' active' : ''}`}
          title="Treat filter as a regular expression"
          onClick={() => setFindRegex((v) => !v)}
        >
          .*
        </button>
        <span className="grow" />
        <button className="net-toggle" title="Copy the selected request as a curl command" onClick={copyCurl}>
          Copy cURL
        </button>
        <button className="net-toggle" title="Save the selected response body to a file" onClick={saveBody}>
          Save Body
        </button>
        <button className="net-toggle" title="Download the full request + response" onClick={downloadFlow}>
          <Icon name="download" size={14} />
          Download
        </button>
        <button className="net-toggle" onClick={clearFlows}>
          Clear
        </button>
      </div>

      {/* table | detail */}
      <div className="net-split">
        <div className="net-table">
          <div className="net-thead">
            <div className="net-col method">Method</div>
            <div className="net-col status">Status</div>
            <div className="net-col source" />
            <div className="net-col host">Host</div>
            <div className="net-col path">Path</div>
          </div>
          <div className="net-scroll" ref={scrollRef}>
            <div className="net-rows" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((vi) => {
                const f = store.flowAt(vi.index)
                if (!f) return null
                const selected = f.id === selectedId
                return (
                  <div
                    key={vi.key}
                    className={`net-row${selected ? ' selected' : ''}`}
                    style={{ transform: `translateY(${vi.start}px)`, height: ROW_H }}
                    onMouseDown={() => selectFlow(f.id)}
                  >
                    <div className="net-accent" style={{ background: rowAccent(f) }} />
                    <div className="net-col method" style={{ color: methodColor(f.method), fontWeight: 700 }}>
                      {f.method}
                    </div>
                    <div className="net-col status" style={{ color: statusColor(f.status), fontWeight: 700 }}>
                      {f.status === null ? '' : f.status}
                    </div>
                    <div className="net-col source">{isIos ? <AppleGlyph /> : <AndroidGlyph />}</div>
                    <div className="net-col host">{f.host}</div>
                    <div className="net-col path">{f.path}</div>
                  </div>
                )
              })}
            </div>
            {rowCount === 0 ? (
              <div className="net-empty">
                {enabled ? (
                  'Capturing… drive traffic on the device to see requests.'
                ) : isIos ? (
                  <div className="net-empty-steps">
                    <div>To intercept an iPhone (same Wi-Fi as this Mac):</div>
                    <ol>
                      <li>Enable Intercept — the status bar shows the proxy address.</li>
                      <li>Set the iPhone's Wi-Fi proxy to that address (Wi-Fi ▸ ⓘ ▸ Configure Proxy ▸ Manual).</li>
                      <li>Install &amp; Trust CA, then trust it (Settings ▸ General ▸ About ▸ Certificate Trust Settings).</li>
                    </ol>
                  </div>
                ) : (
                  'Enable Intercept and route the device through this proxy to capture traffic.'
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="net-detail">
          {detail && detail.found ? (
            <>
              <div className="net-summary">
                <span className="net-pill" style={tint(methodColor(detail.method))}>
                  {detail.method}
                </span>
                {detail.status !== null ? (
                  <span className="net-pill" style={tint(statusColor(detail.status))}>
                    {detail.status}
                  </span>
                ) : null}
                <span className="net-url" title={detail.url}>
                  {detail.url}
                </span>
                <span className="net-meta">
                  {[
                    detail.durationMs !== null ? `${detail.durationMs} ms` : '',
                    detail.respSize ? humanSize(detail.respSize) : ''
                  ]
                    .filter(Boolean)
                    .join('   ·   ')}
                </span>
              </div>
              <div className="net-cards">
                <Section title="REQUEST" headers={detail.reqHeaders} body={detail.reqBody} isJson={detail.reqIsJson} />
                <Section
                  title={detail.status !== null && detail.bodyCaptured ? `RESPONSE · ${detail.status}` : 'RESPONSE'}
                  headers={detail.bodyCaptured ? detail.respHeaders : []}
                  body={detail.bodyCaptured ? detail.respBody : detail.note || 'encrypted (metadata only)'}
                  isJson={detail.respIsJson}
                />
              </div>
            </>
          ) : (
            <div className="net-detail-empty">
              {detail && !detail.found ? detail.note : 'Select a request to inspect'}
            </div>
          )}
        </div>
      </div>

      {/* control bar */}
      <div className="net-bar">
        <button
          className={`net-enable${enabled ? ' running' : ''}`}
          disabled={busy}
          onClick={toggleEnable}
          title="Route the device's HTTP(S) traffic through this app"
        >
          {enabled ? 'Disable Intercept' : 'Enable Intercept'}
        </button>
        <span className="label">Port</span>
        <input
          className="net-port"
          type="number"
          min={1024}
          max={65535}
          value={port}
          disabled={enabled}
          onChange={(e) => setPort(Math.max(1024, Math.min(65535, Number(e.target.value) || DEFAULT_PORT)))}
        />
        <button
          className={`net-toggle${decrypt ? ' active' : ''}`}
          title="Decrypt HTTPS via the built-in native MITM (needs the CA cert trusted on the device)"
          onClick={onDecryptToggle}
        >
          Decrypt HTTPS
        </button>
        <button
          className="net-toggle"
          title={
            isIos
              ? 'Send the AndroidLab CA to the iPhone as a profile (then approve + trust it in Settings)'
              : 'Push the CA cert to the device to install it'
          }
          onClick={installCert}
        >
          {isIos ? 'Install & Trust CA' : 'Install CA Cert'}
        </button>
        <span className="grow" />
        <span className="net-status">{statusText}</span>
      </div>

      {toast ? <div className="net-toast">{toast}</div> : null}
    </div>
  )
}
