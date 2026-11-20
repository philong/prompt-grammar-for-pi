// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied 2026-11-20.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
// Persistent history file helpers and branch-rebuilt session state for prompt-grammar.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { ENGLISH } from './config'
import { ASK_MEMORY, EMPTY_HISTORY, historyText, parseHistory, record } from './history'
import type { History } from './history'
import type { GrammarCheck, GrammarFix, GrammarTurn } from './types'

export const MAX_FAILS = 3
export const MAX_RECENT_FIXES = 20

export type SessionState = {
  fails: number
  lastError?: string
  streak: number
  recentFixes: (GrammarFix & { language?: string })[]
  thread: GrammarTurn[]
}

export const emptySession = (): SessionState => ({
  fails: 0,
  streak: 0,
  recentFixes: [],
  thread: [],
})

/** Structural subset of Pi's `SessionEntry` so state.ts has no host import. */
export type BranchEntryLike = {
  type: string
  customType?: string
  data?: unknown
}

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

const isFix = (x: unknown): x is GrammarFix =>
  isRecord(x) && typeof x.from === 'string' && typeof x.to === 'string' && typeof x.why === 'string'

/** Apply one check outcome to session state (shared by live checks and branch rebuild). */
export const applyCheckOutcome = (
  state: SessionState,
  check: Pick<GrammarCheck, 'status' | 'fixes' | 'natural' | 'error' | 'language'>,
): SessionState => {
  if (check.status === 'skipped') {
    return {
      ...state,
      fails: 0,
      lastError: undefined,
    }
  }
  if (check.status === 'error') {
    return {
      ...state,
      fails: state.fails + 1,
      lastError: check.error ?? state.lastError,
    }
  }
  const clean = check.fixes.length === 0 && (check.natural ?? null) === null
  const recentFixes =
    check.fixes.length > 0
      ? [...check.fixes.map(f => ({ ...f, ...(check.language ? { language: check.language } : {}) })), ...state.recentFixes].slice(
          0,
          MAX_RECENT_FIXES,
        )
      : state.recentFixes
  return {
    ...state,
    fails: 0,
    lastError: undefined,
    streak: clean ? state.streak + 1 : 0,
    recentFixes,
  }
}

/** Rebuild per-session state from a Pi session branch (`ctx.sessionManager.getBranch()`). */
export const rebuildSessionState = (entries: readonly BranchEntryLike[]): SessionState => {
  let state = emptySession()
  for (const entry of entries) {
    if (entry.type !== 'custom' || !isRecord(entry.data)) {
      continue
    }
    const data = entry.data
    if (entry.customType === 'grammar-check') {
      const status = data.status
      if (status !== 'done' && status !== 'skipped' && status !== 'error') {
        continue
      }
      const fixes = Array.isArray(data.fixes) ? data.fixes.filter(isFix) : []
      state = applyCheckOutcome(state, {
        status,
        fixes,
        natural: typeof data.natural === 'string' ? data.natural : null,
        error: typeof data.error === 'string' ? data.error : undefined,
        language: typeof data.language === 'string' ? data.language : undefined,
      })
    } else if (entry.customType === 'grammar-state') {
      if (data.failsReset === true) {
        state = { ...state, fails: 0, lastError: undefined }
      }
    } else if (entry.customType === 'grammar-ask-turn') {
      if (data.cleared === true) {
        state = { ...state, thread: [] }
      } else if (typeof data.q === 'string' && typeof data.a === 'string') {
        state = {
          ...state,
          thread: [...state.thread, { q: data.q, a: data.a }].slice(-ASK_MEMORY),
        }
      }
    }
  }
  return state
}

export const atomicWrite = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

// --- History file helpers ---

export const readHistoryFile = (path: string): History =>
  existsSync(path) ? parseHistory(readFileSync(path, 'utf8')) : EMPTY_HISTORY

export const recordToHistoryFile = (
  path: string,
  fixes: readonly GrammarFix[],
  now: number,
  lang: string = ENGLISH,
): { ok: true } | { ok: false; error: string } => {
  try {
    const current = readHistoryFile(path)
    atomicWrite(path, historyText(record(current, fixes, now, lang)))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const clearHistoryFile = (path: string) => {
  atomicWrite(path, historyText(EMPTY_HISTORY))
}
