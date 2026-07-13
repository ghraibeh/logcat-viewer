/**
 * Filter specification and matching, logcat-style (level / tag / PID / regex text).
 * Faithful port of logcat_viewer/filters.py.
 *
 * Regex note: user-entered patterns are compiled with JavaScript's RegExp (the
 * `i` flag == Python's re.IGNORECASE). The vast majority of logcat filter
 * patterns are syntactically identical across the two engines; the handful of
 * Python-only constructs (e.g. inline `(?P<name>)`) are the accepted, documented
 * difference. Invalid patterns disable that one field and record an error,
 * exactly like the Python version — the stream keeps flowing.
 */
import type { LogEntry } from './parser'
import { PRIORITY } from './priorities'

export interface FilterSpecInit {
  minPriority?: number
  tagQuery?: string
  tagRegex?: boolean
  pids?: string
  packageName?: string
  packagePids?: ReadonlySet<number> | null
  textQuery?: string
  textRegex?: boolean
  excludeQuery?: string
  excludeRegex?: boolean
}

export class FilterSpec {
  minPriority: number
  tagQuery: string
  tagRegex: boolean
  pids: string
  packageName: string
  packagePids: ReadonlySet<number> | null
  textQuery: string
  textRegex: boolean
  excludeQuery: string
  excludeRegex: boolean

  // populated by compile()
  private _tagRe: RegExp | null = null
  private _textRe: RegExp | null = null
  private _excludeRe: RegExp | null = null
  private _tagTerms: string[] = []
  private _textTerms: string[] = []
  private _excludeTerms: string[] = []
  private _pidSet: Set<number> = new Set()
  errors: Record<string, string> = {}

  constructor(init: FilterSpecInit = {}) {
    this.minPriority = init.minPriority ?? PRIORITY.V
    this.tagQuery = init.tagQuery ?? ''
    this.tagRegex = init.tagRegex ?? false
    this.pids = init.pids ?? ''
    this.packageName = init.packageName ?? ''
    this.packagePids = init.packagePids ?? null
    this.textQuery = init.textQuery ?? ''
    this.textRegex = init.textRegex ?? false
    this.excludeQuery = init.excludeQuery ?? ''
    this.excludeRegex = init.excludeRegex ?? false
  }

  /**
   * Precompile regexes / parse PIDs. Invalid regex in a field disables that
   * field (pass-through) and records an error message under its key.
   */
  compile(): this {
    this.errors = {}
    ;[this._tagRe, this._tagTerms] = this._compileField('tag', this.tagQuery, this.tagRegex)
    ;[this._textRe, this._textTerms] = this._compileField('text', this.textQuery, this.textRegex)
    ;[this._excludeRe, this._excludeTerms] = this._compileField(
      'exclude',
      this.excludeQuery,
      this.excludeRegex
    )

    const pids = new Set<number>()
    for (const tok of this.pids.trim().split(/[\s,]+/)) {
      if (/^\d+$/.test(tok)) {
        pids.add(parseInt(tok, 10))
      } else if (tok) {
        this.errors.pid = `not a PID: ${tok}`
      }
    }
    this._pidSet = pids
    return this
  }

  /**
   * Return [compiledRegexOrNull, substringTerms]. In substring mode a query is
   * split on "|" into OR-terms — `error|success` matches lines with either
   * word; empty terms (e.g. a trailing `|`) are ignored.
   */
  private _compileField(key: string, query: string, isRegex: boolean): [RegExp | null, string[]] {
    if (!query) {
      return [null, []]
    }
    if (!isRegex) {
      const terms = query
        .split('|')
        .map((p) => p.trim().toLowerCase())
        .filter((t) => t.length > 0)
      return [null, terms]
    }
    try {
      return [new RegExp(query, 'i'), []]
    } catch (exc) {
      this.errors[key] = exc instanceof Error ? exc.message : String(exc)
      return [null, []] // invalid -> treat field as inactive so log keeps flowing
    }
  }

  hasError(key: string): boolean {
    return key in this.errors
  }

  match(e: LogEntry): boolean {
    if (e.priority < this.minPriority) {
      return false
    }

    if (this.packagePids !== null && !this.packagePids.has(e.pid)) {
      return false
    }

    if (this._pidSet.size > 0 && !this._pidSet.has(e.pid)) {
      return false
    }

    if (this._tagRe !== null) {
      if (!this._tagRe.test(e.tag)) {
        return false
      }
    } else if (this._tagTerms.length > 0) {
      // substring OR: keep if the tag has ANY term
      const tag = e.tag.toLowerCase()
      if (!this._tagTerms.some((t) => tag.includes(t))) {
        return false
      }
    }

    if (this._textRe !== null) {
      if (!this._textRe.test(e.raw)) {
        return false
      }
    } else if (this._textTerms.length > 0) {
      // substring OR: keep if a term is in tag+message
      if (!this._textTerms.some((t) => e.search.includes(t))) {
        return false
      }
    }

    if (this._excludeRe !== null) {
      if (this._excludeRe.test(e.raw)) {
        return false
      }
    } else if (this._excludeTerms.length > 0) {
      // substring OR: hide if ANY term is present
      if (this._excludeTerms.some((t) => e.search.includes(t))) {
        return false
      }
    }

    return true
  }
}
