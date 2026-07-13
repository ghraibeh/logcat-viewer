/**
 * Android log priorities (matches android.util.Log constants).
 * Faithful port of logcat_viewer/parser.py's PRIORITY / LEVEL_NAMES.
 */
export const PRIORITY: Record<string, number> = {
  V: 2,
  D: 3,
  I: 4,
  W: 5,
  E: 6,
  F: 7,
  S: 8
}

export const LEVEL_NAMES: Record<number, string> = {
  2: 'Verbose',
  3: 'Debug',
  4: 'Info',
  5: 'Warn',
  6: 'Error',
  7: 'Fatal',
  8: 'Silent'
}

/**
 * Unparseable lines are treated as Verbose so the most permissive level still
 * shows them, but any raised level threshold hides the noise.
 */
export const UNKNOWN_PRIORITY = PRIORITY.V
