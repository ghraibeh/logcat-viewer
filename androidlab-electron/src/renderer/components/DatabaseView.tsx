/**
 * Database Inspector — port of dbinspect.py's DatabaseView: a schema tree
 * (databases -> tables) on the left and a results table with paging + a
 * read-only SQL box on the right. Reads a PULLED snapshot via sql.js (in the
 * main process); cell edits go to the LIVE device DB via on-device sqlite3.
 * Follows the shared App picker (c.serial + c.appPkg). Only mounts when the
 * Databases tab is active, so nothing touches adb until the tab is opened.
 */
import { useEffect, useRef, useState } from 'react'
import {
  PAGE_SIZE,
  cellText,
  clipboardValue,
  isBlob,
  quoteIdent,
  toCsv,
  type DbValue
} from '@core/db'
import type { DbTableInfo } from '@shared/types'
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'

interface Empty {
  glyph: string
  title: string
  sub: string
}
interface CellState {
  row: number
  col: number
  column: string
  value: DbValue
  editable: boolean
  reason: string
}
interface TreeMenu {
  x: number
  y: number
  kind: 'db' | 'table'
  db: string
  table?: string
  connected: boolean
}
interface CellMenu {
  x: number
  y: number
  row: number
  col: number
  editable: boolean
}

function DbGlyph({ view }: { view?: boolean }) {
  if (view) {
    return (
      <svg className="db-glyph view" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="2.6" y="3" width="10.8" height="10" rx="1.5" />
        <path d="M2.6 6.2 H13.4 M2.6 9.6 H13.4 M6.6 3 V13" />
      </svg>
    )
  }
  return (
    <svg className="db-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <ellipse cx="8" cy="4" rx="5.4" ry="1.9" />
      <path d="M2.6 4 V11.6" />
      <path d="M13.4 4 V11.6" />
      <path d="M2.6 7.6 A5.4 1.9 0 0 0 13.4 7.6" />
      <path d="M2.6 11.6 A5.4 1.9 0 0 0 13.4 11.6" />
    </svg>
  )
}
function TableGlyph({ view }: { view: boolean }) {
  return <DbGlyph view={view} />
}

function looksJson(text: string): boolean {
  const t = (text || '').trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/** View a full cell value; edit + write back to the live DB when editable. */
function CellDialog({
  cell,
  onSave,
  onClose
}: {
  cell: CellState
  onSave: (row: number, col: number, text: string | null, setNull: boolean) => void
  onClose: () => void
}) {
  const initial = (() => {
    if (cell.value === null) return ''
    let shown = cellText(cell.value)
    if (looksJson(shown)) {
      try {
        shown = JSON.stringify(JSON.parse(shown), null, 2)
      } catch {
        /* keep raw */
      }
    }
    return shown
  })()
  const [text, setText] = useState(initial)
  const [setNull, setSetNull] = useState(false)
  const kind = cell.value === null ? 'NULL' : typeof cell.value === 'object' ? 'BLOB' : typeof cell.value

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="db-cell-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="head">
          <b>{cell.column}</b> <span className="kind">· {kind}</span>
        </div>
        <textarea
          value={setNull ? '' : text}
          disabled={!cell.editable || setNull}
          onChange={(e) => setText(e.target.value)}
        />
        {cell.editable ? (
          <label className="checkbox">
            <input type="checkbox" checked={setNull} onChange={(e) => setSetNull(e.target.checked)} />
            Set NULL
          </label>
        ) : cell.reason ? (
          <div className="note">{cell.reason}</div>
        ) : null}
        <div className="buttons">
          <span className="grow" />
          <button onClick={() => void navigator.clipboard.writeText(clipboardValue(cell.value))}>Copy</button>
          {cell.editable ? (
            <button
              className="start"
              onClick={() => {
                onSave(cell.row, cell.col, setNull ? null : text, setNull)
                onClose()
              }}
            >
              Save to device
            </button>
          ) : null}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

export function DatabaseView({ c }: { c: Controller }) {
  const [dbs, setDbs] = useState<string[]>([])
  const [openTables, setOpenTables] = useState<Record<string, DbTableInfo[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [canEdit, setCanEdit] = useState(false)
  const [search, setSearch] = useState('')

  const [curDb, setCurDb] = useState<string | null>(null)
  const [curTable, setCurTable] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [cols, setCols] = useState<string[]>([])
  const [rows, setRows] = useState<DbValue[][]>([])
  const [rowids, setRowids] = useState<Array<number | null> | null>(null)
  const [queryText, setQueryText] = useState('')

  const [listing, setListing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [status, setStatus] = useState('')
  const [pageLabel, setPageLabel] = useState('')
  const [treeEmpty, setTreeEmpty] = useState<Empty | null>(null)
  const [resultsEmpty, setResultsEmpty] = useState<Empty | null>(null)
  const [savedMsg, setSavedMsg] = useState<{ message: string; dir: string } | null>(null)

  const [sel, setSel] = useState<{ row: number; col: number } | null>(null)
  const [treeMenu, setTreeMenu] = useState<TreeMenu | null>(null)
  const [cellMenu, setCellMenu] = useState<CellMenu | null>(null)
  const [dialog, setDialog] = useState<CellState | null>(null)

  // Refs mirror state for reads inside async continuations / event handlers.
  const serialRef = useRef(c.serial)
  serialRef.current = c.serial
  const pkgRef = useRef(c.appPkg)
  pkgRef.current = c.appPkg
  const openTablesRef = useRef(openTables)
  openTablesRef.current = openTables
  const curDbRef = useRef(curDb)
  curDbRef.current = curDb
  const curTableRef = useRef(curTable)
  curTableRef.current = curTable
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const totalRef = useRef(total)
  totalRef.current = total
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const rowidsRef = useRef(rowids)
  rowidsRef.current = rowids
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit

  const querySeqRef = useRef(0)
  const listSeqRef = useRef(0)
  const staleRef = useRef<Set<string>>(new Set())
  const editingRef = useRef(false)

  // --- reading a table page / running a query (latest-wins) ------------------
  function dispatchRead(db: string, table: string, off: number): void {
    const s = serialRef.current
    const p = pkgRef.current
    if (!s || !p) return
    const seq = ++querySeqRef.current
    setQuerying(true)
    setStatus('Running…')
    setSel(null)
    setSavedMsg(null)
    void window.androidlab.db.readTable(s, p, db, table, PAGE_SIZE, off).then((res) => {
      if (seq !== querySeqRef.current) return
      setQuerying(false)
      if (!res.ok) {
        setStatus(`✗ ${res.message}`)
        setCols([])
        setRows([])
        setRowids(null)
        setResultsEmpty({ glyph: '⚠️', title: 'Query failed', sub: res.message })
        return
      }
      setCols(res.cols)
      setRows(res.rows)
      setRowids(res.rowids)
      setTotal(res.total)
      setOffset(off)
      const first = res.rows.length ? off + 1 : 0
      setStatus(`${table}: rows ${first}–${off + res.rows.length} of ${res.total.toLocaleString()}`)
      const end = Math.min(off + PAGE_SIZE, res.total)
      setPageLabel(`rows ${res.total ? off + 1 : 0}–${end} of ${res.total.toLocaleString()}`)
      setResultsEmpty(res.rows.length ? null : { glyph: '📭', title: 'Empty table', sub: `“${table}” has no rows.` })
    })
  }

  function browseTable(db: string, table: string, off: number): void {
    setCurDb(db)
    curDbRef.current = db
    setCurTable(table)
    curTableRef.current = table
    setOffset(off)
    setQueryText(`SELECT * FROM ${quoteIdent(table)}`)
    dispatchRead(db, table, off)
  }

  function runQuery(): void {
    const sql = queryText.trim()
    const s = serialRef.current
    const p = pkgRef.current
    const db = curDbRef.current
    if (!sql || !db || !s || !p) return
    setCurTable(null)
    curTableRef.current = null
    const seq = ++querySeqRef.current
    setQuerying(true)
    setStatus('Running…')
    setSel(null)
    setSavedMsg(null)
    void window.androidlab.db.query(s, p, db, sql).then((res) => {
      if (seq !== querySeqRef.current) return
      setQuerying(false)
      if (!res.ok) {
        setStatus(`✗ ${res.message}`)
        setCols([])
        setRows([])
        setRowids(null)
        setResultsEmpty({ glyph: '⚠️', title: 'Query failed', sub: res.message })
        return
      }
      setCols(res.cols)
      setRows(res.rows)
      setRowids(null)
      setTotal(-1)
      const tail = res.truncated ? ' (truncated)' : ''
      setStatus(`Query OK — ${res.rows.length.toLocaleString()} row(s)${tail}`)
      setPageLabel(`${res.rows.length.toLocaleString()} row(s)${tail}`)
      setResultsEmpty(res.rows.length ? null : { glyph: '🔍', title: 'No matching rows', sub: 'Your query returned 0 rows.' })
    })
  }

  function page(dir: number): void {
    const db = curDbRef.current
    const table = curTableRef.current
    if (!db || !table) return
    const nw = offsetRef.current + dir * PAGE_SIZE
    if (nw < 0 || nw >= totalRef.current) return
    browseTable(db, table, nw)
  }

  // --- opening / connecting a database ---------------------------------------
  function selectFirstTable(name: string, tables: DbTableInfo[]): void {
    let best: DbTableInfo | null = null
    let bestScore = -1
    for (const t of tables) {
      const score = (t.name !== 'android_metadata' ? 2 : 0) + (t.count > 0 ? 1 : 0)
      if (score > bestScore) {
        best = t
        bestScore = score
      }
    }
    if (best) browseTable(name, best.name, 0)
  }

  function openDb(name: string, autoSelect: boolean, explicitForce = false): void {
    const s = serialRef.current
    const p = pkgRef.current
    if (!s || !p) return
    const already = openTablesRef.current[name]
    const force = explicitForce || staleRef.current.has(name)
    if (already && !force) {
      setExpanded((prev) => new Set(prev).add(name))
      if (autoSelect) selectFirstTable(name, already)
      return
    }
    setOpening(true)
    setStatus(`Opening ${name}…`)
    void window.androidlab.db.open(s, p, name, force).then((res) => {
      setOpening(false)
      if (serialRef.current !== s || pkgRef.current !== p) return
      if (!res.ok) {
        setStatus(res.message)
        return
      }
      staleRef.current.delete(name)
      setOpenTables((prev) => {
        const next = { ...prev, [name]: res.tables }
        openTablesRef.current = next
        return next
      })
      setExpanded((prev) => new Set(prev).add(name))
      setStatus(res.message)
      if (autoSelect) selectFirstTable(name, res.tables)
    })
  }

  function disconnect(name: string, silent = false): void {
    setOpenTables((prev) => {
      const next = { ...prev }
      delete next[name]
      openTablesRef.current = next
      return next
    })
    setExpanded((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
    if (curDbRef.current === name) {
      setCurDb(null)
      curDbRef.current = null
      setCurTable(null)
      curTableRef.current = null
      setRowids(null)
      setCols([])
      setRows([])
      setTotal(0)
      setPageLabel('')
      setQueryText('')
      setResultsEmpty(null)
    }
    if (!silent) setStatus(`Disconnected ${name}`)
  }

  // --- listing databases (device / app driven) -------------------------------
  async function loadDbs(isRefresh: boolean): Promise<void> {
    const s = serialRef.current
    const p = pkgRef.current
    const seq = ++listSeqRef.current
    querySeqRef.current++ // supersede any in-flight query
    setSearch('')
    setDbs([])
    setOpenTables({})
    openTablesRef.current = {}
    setExpanded(new Set())
    setCurDb(null)
    curDbRef.current = null
    setCurTable(null)
    curTableRef.current = null
    setRowids(null)
    setCols([])
    setRows([])
    setTotal(0)
    setPageLabel('')
    setQueryText('')
    setStatus('')
    setResultsEmpty(null)
    setTreeEmpty(null)
    setSel(null)
    setSavedMsg(null)
    if (!s || !p) {
      setListing(false)
      return
    }
    setListing(true)
    setStatus(`Listing databases for ${p}…`)
    const res = await window.androidlab.db.list(s, p)
    if (seq !== listSeqRef.current) return
    if (serialRef.current !== s || pkgRef.current !== p) return
    setListing(false)
    setCanEdit(res.hasSqlite3)
    canEditRef.current = res.hasSqlite3
    if (!res.ok) {
      setStatus(res.message)
      setTreeEmpty({ glyph: '⚠️', title: 'Can’t read this app’s databases', sub: res.message })
      return
    }
    setDbs(res.dbs)
    setStatus(res.message)
    if (isRefresh) staleRef.current = new Set(res.dbs)
    if (res.dbs.length) {
      setTreeEmpty(null)
      openDb(res.dbs[0], true) // auto-connect the first DB so the tab isn't empty
    } else {
      setTreeEmpty({ glyph: '🗄', title: 'No databases', sub: `${p} hasn’t created any SQLite databases yet.` })
    }
  }

  // Keep a ref to the latest loadDbs so the device/app effect calls the current
  // closure (this update effect is declared first, so it runs first).
  const loadDbsRef = useRef(loadDbs)
  useEffect(() => {
    loadDbsRef.current = loadDbs
  })
  useEffect(() => {
    void loadDbsRef.current(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.serial, c.appPkg])

  // --- cell copy / view / edit -----------------------------------------------
  function cellEditable(row: number, col: number): { editable: boolean; reason: string } {
    if (curTableRef.current === null || rowidsRef.current === null) {
      return { editable: false, reason: 'Editing is available when browsing a table, not a custom query.' }
    }
    const rids = rowidsRef.current
    if (!(row >= 0 && row < rids.length) || rids[row] === null) {
      return { editable: false, reason: 'This row has no rowid, so it can’t be targeted for editing.' }
    }
    if (!canEditRef.current) {
      return {
        editable: false,
        reason:
          "This device has no 'sqlite3' binary, so values can’t be written back. Editing works on an emulator, a rooted device, or a userdebug build."
      }
    }
    if (isBlob(rowsRef.current[row]?.[col] ?? null)) {
      return { editable: false, reason: 'Binary blob values can’t be edited as text.' }
    }
    return { editable: true, reason: '' }
  }

  function openCellDialog(row: number, col: number): void {
    const value = rowsRef.current[row]?.[col] ?? null
    const column = colsRef.current[col] ?? ''
    const { editable, reason } = cellEditable(row, col)
    setDialog({ row, col, column, value, editable, reason })
  }

  async function saveCell(row: number, col: number, text: string | null, setNull: boolean): Promise<void> {
    if (editingRef.current) {
      setStatus('An edit is already running…')
      return
    }
    const { editable, reason } = cellEditable(row, col)
    if (!editable) {
      setStatus(`✗ ${reason || 'This cell can’t be edited'}`)
      return
    }
    const s = serialRef.current
    const p = pkgRef.current
    const db = curDbRef.current
    const table = curTableRef.current
    const rid = rowidsRef.current?.[row]
    if (!s || !p || !db || !table || rid === null || rid === undefined) return
    editingRef.current = true
    setStatus('Saving to device…')
    const r = await window.androidlab.db.edit(s, p, db, table, colsRef.current[col], rid, setNull ? null : text, setNull)
    editingRef.current = false
    if (!r.ok) {
      setStatus(`✗ ${r.message}`)
      return
    }
    setRows((prev) => {
      const next = prev.map((rr) => rr.slice())
      if (next[row]) next[row][col] = setNull ? null : (text as DbValue)
      rowsRef.current = next
      return next
    })
    setStatus(`✓ ${r.message}`)
  }

  function copyCell(row: number, col: number): void {
    void navigator.clipboard.writeText(clipboardValue(rowsRef.current[row]?.[col] ?? null))
    setStatus('Copied cell value')
  }
  function copyRow(row: number): void {
    const vals = rowsRef.current[row] ?? []
    void navigator.clipboard.writeText(vals.map((v) => clipboardValue(v)).join('\t'))
    setStatus('Copied row')
  }

  // Cmd/Ctrl+C copies the selected cell (unless focus is in a field).
  useEffect(() => {
    const handler = (ev: ClipboardEvent): void => {
      const ae = document.activeElement
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
      const s = sel
      if (!s) return
      ev.clipboardData?.setData('text/plain', clipboardValue(rowsRef.current[s.row]?.[s.col] ?? null))
      ev.preventDefault()
    }
    document.addEventListener('copy', handler)
    return () => document.removeEventListener('copy', handler)
  }, [sel])

  // --- exports ----------------------------------------------------------------
  async function exportDbFile(name: string): Promise<void> {
    const s = serialRef.current
    const p = pkgRef.current
    if (!s || !p) return
    const suggested = name.toLowerCase().endsWith('.db') ? name : `${name}.db`
    setStatus(`Exporting ${suggested}…`)
    const r = await window.androidlab.db.export(s, p, name, suggested)
    if (r.message === 'cancelled') {
      setStatus('')
      return
    }
    setStatus((r.ok ? '✓ ' : '✗ ') + r.message)
    if (r.ok) setSavedMsg({ message: r.message, dir: r.dir })
  }

  async function exportCsv(): Promise<void> {
    if (colsRef.current.length === 0) return
    const text = toCsv(colsRef.current, rowsRef.current)
    const base = `${curTableRef.current ?? 'query'}.csv`
    const r = await window.androidlab.db.exportCsv(text, base, rowsRef.current.length)
    if (r.message === 'cancelled') return
    setStatus((r.ok ? '✓ ' : '✗ ') + r.message)
    if (r.ok) setSavedMsg({ message: r.message, dir: r.dir })
  }

  // --- derived render state ---------------------------------------------------
  const busyTree = listing || opening
  const treeEmptyShown: Empty | null = busyTree
    ? null
    : !(c.serial && c.appPkg)
      ? { glyph: '🗄', title: 'No app selected', sub: 'Pick an app in the list to inspect its SQLite databases.' }
      : dbs.length === 0
        ? treeEmpty ?? { glyph: '🗄', title: 'No databases', sub: "This app hasn't created any SQLite databases yet." }
        : null
  const resultsEmptyShown: Empty | null = querying
    ? null
    : rows.length === 0
      ? resultsEmpty ?? { glyph: '📋', title: 'No table selected', sub: 'Choose a table on the left, or run a query, to see rows here.' }
      : null

  const q = search.trim().toLowerCase()
  const prevEnabled = curTable !== null && offset > 0
  const nextEnabled = curTable !== null && offset + PAGE_SIZE < total

  const closeMenus = (): void => {
    setTreeMenu(null)
    setCellMenu(null)
  }

  return (
    <div className="db-view" onClick={closeMenus}>
      <div className="db-bar">
        <span className="db-app">
          {c.appPkg ? `App:  ${c.appPkg}` : 'Select an app in the list to inspect its databases'}
        </span>
        <button
          className="toggle"
          title="Re-list the app's databases and re-pull a fresh snapshot"
          disabled={!c.serial || !c.appPkg}
          onClick={() => void loadDbs(true)}
        >
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </div>

      <div className="db-split">
        {/* Left: filter + schema tree */}
        <div className="db-left">
          <div className="db-searchbar">
            <input
              type="text"
              placeholder="Filter databases & tables…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {busyTree ? <div className="db-busy" /> : null}
          <div className="db-tree">
            <div className="db-tree-head">DATABASES</div>
            {dbs.map((name) => {
              const tables = openTables[name] ?? []
              const dbMatch = !q || name.toLowerCase().includes(q)
              const anyChild = q !== '' && tables.some((t) => t.name.toLowerCase().includes(q))
              if (!(dbMatch || anyChild)) return null
              const connected = name in openTables
              const isOpen = expanded.has(name) || (q !== '' && (dbMatch || anyChild))
              const visibleTables = tables.filter((t) => dbMatch || t.name.toLowerCase().includes(q))
              return (
                <div key={name}>
                  <div
                    className={`db-node${connected ? ' db-connected' : ''}`}
                    title={name}
                    onClick={() => openDb(name, false)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCellMenu(null)
                      setTreeMenu({ x: e.clientX, y: e.clientY, kind: 'db', db: name, connected })
                    }}
                  >
                    <span
                      className="db-twisty"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (connected) {
                          setExpanded((prev) => {
                            const n = new Set(prev)
                            if (n.has(name)) n.delete(name)
                            else n.add(name)
                            return n
                          })
                        } else {
                          openDb(name, false)
                        }
                      }}
                    >
                      {tables.length ? <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} /> : null}
                    </span>
                    <DbGlyph />
                    <span className="db-label">{name}</span>
                  </div>
                  {isOpen
                    ? visibleTables.map((t) => {
                        const selected = curDb === name && curTable === t.name
                        const count = t.type === 'view' ? 'view' : t.count >= 0 ? t.count.toLocaleString() : '—'
                        return (
                          <div
                            key={t.name}
                            className={`db-node db-node-table${selected ? ' selected' : ''}`}
                            title={`${t.name}  ·  ${t.type}`}
                            onClick={() => browseTable(name, t.name, 0)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setCellMenu(null)
                              setTreeMenu({ x: e.clientX, y: e.clientY, kind: 'table', db: name, table: t.name, connected: true })
                            }}
                          >
                            <TableGlyph view={t.type === 'view'} />
                            <span className="db-label">{t.name}</span>
                            <span className="db-count">({count})</span>
                          </div>
                        )
                      })
                    : null}
                </div>
              )
            })}
            {treeEmptyShown ? (
              <div className="db-empty">
                <div className="glyph">{treeEmptyShown.glyph}</div>
                <div className="title">{treeEmptyShown.title}</div>
                <div className="sub">{treeEmptyShown.sub}</div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: query box + results + paging */}
        <div className="db-right">
          <div className="db-querybar">
            <input
              type="text"
              placeholder="SELECT * FROM …   (read-only, runs on a local snapshot)"
              value={queryText}
              disabled={curDb === null}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runQuery()
              }}
            />
            <button className="start" disabled={curDb === null} onClick={runQuery}>
              Run
            </button>
            <button
              className="toggle"
              disabled={cols.length === 0}
              title="Save the current results as a CSV file"
              onClick={() => void exportCsv()}
            >
              Export CSV
            </button>
          </div>
          {querying ? <div className="db-busy" /> : null}
          <div className="db-table-wrap">
            {cols.length > 0 ? (
              <table className="db-table">
                <thead>
                  <tr>
                    <th className="rownum" />
                    {cols.map((col, i) => (
                      <th key={i}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, r) => (
                    <tr key={r}>
                      <td className="rownum">{offset + r + 1}</td>
                      {row.map((v, ci) => {
                        const dim = v === null || (typeof v === 'object' && v !== null)
                        const isSel = sel?.row === r && sel.col === ci
                        return (
                          <td
                            key={ci}
                            className={`${dim ? 'dim' : ''}${isSel ? ' selected' : ''}`}
                            title={v === null ? undefined : cellText(v)}
                            onMouseDown={() => setSel({ row: r, col: ci })}
                            onDoubleClick={() => openCellDialog(r, ci)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setTreeMenu(null)
                              setSel({ row: r, col: ci })
                              setCellMenu({ x: e.clientX, y: e.clientY, row: r, col: ci, editable: cellEditable(r, ci).editable })
                            }}
                          >
                            {cellText(v)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {resultsEmptyShown ? (
              <div className="db-empty">
                <div className="glyph">{resultsEmptyShown.glyph}</div>
                <div className="title">{resultsEmptyShown.title}</div>
                <div className="sub">{resultsEmptyShown.sub}</div>
              </div>
            ) : null}
          </div>
          <div className="db-pagebar">
            <button className="toggle" disabled={!prevEnabled} onClick={() => page(-1)}>
              <Icon name="chevronLeft" size={14} />
              Prev
            </button>
            <button className="toggle" disabled={!nextEnabled} onClick={() => page(+1)}>
              Next
              <Icon name="chevronRight" size={14} />
            </button>
            {savedMsg ? (
              <span className="db-status db-saved">
                ✓ {savedMsg.message}
                {savedMsg.dir ? (
                  <button className="toggle" onClick={() => void window.androidlab.system.openPath(savedMsg.dir)}>
                    Open folder
                  </button>
                ) : null}
              </span>
            ) : (
              <span className="db-status">{pageLabel || status}</span>
            )}
          </div>
        </div>
      </div>

      {/* Right-click schema menu */}
      {treeMenu ? (
        <div className="context-menu" style={{ left: treeMenu.x, top: treeMenu.y }} onClick={(e) => e.stopPropagation()}>
          {treeMenu.kind === 'db' ? (
            treeMenu.connected ? (
              <>
                <div className="item" onClick={() => { disconnect(treeMenu.db); closeMenus() }}>
                  Disconnect
                </div>
                <div className="item" onClick={() => { disconnect(treeMenu.db, true); openDb(treeMenu.db, true, true); closeMenus() }}>
                  Reconnect (fresh snapshot)
                </div>
              </>
            ) : (
              <div className="item" onClick={() => { openDb(treeMenu.db, true); closeMenus() }}>
                Connect
              </div>
            )
          ) : (
            <div className="item" onClick={() => { browseTable(treeMenu.db, treeMenu.table as string, 0); closeMenus() }}>
              Browse
            </div>
          )}
          <div className="sep" />
          <div className="item" onClick={() => { void exportDbFile(treeMenu.db); closeMenus() }}>
            Export database as .db file…
          </div>
        </div>
      ) : null}

      {/* Right-click cell menu */}
      {cellMenu ? (
        <div className="context-menu" style={{ left: cellMenu.x, top: cellMenu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="item" onClick={() => { copyCell(cellMenu.row, cellMenu.col); closeMenus() }}>
            Copy value
          </div>
          <div className="item" onClick={() => { copyRow(cellMenu.row); closeMenus() }}>
            Copy row
          </div>
          <div className="sep" />
          <div className="item" onClick={() => { openCellDialog(cellMenu.row, cellMenu.col); closeMenus() }}>
            {cellMenu.editable ? 'Edit value…' : 'View value…'}
          </div>
        </div>
      ) : null}

      {dialog ? (
        <CellDialog cell={dialog} onSave={(row, col, text, setNull) => void saveCell(row, col, text, setNull)} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  )
}
