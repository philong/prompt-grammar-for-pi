// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied 2026-11-20.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
// Shared domain types for prompt-grammar (ported from claude-grammar v1.7.0).
import type { Summary } from './history'

/** One grammar fix: `why` is '' when `show_why` is off; `kind` is asked for while history is on. */
export type GrammarFix = { from: string; to: string; why: string; kind?: string }

/** Parsed model reply: fixes, optional native-speaker rewrite, and language named in English. */
export type GrammarReply = { fixes: GrammarFix[]; natural: string | null; language: string }

/** A single prompt check result recorded in session state. */
export type GrammarCheck = {
  id: number
  text: string
  status: 'done' | 'skipped' | 'error'
  fixes: GrammarFix[]
  natural?: string | null
  error?: string
  paused?: boolean
  streak?: number
  language?: string
}

/** One exchange remembered for /grammar ask follow-ups. */
export type GrammarTurn = { q: string; a: string }

/** Persisted custom entry payload for `grammar-check`. */
export type GrammarEntry = GrammarCheck & {
  display: boolean
  showWhy?: boolean
}

/** Append-only reset sentinel payload for `grammar-state`. */
export type GrammarStateEntry = { failsReset: true }

/** Persisted custom entry payload for `grammar-ask-turn` (either a turn or a clear tombstone). */
export type GrammarAskTurnEntry = GrammarTurn | { cleared: true }

export type ReportKind = 'help' | 'stats' | 'review' | 'ask' | 'ignore' | 'config' | 'model' | 'history'

/** Persisted custom entry payload for `grammar-report`. */
export type ReportEntry = {
  kind: ReportKind
  body: string
  summary?: Summary
  advice?: string
  footer?: string
}
