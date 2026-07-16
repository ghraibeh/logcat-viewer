/**
 * Device File Explorer — port of files.py's FilesView: a Windows-Explorer-style
 * browser with a command bar, back/forward + breadcrumb address bar + search, a
 * Quick-access navigation pane, and Details / Large-icons views with drawn
 * folder / type-tinted file icons. Two-way transfer (Download to a chosen folder
 * / Upload chosen files, drag-in from Finder best-effort) + file management
 * (new folder / rename / delete). Follows the shared App picker (c.serial +
 * c.appPkg) for app-private data; a Root (su) toggle forces rooted access.
 *
 * All device work happens in the main process; this only calls window.androidlab.files.*.
 */
import { useEffect, useRef, useState } from 'react'
import {
  DATA_DATA,
  DEFAULT_PATH,
  LOCATIONS,
  QUICK_ACCESS,
  humanSize,
  joinPath,
  parentPath,
  tintFor,
  typeLabel
} from '@core/files'
import type { FileEntry, Place } from '@core/files'
import type { Controller } from '../state/useAppController'
import { PromptDialog } from './dialogs'
import { Icon } from './Icon'

type SortKey = 'name' | 'date' | 'type' | 'size'
type ViewMode = 'details' | 'icons'

// iOS nav-pane bookmarks — the app container is browsed '/'-rooted (the backend
// maps '/' → the container root); the Android QUICK_ACCESS/LOCATIONS don't apply.
const IOS_QUICK_ACCESS: Place[] = [
  { label: 'Documents', path: '/Documents', needsApp: false },
  { label: 'Library', path: '/Library', needsApp: false },
  { label: 'tmp', path: '/tmp', needsApp: false }
]
const IOS_LOCATIONS: Place[] = [{ label: 'Container root', path: '/', needsApp: false }]

interface MenuItem {
  label: string
  run: () => void
}
interface CtxMenu {
  x: number
  y: number
  items: MenuItem[]
}
interface PromptState {
  kind: 'newfolder' | 'rename'
  title: string
  label: string
  initial: string
  original?: string
}

// --- drawn icons (SVG port of files.py's painter-drawn folder / file / link) --
function FolderSvg({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="files-icon">
      <rect x="8" y="15" width="26" height="13" rx="3" fill="#7cc0ff" />
      <rect x="8" y="21" width="48" height="31" rx="4" fill="url(#flFolderGrad)" />
    </svg>
  )
}

function LinkSvg({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="files-icon">
      <rect x="8" y="15" width="26" height="13" rx="3" fill="#7cc0ff" />
      <rect x="8" y="21" width="48" height="31" rx="4" fill="url(#flFolderGrad)" />
      <ellipse cx="13" cy="51" rx="11" ry="11" fill="#1f2126" />
      <path
        d="M8 56 L17 47 M11 47 L17 47 M17 47 L17 53"
        stroke="#e2e6ee"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FileSvg({ size, tint }: { size: number; tint: string | null }) {
  const line = tint ? 'rgba(255,255,255,0.59)' : '#9aa3b2'
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="files-icon">
      <path d="M15 8 L37 8 L49 20 L49 56 L15 56 Z" fill={tint ?? '#d6dde8'} />
      <path d="M37 8 L37 20 L49 20 Z" fill="rgba(0,0,0,0.27)" />
      <g stroke={line} strokeWidth="2" strokeLinecap="round">
        <line x1="21" y1="24" x2="43" y2="24" />
        <line x1="21" y1="31" x2="43" y2="31" />
        <line x1="21" y1="38" x2="43" y2="38" />
        <line x1="21" y1="45" x2="33" y2="45" />
      </g>
    </svg>
  )
}

function EntryIcon({ e, size }: { e: FileEntry; size: number }) {
  if (e.kind === 'dir') return <FolderSvg size={size} />
  if (e.kind === 'link') return <LinkSvg size={size} />
  return <FileSvg size={size} tint={tintFor(e)} />
}

// --- sorting (mirrors _sort_entries: key sort, then stable folders-first) -----
function sortEntries(list: FileEntry[], key: SortKey, desc: boolean): FileEntry[] {
  const out = list.slice()
  const cmp = (a: FileEntry, b: FileEntry): number => {
    let r = 0
    if (key === 'name') {
      const la = a.name.toLowerCase()
      const lb = b.name.toLowerCase()
      r = la < lb ? -1 : la > lb ? 1 : 0
    } else if (key === 'date') {
      r = a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0
    } else if (key === 'size') {
      r = (a.size ?? -1) - (b.size ?? -1)
    } else {
      const la = typeLabel(a).toLowerCase()
      const lb = typeLabel(b).toLowerCase()
      r = la < lb ? -1 : la > lb ? 1 : 0
    }
    return desc ? -r : r
  }
  out.sort(cmp)
  out.sort((a, b) => (a.kind !== 'dir' ? 1 : 0) - (b.kind !== 'dir' ? 1 : 0)) // folders first (stable)
  return out
}

export function FilesView({ c }: { c: Controller }) {
  // iOS browses an app container ('/'-rooted); Android starts at /sdcard.
  const ios = c.platform === 'ios'
  const homePath = ios ? '/' : DEFAULT_PATH
  const [path, setPath] = useState(homePath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [rootMode, setRootMode] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('details')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDesc, setSortDesc] = useState(false)
  const [status, setStatus] = useState('')
  const [listing, setListing] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [editing, setEditing] = useState(false)
  const [pathDraft, setPathDraft] = useState(homePath)
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const [openMenu, setOpenMenu] = useState<'sort' | 'view' | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [confirmDel, setConfirmDel] = useState<FileEntry[] | null>(null)
  const [dropHover, setDropHover] = useState(false)
  const [savedMsg, setSavedMsg] = useState<{ message: string; dir: string } | null>(null)

  // Refs mirror state for reads inside async continuations / event handlers.
  const serialRef = useRef(c.serial)
  serialRef.current = c.serial
  const pkgRef = useRef(c.appPkg)
  pkgRef.current = c.appPkg
  const pathRef = useRef(path)
  pathRef.current = path
  const rootModeRef = useRef(rootMode)
  rootModeRef.current = rootMode
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const sortKeyRef = useRef(sortKey)
  sortKeyRef.current = sortKey
  const sortDescRef = useRef(sortDesc)
  sortDescRef.current = sortDesc

  // History source-of-truth (state mirrors it for the disabled-button derives).
  const historyRef = useRef<string[]>([])
  const histIdxRef = useRef(-1)
  const listSeqRef = useRef(0)
  const pullBusyRef = useRef(false)
  const pushBusyRef = useRef(false)
  const opBusyRef = useRef(false)
  const openBusyRef = useRef(false)
  const pathEditRef = useRef<HTMLInputElement>(null)

  const countText = (p: string, n: number): string =>
    `${p}  —  ${n} item(s)${rootModeRef.current ? '  ·  root (su)' : ''}`

  // --- listing (DirListWorker; latest-wins via listSeqRef) --------------------
  function list(target: string, record: boolean): void {
    const s = serialRef.current
    if (!s) {
      entriesRef.current = []
      setEntries([])
      selectedRef.current = new Set()
      setSelected(new Set())
      setListing(false)
      setStatus('No device selected')
      return
    }
    const seq = ++listSeqRef.current
    setPathDraft(target)
    setListing(true)
    setSavedMsg(null)
    setStatus(`Opening ${target}…`)
    void window.androidlab.files.list(s, target, pkgRef.current, rootModeRef.current).then((res) => {
      if (seq !== listSeqRef.current) return
      setListing(false)
      if (!res.ok) {
        setStatus(`✗ ${res.error}`)
        setPathDraft(pathRef.current)
        return
      }
      pathRef.current = res.path
      setPath(res.path)
      setPathDraft(res.path)
      const sorted = sortEntries(res.entries, sortKeyRef.current, sortDescRef.current)
      entriesRef.current = sorted
      setEntries(sorted)
      selectedRef.current = new Set()
      setSelected(new Set())
      setAnchor(null)
      if (record) pushHistory(res.path)
      setStatus(countText(res.path, sorted.length))
    })
  }

  function pushHistory(p: string): void {
    const idx = histIdxRef.current
    const hist = historyRef.current
    if (idx >= 0 && hist[idx] === p) return
    const next = hist.slice(0, idx + 1)
    next.push(p)
    historyRef.current = next
    histIdxRef.current = next.length - 1
    setHistory(next)
    setHistIdx(next.length - 1)
  }

  const navigate = (target: string): void => list(target || '/', true)
  const refresh = (): void => list(pathRef.current, false)

  function goBack(): void {
    if (histIdxRef.current > 0) {
      histIdxRef.current -= 1
      setHistIdx(histIdxRef.current)
      list(historyRef.current[histIdxRef.current], false)
    }
  }
  function goForward(): void {
    if (histIdxRef.current < historyRef.current.length - 1) {
      histIdxRef.current += 1
      setHistIdx(histIdxRef.current)
      list(historyRef.current[histIdxRef.current], false)
    }
  }

  // Keep a ref to the latest list() so the device/app effects call the current
  // closure (this updater effect is declared first, so it runs first).
  const listRef = useRef(list)
  useEffect(() => {
    listRef.current = list
  })

  // Clear the browsing view (entries/selection/search) so the previous device's
  // or app's listing never lingers while the new one loads (or fails to).
  const clearView = (): void => {
    listSeqRef.current += 1 // invalidate any in-flight list from the old device
    entriesRef.current = []
    setEntries([])
    selectedRef.current = new Set()
    setSelected(new Set())
    setAnchor(null)
    setSearch('')
    setListing(false)
    setSavedMsg(null)
  }

  // Device change: empty the view, reset to the platform home (iOS container root
  // / Android /sdcard), clear history, re-list.
  useEffect(() => {
    clearView()
    historyRef.current = []
    histIdxRef.current = -1
    setHistory([])
    setHistIdx(-1)
    pathRef.current = homePath
    setPath(homePath)
    setPathDraft(homePath)
    listRef.current(homePath, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.serial])

  // App change: on iOS the whole container changes with the app → empty + reset;
  // on Android only a private path belongs to the previous app.
  useEffect(() => {
    const p = pathRef.current
    if (ios) {
      clearView()
      pathRef.current = homePath
      setPath(homePath)
      setPathDraft(homePath)
      listRef.current(homePath, true)
    } else if (p === DATA_DATA || p.startsWith(DATA_DATA + '/')) {
      listRef.current(homePath, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.appPkg])

  // Root (su) toggle: re-list the current directory (skip the mount run).
  const rootFirst = useRef(true)
  useEffect(() => {
    if (rootFirst.current) {
      rootFirst.current = false
      return
    }
    listRef.current(pathRef.current, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootMode])

  // --- selection --------------------------------------------------------------
  function selectedEntries(): FileEntry[] {
    const es = entriesRef.current
    return [...selectedRef.current]
      .sort((a, b) => a - b)
      .filter((i) => i >= 0 && i < es.length)
      .map((i) => es[i])
  }

  function onRowMouseDown(idx: number, ev: React.MouseEvent): void {
    if (ev.button === 2) {
      if (!selectedRef.current.has(idx)) {
        const s = new Set([idx])
        selectedRef.current = s
        setSelected(s)
        anchorRef.current = idx
        setAnchor(idx)
      }
      return
    }
    if (ev.shiftKey && anchorRef.current !== null) {
      const lo = Math.min(anchorRef.current, idx)
      const hi = Math.max(anchorRef.current, idx)
      const s = new Set<number>()
      for (let i = lo; i <= hi; i++) s.add(i)
      selectedRef.current = s
      setSelected(s)
    } else if (ev.metaKey || ev.ctrlKey) {
      const s = new Set(selectedRef.current)
      if (s.has(idx)) s.delete(idx)
      else s.add(idx)
      selectedRef.current = s
      setSelected(s)
      anchorRef.current = idx
      setAnchor(idx)
    } else {
      const s = new Set([idx])
      selectedRef.current = s
      setSelected(s)
      anchorRef.current = idx
      setAnchor(idx)
    }
  }

  function onActivate(idx: number): void {
    const e = entriesRef.current[idx]
    if (!e) return
    if (e.kind === 'dir' || e.kind === 'link') navigate(joinPath(pathRef.current, e.name))
    else void openEntry(e)
  }

  // --- transfers --------------------------------------------------------------
  async function openEntry(e: FileEntry): Promise<void> {
    const s = serialRef.current
    if (!s) return
    if (openBusyRef.current) {
      setStatus('A transfer is already running…')
      return
    }
    openBusyRef.current = true
    setStatus(`Opening ${e.name}…`)
    const r = await window.androidlab.files.open(s, pathRef.current, pkgRef.current, rootModeRef.current, e.name, e.kind)
    openBusyRef.current = false
    if (!r.ok) {
      setStatus(`✗ ${r.message}`)
      return
    }
    if (r.localPath) {
      void window.androidlab.system.openPath(r.localPath)
      setStatus(r.message)
    }
  }

  async function download(items: FileEntry[]): Promise<void> {
    const s = serialRef.current
    if (!s || items.length === 0) return
    if (pullBusyRef.current) {
      setStatus('A download is already running…')
      return
    }
    const dest = await window.androidlab.files.choosePullDir()
    if (!dest) return
    pullBusyRef.current = true
    setSavedMsg(null)
    setStatus(`Downloading ${items.length} item(s)…`)
    const payload = items.map((e) => ({ name: e.name, kind: e.kind }))
    const r = await window.androidlab.files.pull(s, pathRef.current, pkgRef.current, rootModeRef.current, payload, dest)
    pullBusyRef.current = false
    setStatus((r.ok ? '✓ ' : '✗ ') + r.message)
    if (r.ok) setSavedMsg({ message: r.message, dir: r.dir })
  }

  function downloadSelected(): void {
    const sel = selectedEntries()
    if (sel.length === 0) {
      setStatus('Select item(s) to download first')
      return
    }
    void download(sel)
  }

  async function upload(): Promise<void> {
    if (pushBusyRef.current) {
      setStatus('An upload is already running…')
      return
    }
    const files = await window.androidlab.files.choosePush()
    if (files.length) void pushLocals(files)
  }

  async function pushLocals(sources: string[]): Promise<void> {
    const s = serialRef.current
    if (!s || sources.length === 0) return
    if (pushBusyRef.current) {
      setStatus('An upload is already running…')
      return
    }
    pushBusyRef.current = true
    setStatus(`Uploading ${sources.length} item(s) to ${pathRef.current}…`)
    const r = await window.androidlab.files.push(s, pathRef.current, pkgRef.current, rootModeRef.current, sources)
    pushBusyRef.current = false
    setStatus((r.ok ? '✓ ' : '✗ ') + r.message)
    if (r.ok) refresh()
  }

  // --- file management --------------------------------------------------------
  async function runFileOp(p: Promise<{ ok: boolean; message: string }>): Promise<void> {
    if (opBusyRef.current) {
      setStatus('An operation is already running…')
      return
    }
    opBusyRef.current = true
    setStatus('Working…')
    const r = await p
    opBusyRef.current = false
    setStatus((r.ok ? '✓ ' : '✗ ') + r.message)
    if (r.ok) refresh()
  }

  function submitPrompt(value: string): void {
    const st = prompt
    setPrompt(null)
    if (!st) return
    const s = serialRef.current
    if (!s) return
    if (st.kind === 'newfolder') {
      void runFileOp(window.androidlab.files.mkdir(s, pathRef.current, pkgRef.current, rootModeRef.current, value))
    } else if (st.kind === 'rename' && st.original && value !== st.original) {
      void runFileOp(
        window.androidlab.files.rename(s, pathRef.current, pkgRef.current, rootModeRef.current, st.original, value)
      )
    }
  }

  function doDelete(items: FileEntry[]): void {
    setConfirmDel(null)
    const s = serialRef.current
    if (!s || items.length === 0) return
    void runFileOp(
      window.androidlab.files.delete(
        s,
        pathRef.current,
        pkgRef.current,
        rootModeRef.current,
        items.map((e) => e.name)
      )
    )
  }

  // --- context menu -----------------------------------------------------------
  function buildMenuItems(): MenuItem[] {
    const sel = selectedEntries()
    const items: MenuItem[] = []
    if (sel.length === 1 && (sel[0].kind === 'dir' || sel[0].kind === 'link')) {
      items.push({ label: 'Open', run: () => navigate(joinPath(pathRef.current, sel[0].name)) })
    } else if (sel.length === 1) {
      items.push({ label: 'Open', run: () => void openEntry(sel[0]) })
    }
    if (sel.length) items.push({ label: 'Download to Mac…', run: () => void download(sel) })
    items.push({ label: 'Upload here…', run: () => void upload() })
    items.push({ label: '—', run: () => {} })
    items.push({ label: 'New folder…', run: () => openNewFolder() })
    if (sel.length === 1) items.push({ label: 'Rename…', run: () => openRename(sel[0]) })
    if (sel.length) {
      items.push({
        label: 'Copy device path',
        run: () => {
          const p = joinPath(pathRef.current, sel[0].name)
          void navigator.clipboard.writeText(p)
          setStatus(`Copied ${p}`)
        }
      })
      items.push({ label: '—', run: () => {} })
      items.push({ label: `Delete ${sel.length} item(s)…`, run: () => setConfirmDel(sel) })
    }
    return items
  }

  function openContext(ev: React.MouseEvent, rowIdx?: number): void {
    ev.preventDefault()
    ev.stopPropagation()
    if (rowIdx !== undefined && !selectedRef.current.has(rowIdx)) {
      const s = new Set([rowIdx])
      selectedRef.current = s
      setSelected(s)
      anchorRef.current = rowIdx
      setAnchor(rowIdx)
    }
    setOpenMenu(null)
    setMenu({ x: ev.clientX, y: ev.clientY, items: buildMenuItems() })
  }

  function openNewFolder(): void {
    setPrompt({ kind: 'newfolder', title: 'New folder', label: 'Folder name:', initial: '' })
  }
  function openRename(e: FileEntry): void {
    setPrompt({ kind: 'rename', title: 'Rename', label: 'New name:', initial: e.name, original: e.name })
  }

  // --- address bar edit -------------------------------------------------------
  function beginEditPath(): void {
    setPathDraft(pathRef.current)
    setEditing(true)
    setTimeout(() => {
      pathEditRef.current?.focus()
      pathEditRef.current?.select()
    }, 0)
  }

  // --- drag-in (Finder → device); dialog Upload is the primary path -----------
  function onDrop(ev: React.DragEvent): void {
    ev.preventDefault()
    setDropHover(false)
    const paths: string[] = []
    for (const f of Array.from(ev.dataTransfer.files)) {
      try {
        const p = window.androidlab.files.pathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* sandbox can't resolve — fall back to the Upload button */
      }
    }
    if (paths.length) void pushLocals(paths)
    else setStatus('Could not read the dropped file(s) — use the Upload button')
  }

  // --- sort / view ------------------------------------------------------------
  function applySort(key: SortKey, desc: boolean): void {
    sortKeyRef.current = key
    sortDescRef.current = desc
    setSortKey(key)
    setSortDesc(desc)
    const sorted = sortEntries(entriesRef.current, key, desc)
    entriesRef.current = sorted
    setEntries(sorted)
    selectedRef.current = new Set()
    setSelected(new Set())
  }

  // --- derived render state ---------------------------------------------------
  const needle = search.trim().toLowerCase()
  const matches = (e: FileEntry): boolean => !needle || e.name.toLowerCase().includes(needle)
  const visibleCount = needle ? entries.filter(matches).length : entries.length
  const statusText = savedMsg
    ? null
    : needle
      ? `${visibleCount} of ${entries.length} match “${search}”`
      : status || countText(path, entries.length)

  const selCount = selected.size
  const canBack = histIdx > 0
  const canFwd = histIdx < history.length - 1
  const canUp = path !== '' && path !== '/'
  const appDataPath = c.appPkg ? `${DATA_DATA}/${c.appPkg}` : DATA_DATA

  const crumbs = (() => {
    const segs: Array<{ label: string; target: string }> = [{ label: 'This device', target: '/' }]
    let acc = ''
    for (const seg of path.split('/').filter(Boolean)) {
      acc += '/' + seg
      segs.push({ label: seg, target: acc })
    }
    return segs
  })()

  function renderPlace(pl: Place): React.ReactNode {
    const target = pl.needsApp ? appDataPath : pl.path
    const disabled = pl.needsApp && !c.appPkg
    const isSel = !disabled && target === path
    return (
      <div
        key={pl.label}
        className={`files-place${isSel ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
        title={disabled ? 'Pick an app in the list to browse its private data' : target}
        onClick={() => {
          if (disabled) {
            setStatus('Pick an app in the list to browse its private data')
            return
          }
          navigate(target)
        }}
      >
        <span className="files-place-dot" />
        {pl.label}
      </div>
    )
  }

  const closeMenus = (): void => {
    setMenu(null)
    setOpenMenu(null)
  }

  return (
    <div className="files-view" onClick={closeMenus}>
      {/* one-time gradient def shared by every folder icon */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <linearGradient id="flFolderGrad" x1="0" y1="22" x2="0" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7cc0ff" />
            <stop offset="1" stopColor="#54a0ff" />
          </linearGradient>
        </defs>
      </svg>

      {/* command bar */}
      <div className="files-cmdbar" onClick={(e) => e.stopPropagation()}>
        <button className="files-cmd" onClick={openNewFolder} disabled={!c.serial}>
          <Icon name="folderPlus" size={15} />
          New folder
        </button>
        <button className="files-cmd" onClick={() => void upload()} disabled={!c.serial} title="Push file(s) from this Mac into the current folder">
          <Icon name="upload" size={15} />
          Upload
        </button>
        <button className="files-cmd" onClick={downloadSelected} disabled={selCount === 0} title="Pull the selected item(s) to this Mac">
          <Icon name="download" size={15} />
          Download
        </button>
        <span className="files-cmd-sep" />
        <button className="files-cmd" onClick={() => { const s = selectedEntries(); if (s.length === 1) openRename(s[0]) }} disabled={selCount !== 1}>
          <Icon name="edit" size={15} />
          Rename
        </button>
        <button className="files-cmd" onClick={() => { const s = selectedEntries(); if (s.length) setConfirmDel(s) }} disabled={selCount === 0}>
          <Icon name="trash" size={15} />
          Delete
        </button>
        <span className="grow" />
        <div className="files-dropdown">
          <button className="files-cmd" onClick={(e) => { e.stopPropagation(); setMenu(null); setOpenMenu(openMenu === 'sort' ? null : 'sort') }}>
            Sort
            <Icon name="chevronDown" size={13} />
          </button>
          {openMenu === 'sort' ? (
            <div className="files-menu" onClick={(e) => e.stopPropagation()}>
              {(
                [
                  ['name', 'Name'],
                  ['date', 'Date modified'],
                  ['type', 'Type'],
                  ['size', 'Size']
                ] as Array<[SortKey, string]>
              ).map(([k, label]) => (
                <div key={k} className={`item${sortKey === k ? ' checked' : ''}`} onClick={() => { applySort(k, sortDesc); setOpenMenu(null) }}>
                  {sortKey === k ? '✓ ' : '   '}
                  {label}
                </div>
              ))}
              <div className="sep" />
              <div className={`item${!sortDesc ? ' checked' : ''}`} onClick={() => { applySort(sortKey, false); setOpenMenu(null) }}>
                {!sortDesc ? '✓ ' : '   '}Ascending
              </div>
              <div className={`item${sortDesc ? ' checked' : ''}`} onClick={() => { applySort(sortKey, true); setOpenMenu(null) }}>
                {sortDesc ? '✓ ' : '   '}Descending
              </div>
            </div>
          ) : null}
        </div>
        <div className="files-dropdown">
          <button className="files-cmd" onClick={(e) => { e.stopPropagation(); setMenu(null); setOpenMenu(openMenu === 'view' ? null : 'view') }}>
            View
            <Icon name="chevronDown" size={13} />
          </button>
          {openMenu === 'view' ? (
            <div className="files-menu" onClick={(e) => e.stopPropagation()}>
              <div className={`item${viewMode === 'details' ? ' checked' : ''}`} onClick={() => { setViewMode('details'); setOpenMenu(null) }}>
                {viewMode === 'details' ? '✓ ' : '   '}Details
              </div>
              <div className={`item${viewMode === 'icons' ? ' checked' : ''}`} onClick={() => { setViewMode('icons'); setOpenMenu(null) }}>
                {viewMode === 'icons' ? '✓ ' : '   '}Large icons
              </div>
            </div>
          ) : null}
        </div>
        {!ios ? (
          <label className="checkbox" title="Run as root on a rooted device (reach otherwise-locked paths)">
            <input type="checkbox" checked={rootMode} onChange={(e) => setRootMode(e.target.checked)} />
            Root (su)
          </label>
        ) : null}
      </div>

      {/* navigation / address bar */}
      <div className="files-navbar" onClick={(e) => e.stopPropagation()}>
        <button className="files-navbtn" onClick={goBack} disabled={!canBack} title="Back">
          <Icon name="chevronLeft" size={16} />
        </button>
        <button className="files-navbtn" onClick={goForward} disabled={!canFwd} title="Forward">
          <Icon name="chevronRight" size={16} />
        </button>
        <button className="files-navbtn" onClick={() => navigate(parentPath(path))} disabled={!canUp} title="Up">
          <Icon name="arrowUp" size={16} />
        </button>
        <button className="files-navbtn" onClick={refresh} title="Refresh">
          <Icon name="refresh" size={16} />
        </button>
        <div className="files-address" onClick={() => { if (!editing) beginEditPath() }}>
          {editing ? (
            <input
              ref={pathEditRef}
              className="files-path-edit"
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setEditing(false)
                  navigate(pathDraft.trim() || '/')
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
              }}
              onBlur={() => setEditing(false)}
            />
          ) : (
            <div className="files-crumbs">
              {crumbs.map((seg, i) => (
                <span key={seg.target}>
                  {i > 0 ? <span className="files-crumb-sep">›</span> : null}
                  <button
                    className="files-crumb"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(seg.target)
                    }}
                  >
                    {seg.label}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <input
          className="files-search"
          type="text"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* sidebar | main view */}
      <div className="files-split">
        <div className="files-sidebar" onClick={(e) => e.stopPropagation()}>
          <div className="files-side-header">Quick access</div>
          {(ios ? IOS_QUICK_ACCESS : QUICK_ACCESS).map(renderPlace)}
          <div className="files-side-header">{ios ? 'Container' : 'This device'}</div>
          {(ios ? IOS_LOCATIONS : LOCATIONS).map(renderPlace)}
        </div>

        <div
          className={`files-main${dropHover ? ' drop-hover' : ''}`}
          onContextMenu={(e) => openContext(e)}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dropHover) setDropHover(true)
          }}
          onDragLeave={() => setDropHover(false)}
          onDrop={onDrop}
        >
          {listing ? <div className="files-busy" /> : null}
          {viewMode === 'details' ? (
            <div className="files-table-wrap">
              <table className="files-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Date modified</th>
                    <th>Type</th>
                    <th className="num">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) =>
                    matches(e) ? (
                      <tr
                        key={i}
                        className={selected.has(i) ? 'selected' : ''}
                        onMouseDown={(ev) => onRowMouseDown(i, ev)}
                        onDoubleClick={() => onActivate(i)}
                        onContextMenu={(ev) => openContext(ev, i)}
                      >
                        <td className="name" title={e.linkTarget ? `${e.name} → ${e.linkTarget}` : e.name}>
                          <span className="files-cell-icon">
                            <EntryIcon e={e} size={18} />
                          </span>
                          {e.name}
                        </td>
                        <td>{e.modified}</td>
                        <td>{typeLabel(e)}</td>
                        <td className="num">{e.kind === 'dir' ? '' : humanSize(e.size)}</td>
                      </tr>
                    ) : null
                  )}
                </tbody>
              </table>
              {entries.length === 0 && !listing ? (
                <div className="files-empty">
                  <div className="glyph">🗂</div>
                  <div className="title">{c.serial ? 'Empty folder' : 'No device selected'}</div>
                  <div className="sub">{c.serial ? 'This directory has no entries.' : 'Pick a device in the toolbar.'}</div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="files-grid-wrap">
              <div className="files-grid">
                {entries.map((e, i) =>
                  matches(e) ? (
                    <div
                      key={i}
                      className={`files-tile${selected.has(i) ? ' selected' : ''}`}
                      title={e.linkTarget ? `${e.name} → ${e.linkTarget}` : e.name}
                      onMouseDown={(ev) => onRowMouseDown(i, ev)}
                      onDoubleClick={() => onActivate(i)}
                      onContextMenu={(ev) => openContext(ev, i)}
                    >
                      <EntryIcon e={e} size={48} />
                      <span className="files-tile-name">{e.name}</span>
                    </div>
                  ) : null
                )}
              </div>
              {entries.length === 0 && !listing ? (
                <div className="files-empty">
                  <div className="glyph">🗂</div>
                  <div className="title">{c.serial ? 'Empty folder' : 'No device selected'}</div>
                  <div className="sub">{c.serial ? 'This directory has no entries.' : 'Pick a device in the toolbar.'}</div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* status bar */}
      <div className="files-status">
        {savedMsg ? (
          <span className="files-saved">
            ✓ {savedMsg.message}
            {savedMsg.dir ? (
              <button className="toggle" onClick={() => void window.androidlab.system.openPath(savedMsg.dir)}>
                Open folder
              </button>
            ) : null}
          </span>
        ) : (
          <span>{statusText}</span>
        )}
      </div>

      {/* right-click menu */}
      {menu ? (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) =>
            it.label === '—' ? (
              <div key={i} className="sep" />
            ) : (
              <div
                key={i}
                className="item"
                onClick={() => {
                  it.run()
                  closeMenus()
                }}
              >
                {it.label}
              </div>
            )
          )}
        </div>
      ) : null}

      {prompt ? (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          onCancel={() => setPrompt(null)}
          onSubmit={submitPrompt}
        />
      ) : null}

      {confirmDel ? (
        <div className="scrim" onMouseDown={() => setConfirmDel(null)}>
          <div className="msgbox" onMouseDown={(e) => e.stopPropagation()}>
            <div className="title">Delete from device</div>
            <div className="body">
              Delete {confirmDel.length} item(s) from the device?
              {'\n\n'}
              {confirmDel.map((e) => e.name).join(', ')}
              {'\n\n'}
              This is permanent — files are removed on the device.
            </div>
            <div className="buttons">
              <button onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="start running" onClick={() => doDelete(confirmDel)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
