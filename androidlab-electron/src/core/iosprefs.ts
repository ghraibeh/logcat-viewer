/**
 * iOS NSUserDefaults → the SAME `Pref` shape the Android SharedPreferences editor
 * (`PrefsView`) renders, so that view is reused unchanged for iOS. An app's
 * defaults live in `Library/Preferences/<bundleId>.plist`; the main process pulls
 * it via fsync and converts it with macOS `plutil -convert json1`, then this pure
 * helper flattens the top-level dictionary to typed rows. DOM-/fs-free.
 *
 * Types are inferred from the JSON (plutil collapses int/real to numbers, data →
 * base64 string, date → ISO string). Nested arrays/dicts are shown read-only as a
 * compact JSON string under the `set` type (which PrefsView already treats as a
 * non-editable flattened view).
 */
import type { Pref } from './prefs'

function prefFor(key: string, v: unknown): Pref {
  if (typeof v === 'boolean') return { key, type: 'boolean', value: v ? 'true' : 'false' }
  if (typeof v === 'number') return { key, type: Number.isInteger(v) ? 'int' : 'float', value: String(v) }
  if (typeof v === 'string') return { key, type: 'string', value: v }
  // arrays / nested dicts / null → read-only JSON view (PrefsView shows `set` flat)
  return { key, type: 'set', value: JSON.stringify(v) }
}

/** Flatten the top-level dict of a `plutil -convert json1` document to Pref[]. */
export function plistJsonToPrefs(jsonText: string): Pref[] {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return []
  const out: Pref[] = []
  for (const [key, v] of Object.entries(root as Record<string, unknown>)) {
    out.push(prefFor(key, v))
  }
  out.sort((a, b) => {
    const la = a.key.toLowerCase()
    const lb = b.key.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return out
}
