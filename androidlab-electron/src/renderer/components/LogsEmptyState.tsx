/**
 * Guided placeholder for the Logs work area — shown whenever the filtered log
 * view is empty (rowCount === 0). Instead of a blank pane it reads the device /
 * stream / filter state and walks the user to the next step: find adb → connect
 * a device → pick one → press Start → (streaming) wait for output, or relax the
 * filters when everything is filtered out. Actions call straight into the
 * controller so the placeholder is functional, not just decorative. The visual
 * shell is the shared <EmptyState>; this file only decides which scene to show.
 */
import { EmptyState, type EmptyAction, type EmptyStateProps } from './EmptyState'
import type { Controller } from '../state/useAppController'

function fieldFilterActive(c: Controller): boolean {
  const f = c.filter
  return (
    f.level !== 0 ||
    f.text.trim() !== '' ||
    f.tag.trim() !== '' ||
    f.pids.trim() !== '' ||
    f.exclude.trim() !== ''
  )
}

function buildScene(c: Controller, onOpenLog: () => void): EmptyStateProps {
  const openLog: EmptyAction = { label: 'Open a log file…', icon: 'folder', onClick: onOpenLog }
  const deviceLabel = c.devices.find((d) => d.serial === c.serial)?.label ?? c.serial ?? ''
  // The label is "<serial> — <desc> [state]"; the human-friendly middle is enough here.
  const deviceName = deviceLabel.split(' — ')[1]?.replace(/\s*\[.*\]$/, '') || deviceLabel

  // 1. adb still being located on startup — brief.
  if (!c.adbReady) {
    return { icon: 'clock', title: 'Looking for adb…', body: 'Locating the Android platform-tools.' }
  }

  // 2. adb binary not found.
  if (!c.adbPath) {
    return {
      icon: 'laptop',
      title: 'adb not found',
      body: (
        <>
          MobileLabKit needs the Android <b>platform-tools</b>. Install them, then set the{' '}
          <b>$ADB</b> environment variable or add <b>adb</b> to your PATH and relaunch. You can still
          open a saved log file in the meantime.
        </>
      ),
      actions: [{ ...openLog, primary: true }]
    }
  }

  // 3. No devices visible to adb.
  if (c.devices.length === 0) {
    return {
      icon: 'phone',
      title: 'No device connected',
      body: (
        <>
          Connect an Android device over USB with <b>USB debugging</b> enabled — or pair one over
          Wi-Fi — then refresh the device list.
        </>
      ),
      actions: [
        { label: 'Refresh devices', icon: 'refresh', primary: true, onClick: () => void c.refreshDevices() },
        openLog
      ],
      hint: 'On the device: Settings ▸ Developer options ▸ USB debugging'
    }
  }

  // 4. Devices exist but none is selected (rare — refresh auto-picks one).
  if (!c.serial) {
    return {
      icon: 'phone',
      title: 'Select a device',
      body: <>Pick a device from the <b>Device</b> menu at the top to start collecting logs.</>,
      actions: [
        { label: 'Refresh devices', icon: 'refresh', primary: true, onClick: () => void c.refreshDevices() }
      ]
    }
  }

  const total = c.store.totalCount()

  // 5/6. A device is selected and nothing is buffered yet.
  if (total === 0) {
    if (c.streaming) {
      return {
        icon: 'bolt',
        pulse: true,
        title: 'Listening for logs…',
        body: (
          <>
            Streaming from <b>{deviceName}</b>. New lines appear here as the device logs them —
            interact with the app to generate some.
          </>
        )
      }
    }
    return {
      icon: 'play',
      title: 'Ready to collect logs',
      body: (
        <>
          Press <b>Start</b> to begin streaming logcat from <b>{deviceName}</b>.
        </>
      ),
      actions: [
        { label: 'Start collecting', icon: 'play', primary: true, onClick: () => void c.toggleStream() },
        openLog
      ]
    }
  }

  // 7. Lines are buffered but the current filters hide every one of them.
  const byField = fieldFilterActive(c)
  const byApp = !!c.appPkg
  const actions: EmptyAction[] = []
  if (byField) actions.push({ label: 'Clear filters', icon: 'close', primary: true, onClick: c.clearFilters })
  if (byApp) {
    actions.push({
      label: 'Show all apps',
      icon: 'eye',
      primary: !byField,
      onClick: () => void c.selectApp(null)
    })
  }
  const n = total.toLocaleString()
  return {
    icon: 'filter',
    title: 'No matching lines',
    body:
      byApp && !byField ? (
        <>
          {n} line{total !== 1 ? 's' : ''} buffered, but none are from <b>{c.appPkg}</b>.
        </>
      ) : (
        <>
          {n} line{total !== 1 ? 's' : ''} buffered — all hidden by your current filters.
        </>
      ),
    actions: actions.length ? actions : undefined
  }
}

export function LogsEmptyState({ c, onOpenLog }: { c: Controller; onOpenLog: () => void }) {
  return <EmptyState {...buildScene(c, onOpenLog)} />
}
