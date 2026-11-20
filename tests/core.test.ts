import { describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BATCH, fallbackFor, keepFixes, parseBatch, parseReply, system, typedPart, usefulNatural } from '../check'
import {
  AUTO,
  ENGLISH,
  applyFixes,
  compileIgnore,
  compileSkip,
  cut,
  entriesFrom,
  joinNames,
  keptLanguage,
  languageOf,
  languageSetting,
  loadConfigAndLists,
  mergeLists,
  parseLists,
  resolvePaths,
  settingsFrom,
  wordCount,
  writeGlobalField,
} from '../config'
import {
  EMPTY_HISTORY,
  askInput,
  historyText,
  importWindow,
  inLanguage,
  keepable,
  kindOf,
  languagesIn,
  merge,
  pairsOf,
  parseHistory,
  parsePeriod,
  pickLanguage,
  prune,
  record,
  reviewInput,
  splitAsk,
  splitLanguage,
  statsText,
  summaryOf,
  visible,
} from '../history'
import { applyCheckOutcome, emptySession, rebuildSessionState } from '../state'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 30, 12)

describe('config', () => {
  test('defaults and render/model/language normalization', () => {
    const def = settingsFrom({})
    expect(def.render).toBe('entry')
    expect(def.language).toBe(ENGLISH)
    expect(def.model).toBe('auto')
    expect(def.systemPromptAppend).toBe('')
    expect(def.systemPromptAppendReviewer).toBeUndefined()
    expect(def.enabled).toBe(true)

    const custom = settingsFrom({
      model: 'openai/gpt-4.1-mini',
      render: 'widget',
      language: 'english, french',
      system_prompt_append: '  <|think_off|>  ',
      system_prompt_append_reviewer: '  <|think_on|>  ',
    })
    expect(custom.model).toBe('openai/gpt-4.1-mini')
    expect(custom.render).toBe('widget')
    expect(custom.language).toBe('English, French')
    expect(custom.systemPromptAppend).toBe('<|think_off|>')
    expect(custom.systemPromptAppendReviewer).toBe('<|think_on|>')
    expect(settingsFrom({ system_prompt_append_reviewer: '' }).systemPromptAppendReviewer).toBe('')

    expect(settingsFrom({ model: 'OFF' }).model).toBe('off')
    expect(settingsFrom({ model: 'AUTO' }).model).toBe('auto')
    expect(settingsFrom({ model: 'invalid' }).model).toBe('invalid')
    expect(settingsFrom({ render: 'BOTH' }).render).toBe('both')
    expect(settingsFrom({ render: 'bogus' }).render).toBe('entry')
  })

  test('resolvePaths ignores untrusted project configs and reads trusted .pi/grammar.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-paths-'))
    try {
      const agentDir = join(tmp, 'agent')
      const repoDir = join(tmp, 'repo')
      mkdirSync(agentDir, { recursive: true })
      mkdirSync(join(repoDir, '.pi'), { recursive: true })
      writeFileSync(
        join(repoDir, '.pi', 'grammar.json'),
        JSON.stringify({
          model: 'evil/expensive-model',
          system_prompt_append: 'evil override',
          system_prompt_append_reviewer: 'evil reviewer override',
          natural: false,
          ignore: ['myprojword'],
          history: false,
        }),
      )

      const untrusted = resolvePaths(agentDir, repoDir, false)
      expect(untrusted.projectConfig).toBeUndefined()
      const loadedUntrusted = loadConfigAndLists(untrusted)
      expect(loadedUntrusted.settings.natural).toBe(true)
      expect(loadedUntrusted.lists.ignore).toEqual([])
      expect(loadedUntrusted.projectAllowsHistory).toBe(true)

      const trusted = resolvePaths(agentDir, repoDir, true)
      expect(trusted.projectConfig).toBe(join(repoDir, '.pi', 'grammar.json'))
      const loadedTrusted = loadConfigAndLists(trusted)
      expect(loadedTrusted.settings.natural).toBe(false)
      expect(loadedTrusted.settings.model).toBe('auto')
      expect(loadedTrusted.settings.systemPromptAppend).toBe('')
      expect(loadedTrusted.settings.systemPromptAppendReviewer).toBeUndefined()
      expect(loadedTrusted.lists.ignore).toEqual(['myprojword'])
      expect(loadedTrusted.projectAllowsHistory).toBe(false)

      writeFileSync(
        join(agentDir, 'grammar.json'),
        JSON.stringify({
          model: 'anthropic/claude-haiku-4-5',
          system_prompt_append: '<|think_off|>',
          system_prompt_append_reviewer: '<|think_on|>',
        }),
      )
      const withGlobal = loadConfigAndLists(trusted)
      expect(withGlobal.settings.model).toBe('anthropic/claude-haiku-4-5')
      expect(withGlobal.settings.systemPromptAppend).toBe('<|think_off|>')
      expect(withGlobal.settings.systemPromptAppendReviewer).toBe('<|think_on|>')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('writeGlobalField creates grammar.json with 0600 permissions on POSIX', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-perms-'))
    try {
      const cfgPath = join(tmp, 'agent', 'grammar.json')
      const res = writeGlobalField(cfgPath, 'model', 'anthropic/claude-haiku-4-5')
      expect(res.ok).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('language normalization and matching', () => {
    expect(languageOf('brazilian portuguese')).toBe('Brazilian Portuguese')
    expect(languageOf('AUTO')).toBe(AUTO)
    expect(languageSetting('english, French, english')).toBe('English, French')
    expect(languageSetting('French, auto')).toBe(AUTO)
    expect(joinNames(['English', 'French', 'German'])).toBe('English, French or German')
    expect(keptLanguage('English, French', 'American English')).toBe('English')
    expect(keptLanguage('English, French', 'German')).toBeUndefined()
    expect(keptLanguage(AUTO, 'Japanese')).toBe('Japanese')
  })

  test('wordCount handles Latin and CJK/Thai scripts', () => {
    expect(wordCount('ok')).toBe(1)
    expect(wordCount('please deploy it')).toBe(3)
    expect(wordCount('好的')).toBe(1)
    expect(wordCount('请帮我修复这个错误')).toBe(5)
  })

  test('ignore and skip lists compile and match cleanly', () => {
    const lists = mergeLists(parseLists('{"ignore":["kubectl","/^[A-Z]+-\\\\d+$/"],"skip":["^deploy "]}'), {
      ignore: ['kubectl', 'pull request'],
      skip: [],
      history: false,
    })
    expect(lists.history).toBe(false)
    const ignore = compileIgnore(lists.ignore)
    expect(ignore.words).toEqual(['kubectl', 'pull request'])
    expect(ignore.matchers.some(r => r.test('run KUBECTL now'))).toBe(true)
    expect(ignore.matchers.some(r => r.test('PROJ-123'))).toBe(true)

    const skip = compileSkip(lists.skip)
    expect(skip.some(r => r.test('deploy staging'))).toBe(true)
    expect(entriesFrom('pull request, kubectl')).toEqual(['pull request', 'kubectl'])
    expect(cut('one two three four five', 12)).toBe('one two')
    expect(applyFixes('it should appea here', [{ from: 'appea', to: 'appear', why: 'typo' }])).toBe('it should appear here')
  })
})

describe('check', () => {
  test('system prompt and reply parsing', () => {
    const sys = system({ natural: true, language: ENGLISH, dialect: 'us', showWhy: true, kind: true, ignore: ['kubectl'] })
    expect(sys).toContain('American English')
    expect(sys).toContain('"kubectl"')
    expect(sys).toContain('"natural"')

    const reply = parseReply(
      '```json\n{"english": true, "fixes": [{"from": "appea", "to": "appear", "why": "typo", "kind": "spelling"}], "natural": null}\n```',
    )
    expect(reply).toEqual({
      language: 'English',
      fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
      natural: null,
    })
    expect(parseReply('{"english": false, "fixes": []}')).toBeNull()
    expect(parseReply('{"language": null, "fixes": []}')).toBeNull()
    expect(fallbackFor('French')).toBe('French')
    expect(fallbackFor('English, French')).toBeUndefined()
  })

  test('keepFixes, usefulNatural, and typedPart unwrap <USER_REQUEST>', () => {
    const ignore = compileIgnore(['kubectl'])
    const kept = keepFixes(
      [
        { from: 'appea', to: 'appear', why: 'typo' },
        { from: 'kubectl', to: 'kube', why: 'word' },
        { from: 'ghost', to: 'real', why: 'missing' },
      ],
      'kubectl should appea here',
      ignore,
    )
    expect(kept.map(f => f.from)).toEqual(['appea'])
    expect(usefulNatural('kubectl should appear here', 'kubectl should appea here', kept, ignore)).toBeNull()
    expect(usefulNatural('make kubectl show up here', 'kubectl should appea here', kept, ignore)).toBe('make kubectl show up here')
    expect(usefulNatural('make it show up here', 'kubectl should appea here', kept, ignore)).toBeNull()

    expect(typedPart('<USER_REQUEST>\nfix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>')).toBe('fix the bug')
  })

  test('parseBatch handles arrays and lone objects', () => {
    expect(BATCH).toContain('JSON array')
    const m = parseBatch('[{"id":1,"english":true,"fixes":[]},{"id":2,"english":false,"fixes":[]}]')
    expect(m.get(1)).toEqual({ fixes: [], natural: null, language: 'English' })
    expect(m.get(2)).toBeNull()

    const single = parseBatch('{"id":5,"language":"French","fixes":[]}')
    expect(single.get(5)?.language).toBe('French')
  })
})

describe('history', () => {
  test('record, prune, merge, salvage, stats, and periods', () => {
    expect(kindOf('wrong-word')).toBe('wrong word')
    expect(kindOf('unknown_kind')).toBe('other')
    expect(keepable({ from: 'appea', to: 'appear', why: 'typo' })).toBe(true)
    expect(keepable({ from: 'src/app.ts', to: 'src/main.ts', why: 'path' })).toBe(false)
    expect(keepable({ from: 'hello', to: 'Hello', why: 'case' })).toBe(false)

    let h = EMPTY_HISTORY
    h = record(h, [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }], NOW - 2 * DAY, ENGLISH)
    h = record(h, [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }], NOW, ENGLISH)
    h = record(h, [{ from: 'le table', to: 'la table', why: 'genre', kind: 'agreement' }], NOW, 'French')

    const text = historyText(h)
    expect(parseHistory(text).fixes.length).toBe(3)
    const torn = text.slice(0, text.lastIndexOf('\n', text.length - 5))
    expect(parseHistory(torn).days.length).toBeGreaterThan(0)

    expect(languagesIn(h).map(l => l.lang)).toEqual(['English', 'French'])
    expect(splitLanguage('7d french', ['English', 'French'])).toEqual({ lang: 'French', rest: '7d' })
    expect(pickLanguage(h, undefined, 'English').lang).toBe('English')

    const p = parsePeriod('7d', NOW)
    expect(typeof p).toBe('object')
    if (typeof p !== 'string') {
      const en = inLanguage(h, ENGLISH)
      const s = summaryOf(en, compileIgnore([]), p, NOW)
      expect(s.checked).toBe(2)
      expect(s.top?.count).toBe(2)
      expect(statsText(en, compileIgnore([]), NOW, '/tmp/h.json', true, p)).toContain('depend from → depend on')
    }

    const merged = merge(h, EMPTY_HISTORY, NOW)
    expect(prune(merged, NOW + 100 * DAY).fixes.length).toBe(0)
    expect(pairsOf(visible(h, compileIgnore([]))).length).toBe(2)
    expect(reviewInput(h.fixes)).toContain('2× depend from → depend on')
    expect(importWindow(NOW, 7, '2026-10-28')).toBeDefined()

    const asked = splitAsk('7d why do I miss articles?', NOW)
    expect(typeof asked).toBe('object')
    if (typeof asked !== 'string') {
      expect(asked.question).toBe('why do I miss articles?')
      expect(askInput(h.fixes, asked.period.label, [], [], asked.question)).toContain('Their question: why do I miss articles?')
    }
  })
})

describe('state', () => {
  test('rebuilds streak, fails, reset sentinels, skipped checks, recent fixes, and ask tombstones from branch', () => {
    const s = rebuildSessionState([
      { type: 'message' },
      { type: 'custom', customType: 'grammar-check', data: { status: 'done', fixes: [], natural: null } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'done', fixes: [], natural: null } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'error', fixes: [], error: 'timeout' } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'error', fixes: [], error: '500' } },
      // Skipped check resets fails & lastError while leaving streak intact.
      { type: 'custom', customType: 'grammar-check', data: { status: 'skipped', fixes: [] } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'error', fixes: [], error: 'rate limit' } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'error', fixes: [], error: 'down' } },
      { type: 'custom', customType: 'grammar-check', data: { status: 'error', fixes: [], error: 'offline' } },
      { type: 'custom', customType: 'grammar-state', data: { failsReset: true } },
      {
        type: 'custom',
        customType: 'grammar-check',
        data: {
          status: 'done',
          language: 'English',
          fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
          natural: null,
        },
      },
      { type: 'custom', customType: 'grammar-ask-turn', data: { q: 'old q', a: 'old a' } },
      { type: 'custom', customType: 'grammar-ask-turn', data: { cleared: true } },
      { type: 'custom', customType: 'grammar-ask-turn', data: { q: 'new q', a: 'new a' } },
    ])

    expect(s.fails).toBe(0)
    expect(s.lastError).toBeUndefined()
    expect(s.streak).toBe(0)
    expect(s.recentFixes).toEqual([{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling', language: 'English' }])
    expect(s.thread).toEqual([{ q: 'new q', a: 'new a' }])

    let live = emptySession()
    live = applyCheckOutcome(live, { status: 'done', fixes: [], natural: null })
    live = applyCheckOutcome(live, { status: 'skipped', fixes: [] })
    live = applyCheckOutcome(live, { status: 'done', fixes: [], natural: null })
    expect(live.streak).toBe(2)
  })
})
