// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied 2026-11-20.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
// Settings, paths, and ignore/skip lists for prompt-grammar.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { GrammarFix } from './types'

export type Dialect = 'any' | 'us' | 'uk'
export const RENDER_MODES = ['entry', 'widget', 'both', 'off'] as const
export type RenderMode = (typeof RENDER_MODES)[number]

/** Normalize a render mode setting. */
export const normalizeRender = (value: unknown): RenderMode | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const norm = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return RENDER_MODES.includes(norm as RenderMode) ? (norm as RenderMode) : undefined
}

export type Settings = {
  enabled: boolean
  natural: boolean
  language: string
  dialect: Dialect
  minWords: number
  maxChars: number
  showWhy: boolean
  history: boolean
  clean: boolean
  askMemory: boolean
  /** How prompt fixes are shown: 'entry' (default), 'widget', 'both', or 'off'. */
  render: RenderMode
  /** Model spec: 'auto' (default), 'off', or '<provider>/<modelId>'. */
  model: string
  /** Optional text appended to the system prompt on model calls (e.g. '<|think_off|>'). */
  systemPromptAppend: string
  /** Optional override appended to the system prompt on `/grammar review` and `/grammar ask` (inherits `systemPromptAppend` when `undefined`; `""` appends nothing). */
  systemPromptAppendReviewer: string | undefined
  /** Max time (ms) a live prompt check waits before aborting. */
  timeoutMs: number
}

export const AUTO = 'auto'
export const ENGLISH = 'English'

/** A language's name as kept and compared: trimmed, each word capitalized ("brazilian portuguese" -> "Brazilian Portuguese"). */
export const languageOf = (x: unknown): string | undefined => {
  const w = typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : ''
  if (w === '' || w.length > 40) {
    return undefined
  }
  if (w.toLowerCase() === AUTO) {
    return AUTO
  }
  return w
    .split(' ')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ')
}

/** The `language` setting as kept: one name, several joined by ", ", or 'auto'. */
export const languageSetting = (x: unknown): string | undefined => {
  const names = (typeof x === 'string' ? x.split(',') : []).map(languageOf).filter((n): n is string => n !== undefined)
  if (names.includes(AUTO)) {
    return AUTO
  }
  const unique = [...new Set(names)]
  return unique.length === 0 ? undefined : unique.join(', ')
}

/** The languages a setting names, in its order: [] for auto. */
export const languagesOf = (setting: string) => (setting === AUTO ? [] : setting.split(', '))

/** Names in a sentence: "French", "English or French", "English, French or German". */
export const joinNames = (names: readonly string[], and = 'or') =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`

/**
 * The language a check is kept under: the reply's in auto, the one set when there is one, and in a list the listed one the
 * reply names (a whole-word match, so "American English" is English), undefined when it names none of them.
 */
export const keptLanguage = (setting: string, said: string): string | undefined => {
  const names = languagesOf(setting)
  if (names.length === 0) {
    return said
  }
  if (names.length === 1) {
    return setting
  }
  const words = ` ${said.toLowerCase()} `
  return (
    names.find(n => n.toLowerCase() === said.toLowerCase()) ??
    [...names].sort((a, b) => b.length - a.length).find(n => words.includes(` ${n.toLowerCase()} `))
  )
}

/** Two letters in any script: something to check. */
export const LETTERS = /\p{L}{2}/u

/** What a prompt needs to be worth a check: two Latin letters for English alone, two letters of any script otherwise. */
export const lettersFor = (setting: string) => (setting === ENGLISH ? /[A-Za-z]{2}/ : LETTERS)

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

const modelOf = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    return AUTO
  }
  const lower = raw.toLowerCase()
  return lower === AUTO || lower === 'off' ? lower : raw
}

/** Build typed Settings from a raw JSON config object, falling back to defaults. */
export const settingsFrom = (o: Record<string, unknown> = {}): Settings => ({
  enabled: o.enabled !== false,
  natural: o.natural !== false,
  language: languageSetting(o.language) ?? ENGLISH,
  dialect: pick(o.dialect, ['any', 'us', 'uk'] as const, 'any'),
  minWords: clamp(o.min_words, 1, 50, 2),
  maxChars: clamp(o.max_chars, 200, 20000, 6000),
  showWhy: o.show_why !== false,
  history: o.history !== false,
  clean: o.clean !== false,
  askMemory: o.ask_memory !== false,
  render: normalizeRender(o.render) ?? 'entry',
  model: modelOf(o.model),
  systemPromptAppend: typeof o.system_prompt_append === 'string' ? o.system_prompt_append.trim() : '',
  systemPromptAppendReviewer:
    typeof o.system_prompt_append_reviewer === 'string' ? o.system_prompt_append_reviewer.trim() : undefined,
  timeoutMs: clamp(o.timeout_ms, 2000, 120000, 30000),
})

/** Ignore/skip lists plus per-project history flag from a grammar.json file. */
export type Lists = { ignore: string[]; skip: string[]; history: boolean }

export const EMPTY: Lists = { ignore: [], skip: [], history: true }
const CAP = 200

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : []

/** A grammar.json's lists. Throws when the text is not a JSON object. */
export const parseLists = (text: string): Lists => {
  const raw = JSON.parse(text) as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a JSON object')
  }
  const o = raw as Record<string, unknown>
  return { ignore: strings(o.ignore), skip: strings(o.skip), history: o.history !== false }
}

/** Lists from several files, joined without repeats, each capped. */
export const mergeLists = (...all: Lists[]): Lists => ({
  ignore: [...new Set(all.flatMap(l => l.ignore))].slice(0, CAP),
  skip: [...new Set(all.flatMap(l => l.skip))].slice(0, CAP),
  history: all.every(l => l.history),
})

const SLASHED = /^\/(.+)\/([a-z]*)$/

const regexOf = (entry: string, defaultFlags = ''): RegExp | null | undefined => {
  const m = SLASHED.exec(entry)
  if (m === null) {
    return null
  }
  const [, source = '', flags = ''] = m
  try {
    return new RegExp(source, (flags || defaultFlags).replace(/[gy]/g, ''))
  } catch {
    return undefined
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const wordRegex = (word: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(word)}($|[^\\p{L}\\p{N}_])`, 'iu')

export type Ignore = { words: string[]; matchers: RegExp[] }

export const compileIgnore = (entries: readonly string[]): Ignore => {
  const words: string[] = []
  const matchers: RegExp[] = []
  for (const entry of entries) {
    const re = regexOf(entry, 'i')
    if (re === null) {
      words.push(entry)
      matchers.push(wordRegex(entry))
    } else if (re !== undefined) {
      matchers.push(re)
    }
  }
  return { words, matchers }
}

export const isIgnored = (ignore: Ignore, s: string) => ignore.matchers.some(re => re.test(s))

export const compileSkip = (entries: readonly string[]): RegExp[] =>
  entries.flatMap(entry => {
    const re = regexOf(entry)
    if (re !== null) {
      return re === undefined ? [] : [re]
    }
    try {
      return [new RegExp(entry, 'i')]
    } catch {
      return []
    }
  })

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu

export const wordCount = (text: string) => {
  const unspaced = (text.match(UNSPACED) ?? []).reduce((n, run) => n + Math.ceil([...run].length / 2), 0)
  return unspaced + (text.replace(UNSPACED, ' ').match(/\p{L}+(['’]\p{L}+)*/gu) ?? []).length
}

export const cut = (text: string, max: number) => {
  if (text.length <= max) {
    return text
  }
  const head = text.slice(0, max)
  const space = head.search(/\s\S*$/)
  return space > max / 2 ? head.slice(0, space) : head
}

export const applyFixes = (text: string, fixes: readonly GrammarFix[]) =>
  fixes.reduce((t, f) => {
    const i = t.toLowerCase().indexOf(f.from.toLowerCase())
    return i < 0 ? t : t.slice(0, i) + f.to + t.slice(i + f.from.length)
  }, text)

export const entriesFrom = (args: string) =>
  (args.includes(',') ? args.split(',') : args.split(/\s+/)).map(s => s.trim()).filter(s => s !== '')

// --- Filesystem paths & persistence ---

export type Paths = {
  agentDir: string
  globalConfig: string
  projectConfig?: string
  historyFile: string
}

/** Resolve global config (`<agentDir>/grammar.json`), history (`<agentDir>/grammar-history.json`), and trusted project config (`<cwd>/.pi/grammar.json`). */
export const resolvePaths = (agentDir: string, cwd?: string, projectTrusted = false): Paths => {
  const rootAgentDir = agentDir.replace(/[\\/]+$/, '')
  const projectConfig =
    projectTrusted && cwd && cwd.trim() !== ''
      ? join(cwd.replace(/[\\/]+$/, ''), '.pi', 'grammar.json')
      : undefined
  return {
    agentDir: rootAgentDir,
    globalConfig: join(rootAgentDir, 'grammar.json'),
    projectConfig,
    historyFile: join(rootAgentDir, 'grammar-history.json'),
  }
}

export const readRawConfig = (path: string): { raw: Record<string, unknown>; error?: string } => {
  if (!existsSync(path)) {
    return { raw: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw: {}, error: 'not a JSON object' }
    }
    return { raw: parsed as Record<string, unknown> }
  } catch (err) {
    return { raw: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

export const loadConfigAndLists = (
  paths: Paths,
): { settings: Settings; lists: Lists; projectAllowsHistory: boolean; warnings: string[] } => {
  const warnings: string[] = []
  const g = readRawConfig(paths.globalConfig)
  if (g.error !== undefined) {
    warnings.push(`${paths.globalConfig} is ignored: ${g.error}`)
  }
  const globalLists: Lists = g.error === undefined ? parseLists(JSON.stringify(g.raw)) : EMPTY

  let projectRaw: Record<string, unknown> = {}
  let projectLists: Lists = EMPTY
  if (paths.projectConfig && paths.projectConfig !== paths.globalConfig && existsSync(paths.projectConfig)) {
    const p = readRawConfig(paths.projectConfig)
    if (p.error !== undefined) {
      warnings.push(`${paths.projectConfig} is ignored: ${p.error}`)
    } else {
      projectRaw = p.raw
      projectLists = parseLists(JSON.stringify(p.raw))
    }
  }

  // Project settings can override global settings except `model`, `system_prompt_append`, and `system_prompt_append_reviewer` for safety.
  const mergedRaw: Record<string, unknown> = { ...g.raw, ...projectRaw }
  for (const key of ['model', 'system_prompt_append', 'system_prompt_append_reviewer'] as const) {
    if (g.raw[key] !== undefined) {
      mergedRaw[key] = g.raw[key]
    } else {
      delete mergedRaw[key]
    }
  }
  const settings = settingsFrom(mergedRaw)
  const lists = mergeLists(globalLists, projectLists)
  return { settings, lists, projectAllowsHistory: projectLists.history, warnings }
}

/** Atomically update a key in the global grammar.json, preserving all other fields. */
export const writeGlobalField = (globalConfigPath: string, key: string, value: unknown): { ok: true } | { ok: false; error: string } => {
  const existing = readRawConfig(globalConfigPath)
  if (existing.error !== undefined) {
    return { ok: false, error: `${globalConfigPath} does not parse (${existing.error}), so it was left as it is. Fix it by hand.` }
  }
  const next = { ...existing.raw, [key]: value }
  if (value === undefined) {
    delete next[key]
  }
  mkdirSync(dirname(globalConfigPath), { recursive: true })
  const tmp = `${globalConfigPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Best-effort permission tightening on POSIX.
  }
  renameSync(tmp, globalConfigPath)
  return { ok: true }
}

export const CONFIG_KEYS = [
  'enabled',
  'natural',
  'language',
  'dialect',
  'min_words',
  'max_chars',
  'show_why',
  'history',
  'clean',
  'ask_memory',
  'render',
  'model',
  'system_prompt_append',
  'system_prompt_append_reviewer',
  'timeout_ms',
] as const
