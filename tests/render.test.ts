import { describe, expect, test } from 'vitest'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

import { linesOf, renderCheckEntry, renderReportEntry } from '../render'
import type { ThemeLike } from '../render'
import type { GrammarEntry, ReportEntry } from '../types'

const fakeTheme: ThemeLike = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (color, text) => `<bg:${color}>${text}</bg:${color}>`,
  bold: text => `<b>${text}</b>`,
  italic: text => `<i>${text}</i>`,
  strikethrough: text => `<s>${text}</s>`,
}

describe('render', () => {
  test('linesOf formats plain and styled fixes, natural rewrites, clean streaks, errors, and skipped entries', () => {
    const entry: GrammarEntry = {
      id: 1,
      text: 'i want know it',
      status: 'done',
      fixes: [
        { from: 'reads\x1b[31m', to: '', why: 'extra word' },
        { from: 'i want know', to: 'I want to know', why: 'missing "to"' },
      ],
      natural: 'I want to know that\x1b]0;evil\x07',
      display: true,
      showWhy: true,
    }

    const plain = linesOf(entry, { styled: false })
    expect(plain).toEqual([
      '✎ reads → (remove) (extra word)  ·  i want know → I want to know (missing "to")',
      '↳ I want to know that',
    ])

    const styled = linesOf(entry, { styled: true, theme: fakeTheme })
    expect(styled[0]).toContain('<error><s>reads</s></error> <dim>(remove)</dim>')
    expect(styled[0]).toContain('<success>I want to know</success> <muted>(missing "to")</muted>')
    expect(styled[1]).toBe('<accent>↳</accent> <muted><i>I want to know that</i></muted>')
    expect(stripTerminalSequences(styled.join('\n'))).not.toContain('\x1b')

    const noWhy = linesOf(entry, { styled: false, showWhy: false })
    expect(noWhy[0]).toBe('✎ reads → (remove)  ·  i want know → I want to know')

    const clipped = linesOf(entry, { styled: false, width: 25 })
    expect(clipped[0]?.length).toBeLessThanOrEqual(25)
    expect(clipped[0]?.endsWith('…')).toBe(true)

    const cleanEntry: GrammarEntry = { id: 2, text: 'hello there', status: 'done', fixes: [], streak: 4, display: true }
    expect(linesOf(cleanEntry, { styled: false })).toEqual(['✓ no mistakes · 4 in a row'])

    const errEntry: GrammarEntry = {
      id: 3,
      text: 'hello there',
      status: 'error',
      fixes: [],
      error: 'network down',
      paused: true,
      display: true,
    }
    expect(linesOf(errEntry, { styled: false })).toEqual([
      '! no grammar check: network down; paused after 3 failures in a row, /grammar on to try again',
    ])

    const skippedEntry: GrammarEntry = { id: 4, text: 'bonjour monde', status: 'skipped', fixes: [], display: false }
    expect(linesOf(skippedEntry, { styled: false })).toEqual([])
  })

  test('renderCheckEntry returns undefined when display is false and a Text component when true', () => {
    const hidden = renderCheckEntry(
      {
        type: 'custom',
        customType: 'grammar-check',
        id: 'e1',
        parentId: null,
        timestamp: '',
        data: { id: 1, text: 'hi there', status: 'done', fixes: [], streak: 1, display: false },
      },
      { expanded: false, keyText: () => '', keyHint: () => '' },
      fakeTheme as never,
    )
    expect(hidden).toBeUndefined()

    const shown = renderCheckEntry(
      {
        type: 'custom',
        customType: 'grammar-check',
        id: 'e2',
        parentId: null,
        timestamp: '',
        data: {
          id: 2,
          text: 'i goes home',
          status: 'done',
          fixes: [{ from: 'i goes', to: 'I go', why: 'agreement' }],
          display: true,
        },
      },
      { expanded: false, keyText: () => '', keyHint: () => '' },
      fakeTheme as never,
    )
    expect(shown).toBeDefined()
    expect(shown?.render(80).join('\n')).toContain('I go')
  })

  test('renderReportEntry renders review cards and advice inside a Box', () => {
    const report: ReportEntry = {
      kind: 'review',
      body: 'fallback',
      summary: {
        label: 'last 7 days',
        range: 'Oct 24 – Oct 30',
        checked: 20,
        withFixes: 8,
        fixes: 10,
        kinds: [{ kind: 'article', n: 6, share: 0.6 }],
        top: { from: 'a', to: 'the', kind: 'article', why: 'article', count: 3 },
      },
      advice: '1. Watch articles.\n  a bug → the bug',
      footer: 'anthropic/claude-haiku-4-5, from 10 fixes',
    }
    const comp = renderReportEntry(
      { type: 'custom', customType: 'grammar-report', id: 'r1', parentId: null, timestamp: '', data: report },
      { expanded: false, keyText: () => '', keyHint: () => '' },
      fakeTheme as never,
    )
    const rendered = comp?.render(100).join('\n') ?? ''
    expect(rendered).toContain('Grammar review · last 7 days')
    expect(rendered).toContain('<error><s>a bug</s></error> <success>the bug</success>')
    expect(rendered).toContain('from 10 fixes')
  })
})
