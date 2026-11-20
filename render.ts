// Transcript & widget line formatter and Pi entry renderers for grammar checks and reports.
import type { EntryRenderer } from '@earendil-works/pi-coding-agent'
import { Box, Text, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'

import type { Summary } from './history'
import { MAX_FAILS } from './state'
import type { GrammarEntry, GrammarFix, ReportEntry } from './types'

export const STREAK_FROM = 3
const CHECK = '✓'
const LOGO = '✎'
const NATURAL = '↳'

/** Structural subset of Pi's `Theme` so `linesOf()` stays unit-testable without terminal setup. */
export type ThemeLike = {
  fg(color: 'error' | 'success' | 'muted' | 'accent' | 'dim', text: string): string
  bg(color: 'customMessageBg', text: string): string
  bold(text: string): string
  italic(text: string): string
  strikethrough(text: string): string
}

/** Strip ANSI CSI/OSC escape sequences and ASCII control characters for safe terminal rendering. */
export const sanitizeTerminalText = (text: string): string =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Plain-text fixes and optional native-speaker line (copied wording from agy `format.ts`). */
export const plainFixes = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean) => {
  const list = fixes.map(
    f => `${f.from} → ${f.to === '' ? '(remove)' : f.to}${showWhy && f.why !== '' ? ` (${f.why})` : ''}`,
  )
  return `${list.join('  ·  ')}${natural === null ? '' : `${list.length > 0 ? '\n' : ''}${NATURAL} ${natural}`}`
}

/** Clean prompt streak line (shown starting at STREAK_FROM). */
export const cleanText = (n: number) => `${CHECK} no mistakes${n >= STREAK_FROM ? ` · ${n} in a row` : ''}`

const clipLines = (lines: readonly string[], width?: number, styled = true): string[] => {
  if (width === undefined || width <= 0) {
    return [...lines]
  }
  return lines.map(line => {
    const truncated = truncateToWidth(line, width, '…')
    return styled ? truncated : stripTerminalSequences(truncated)
  })
}

/** Render a `GrammarEntry` to styled (TUI) or plain (RPC/tests) lines. */
export const linesOf = (
  entry: GrammarEntry,
  opts: { styled: boolean; theme?: ThemeLike; showWhy?: boolean; width?: number },
): string[] => {
  const theme = opts.styled ? opts.theme : undefined
  const showWhy = opts.showWhy ?? entry.showWhy ?? true

  if (entry.status === 'skipped') {
    return []
  }

  if (entry.status === 'error') {
    const paused = entry.paused ? `; paused after ${MAX_FAILS} failures in a row, /grammar on to try again` : ''
    const line = `! no grammar check: ${sanitizeTerminalText(entry.error ?? 'error')}${paused}`
    return clipLines([theme ? theme.fg('dim', line) : line], opts.width, opts.styled)
  }

  const sanitizedFixes: GrammarFix[] = entry.fixes.map(f => ({
    from: sanitizeTerminalText(f.from),
    to: sanitizeTerminalText(f.to),
    why: sanitizeTerminalText(f.why),
    kind: f.kind,
  }))
  const nat = entry.natural ? sanitizeTerminalText(entry.natural) : null
  const cleanNat = nat !== null && nat !== '' ? nat : null

  if (sanitizedFixes.length === 0 && cleanNat === null) {
    const line = cleanText(entry.streak ?? 0)
    return clipLines([theme ? theme.fg('success', line) : line], opts.width, opts.styled)
  }

  const lines: string[] = []
  if (sanitizedFixes.length > 0) {
    if (theme) {
      const items = sanitizedFixes.map(f => {
        const struck = theme.fg('error', theme.strikethrough(f.from))
        const fixed = f.to === '' ? theme.fg('dim', '(remove)') : theme.fg('success', f.to)
        const reason = showWhy && f.why !== '' ? ` ${theme.fg('muted', `(${f.why})`)}` : ''
        return `${struck} ${fixed}${reason}`
      })
      lines.push(`${theme.fg('accent', LOGO)} ${items.join(theme.fg('muted', '  ·  '))}`)
    } else {
      lines.push(`${LOGO} ${plainFixes(sanitizedFixes, null, showWhy)}`)
    }
  }

  if (cleanNat !== null) {
    lines.push(theme ? `${theme.fg('accent', NATURAL)} ${theme.fg('muted', theme.italic(cleanNat))}` : `${NATURAL} ${cleanNat}`)
  }

  return clipLines(lines, opts.width, opts.styled)
}

const summaryCardLines = (m: Summary): string[] => {
  const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(1, of))}%`
  const BAR = 15
  const most = Math.max(1, ...m.kinds.map(k => k.n))
  const width = Math.max(0, ...m.kinds.slice(0, 3).map(k => k.kind.length))

  const lines = [
    `Grammar review · ${m.language === undefined ? '' : `${m.language} · `}${m.label} (${m.range})`,
    `${m.checked} prompts · ${pct(m.withFixes, m.checked)} with a fix · ${m.fixes} fixes`,
  ]
  if (m.trend !== undefined) {
    const arrow = m.trend.fewer === true ? '↓' : m.trend.fewer === false ? '↑' : '='
    lines.push(`${arrow} ${m.trend.text}`)
  }
  if (m.kinds.length > 0) {
    lines.push('')
    for (const k of m.kinds.slice(0, 3)) {
      const n = Math.max(1, Math.round((BAR * k.n) / most))
      lines.push(`${k.kind.padEnd(width)}  ${'█'.repeat(n)}${'░'.repeat(BAR - n)}  ${Math.round(k.share * 100)}%`)
    }
  }
  if (m.top !== undefined) {
    lines.push('', `most repeated: ${m.top.from} → ${m.top.to === '' ? '(drop it)' : m.top.to}  ×${m.top.count}`)
  }
  return lines
}

const formatAdviceLines = (text: string, theme?: ThemeLike): string[] =>
  text.split('\n').map(line => {
    const m = /^\s*(.+?)\s+→\s+(.*?)\s*$/.exec(line)
    if (m === null) {
      return line
    }
    const from = sanitizeTerminalText(m[1] ?? '')
    const rawTo = sanitizeTerminalText(m[2] ?? '')
    const to = rawTo === '' ? '(drop it)' : rawTo
    if (!theme) {
      return `  ${from} → ${to}`
    }
    return `  ${theme.fg('error', theme.strikethrough(from))} ${theme.fg('success', to)}`
  })

const reportLines = (report: ReportEntry, theme?: ThemeLike): string[] => {
  if (report.kind === 'review' && report.summary && report.advice !== undefined) {
    const card = summaryCardLines(report.summary).map(l => (theme ? theme.fg('accent', l) : l))
    const advice = formatAdviceLines(report.advice, theme)
    const footer = report.footer ? [theme ? theme.fg('muted', report.footer) : report.footer] : []
    return [...card, '', ...advice, ...(footer.length > 0 ? ['', ...footer] : [])]
  }
  if (report.kind === 'ask' && report.advice !== undefined) {
    const advice = formatAdviceLines(report.advice, theme)
    const footer = report.footer ? [theme ? theme.fg('muted', report.footer) : report.footer] : []
    return [...advice, ...(footer.length > 0 ? ['', ...footer] : [])]
  }
  return report.body.split('\n')
}

/** Plain-text report formatter used for RPC notify fallbacks and unit tests. */
export const formatReportPlain = (report: ReportEntry): string => reportLines(report).join('\n')

/** Pi TUI EntryRenderer for `grammar-check` custom entries. Returns undefined when hidden (`!display`). */
export const renderCheckEntry: EntryRenderer<GrammarEntry> = (entry, _options, theme) => {
  const data = entry.data
  if (!data || !data.display) {
    return undefined
  }
  const lines = linesOf(data, { styled: true, theme })
  if (lines.length === 0) {
    return undefined
  }
  return new Text(lines.join('\n'), 1, 0)
}

/** Pi TUI EntryRenderer for `grammar-report` custom entries (help, stats, review, ask, config, model, ignore). */
export const renderReportEntry: EntryRenderer<ReportEntry> = (entry, _options, theme) => {
  const data = entry.data
  if (!data) {
    return undefined
  }
  const lines = reportLines(data, theme)
  const box = new Box(1, 0, text => theme.bg('customMessageBg', text))
  box.addChild(new Text(lines.join('\n'), 0, 0))
  return box
}
