// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied 2026-11-20.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
// Full /grammar sub-command handler and autocomplete definitions for Pi.
import { existsSync } from 'node:fs'
import type { Model } from '@earendil-works/pi-ai'
import type { AutocompleteItem } from '@earendil-works/pi-tui'

import {
  AUTO,
  CONFIG_KEYS,
  RENDER_MODES,
  compileIgnore,
  cut,
  entriesFrom,
  joinNames,
  languageSetting,
  languagesOf,
  loadConfigAndLists,
  normalizeRender,
  parseLists,
  readRawConfig,
  writeGlobalField,
} from './config'
import type { Paths, Settings } from './config'
import {
  ASK_MEMORY,
  ASK_RECENT,
  ASK_SYSTEM,
  KEEP_DAYS,
  MAX_ANSWER,
  MAX_ENTRIES,
  MAX_QUESTION,
  REVIEW_FROM,
  askInput,
  inLanguage,
  languagesIn,
  parsePeriod,
  pickLanguage,
  reviewInput,
  reviewSystem,
  splitAsk,
  splitLanguage,
  statsText,
  summaryOf,
  visible,
  within,
} from './history'
import type { History } from './history'
import {
  appendSystemPrompt,
  checkModelAuth,
  estimateCost,
  parseExplicitModelId,
  resolveCheckModel,
  resolveCoachingModel,
  runModelCall,
} from './model'
import type { ModelLike, ModelRegistryLike, ResolvedModel, ScopedModelLike } from './model'
import { formatReportPlain } from './render'
import { MAX_FAILS, clearHistoryFile, readHistoryFile } from './state'
import type { SessionState } from './state'
import type { GrammarTurn, ReportEntry } from './types'

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const languageName = (s: Settings) => (s.language === AUTO ? 'grammar' : joinNames(languagesOf(s.language), 'and'))

const describeModel = <M extends ModelLike>(resolved: ResolvedModel<M>): string => {
  if (resolved.kind === 'off') {
    return 'off'
  }
  if (resolved.kind === 'missing') {
    return `unavailable (${resolved.error})`
  }
  const sourceLabel =
    resolved.source === 'auto'
      ? 'cheapest on provider'
      : resolved.source === 'session'
        ? 'session model'
        : 'configured'
  return `${resolved.spec} (${sourceLabel}; ${estimateCost(resolved.model).text})`
}

export const usage = (s: Settings, coachingLabel: string) =>
  [
    `/grammar help: this list, and what is on now`,
    `/grammar [on|off]: the ${languageName(s)} check of your prompts`,
    `/grammar natural [on|off]: the native-speaker line`,
    `/grammar render [entry|widget|both|off]: where fixes show`,
    `/grammar hide: clear the widget above the editor (shortcut: ctrl+alt+g)`,
    `/grammar model [off|auto|<provider>/<modelId>]: pick or list check models`,
    `/grammar ignore add <words>: never flag these (phrases: separate with commas)`,
    `/grammar ignore rm <words>: flag them again`,
    `/grammar ignore: the ignore and skip lists, and their files`,
    `/grammar stats [7d|30d|since 2026-10-01] [language]: your most frequent mistakes, from the kept fixes`,
    `/grammar review [7d|30d|since 2026-10-01] [language]: a summary, then advice on them from ${coachingLabel} (one call, from ${REVIEW_FROM} fixes)`,
    `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${coachingLabel} about your writing, with your fixes at hand (one call)`,
    `/grammar ask list|clear: what follow-ups remember (the last ${ASK_MEMORY} asks and reviews), or forget it`,
    `/grammar ask memory [on|off]: remembering asks for follow-ups`,
    `/grammar history [on|off|clear]: keeping fixes for stats and review`,
    `/grammar config [key] [value]: view or update settings in grammar.json`,
  ].join('\n')

const withLanguages = (text: string, h: History) => {
  const all = languagesIn(h)
  return all.length > 1 ? `${text} Languages kept: ${all.map(l => l.lang).join(', ')}.` : text
}

const forLanguage = (h: History, words: string, s: Settings) => {
  const { lang, rest } = splitLanguage(words, languagesIn(h).map(l => l.lang))
  return { ...pickLanguage(h, lang, s.language), rest }
}

const validateExplicitModel = <M extends ModelLike>(
  rawVal: string,
  registry: ModelRegistryLike<M>,
  invalidFormatError: string,
): { ok: true; value: string; model: M } | { ok: false; error: string } => {
  const parsed = parseExplicitModelId(rawVal)
  if (!parsed) {
    return { ok: false, error: invalidFormatError }
  }
  const found = registry.find(parsed.provider, parsed.modelId)
  if (!found) {
    return { ok: false, error: `Model "${rawVal}" not found in registry. Run /grammar model to list available models.` }
  }
  return { ok: true, value: `${found.provider}/${found.id}`, model: found }
}

const validateModelSetting = <M extends ModelLike>(
  rawVal: string,
  registry: ModelRegistryLike<M>,
): { ok: true; value: string; model?: M } | { ok: false; error: string } => {
  const lower = rawVal.trim().toLowerCase()
  if (lower === 'auto' || lower === 'off') {
    return { ok: true, value: lower }
  }
  return validateExplicitModel(rawVal, registry, 'model expects auto, off, or <provider>/<modelId>.')
}

const validateReviewerModelSetting = <M extends ModelLike>(
  rawVal: string,
  registry: ModelRegistryLike<M>,
): { ok: true; value: string; model?: M } | { ok: false; error: string } => {
  const lower = rawVal.trim().toLowerCase()
  if (lower === 'auto') {
    return { ok: true, value: 'auto' }
  }
  const usageError = 'model_reviewer expects auto or <provider>/<modelId> (use unset to inherit model).'
  if (lower === 'off') {
    return { ok: false, error: usageError }
  }
  return validateExplicitModel(rawVal, registry, usageError)
}

const parseConfigValue = <M extends ModelLike>(
  key: string,
  rawVal: string,
  registry: ModelRegistryLike<M>,
): { ok: true; value: unknown; model?: M } | { ok: false; error: string } => {
  const v = rawVal.trim()
  if (v === 'reset' || v === 'default' || v === 'unset') {
    return { ok: true, value: undefined }
  }
  switch (key) {
    case 'enabled':
    case 'natural':
    case 'show_why':
    case 'history':
    case 'clean':
    case 'ask_memory':
      if (v === 'true' || v === 'on') return { ok: true, value: true }
      if (v === 'false' || v === 'off') return { ok: true, value: false }
      return { ok: false, error: `${key} expects true|false or on|off.` }
    case 'dialect':
      if (v === 'any' || v === 'us' || v === 'uk') return { ok: true, value: v }
      return { ok: false, error: `dialect expects any, us, or uk.` }
    case 'render': {
      const mode = normalizeRender(v)
      if (mode !== undefined) return { ok: true, value: mode }
      return { ok: false, error: `render expects entry, widget, both, or off.` }
    }
    case 'min_words': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: `min_words expects an integer 1..50.` }
      return { ok: true, value: n }
    }
    case 'max_chars': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 200 || n > 20000) return { ok: false, error: `max_chars expects an integer 200..20000.` }
      return { ok: true, value: n }
    }
    case 'timeout_ms': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 2000 || n > 120000) return { ok: false, error: `timeout_ms expects an integer 2000..120000.` }
      return { ok: true, value: n }
    }
    case 'language': {
      const parsed = languageSetting(v)
      if (parsed === undefined) return { ok: false, error: `Invalid language "${v}".` }
      return { ok: true, value: parsed }
    }
    case 'model':
      return validateModelSetting(v, registry)
    case 'model_reviewer':
      return validateReviewerModelSetting(v, registry)
    case 'system_prompt_append':
    case 'system_prompt_append_reviewer':
      return { ok: true, value: v === '""' || v === "''" ? '' : v }
    default:
      return { ok: false, error: `Unknown setting "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.` }
  }
}

export type CommandContext<M extends ModelLike = Model<any>> = {
  args: string
  paths: Paths
  session: SessionState
  activeModel: M | undefined
  scopedModels: readonly ScopedModelLike<M>[]
  registry: ModelRegistryLike<M>
  now?: number
}

export type CommandOutput =
  | {
      kind: 'notify'
      message: string
      level?: 'info' | 'warning' | 'error'
      clearWidget?: boolean
      resetFails?: boolean
      clearAsk?: boolean
      refreshModel?: boolean
    }
  | {
      kind: 'report'
      report: ReportEntry
      askTurn?: GrammarTurn
      clearWidget?: boolean
      refreshModel?: boolean
    }

const SUBCOMMANDS = ['help', 'on', 'off', 'natural', 'render', 'hide', 'model', 'ignore', 'stats', 'review', 'ask', 'history', 'config'] as const

const toItems = (values: readonly string[], filter: string, description?: string): AutocompleteItem[] | null => {
  const q = filter.toLowerCase()
  const matches = values.filter(v => v.toLowerCase().startsWith(q)).map(value => ({ value, label: value, ...(description ? { description } : {}) }))
  return matches.length > 0 ? matches : null
}

/**
 * Provide autocomplete candidates for `/grammar <subcommand> ...`.
 *
 * Pi replaces the entire argument text with `item.value`, so each value carries the
 * already-typed leading tokens (e.g. `config model`), while `label` stays the short token.
 */
export const getGrammarCompletions = (argumentPrefix: string, availableModels: readonly string[] = []): AutocompleteItem[] | null => {
  const items = getTokenCompletions(argumentPrefix, availableModels)
  if (!items) {
    return null
  }
  const leading = argumentPrefix.replace(/\S*$/, '')
  return items.map(item => ({ ...item, value: leading + item.value }))
}

const getTokenCompletions = (argumentPrefix: string, availableModels: readonly string[]): AutocompleteItem[] | null => {
  const hasTrailingSpace = /\s$/.test(argumentPrefix)
  const parts = argumentPrefix.trim() === '' ? [] : argumentPrefix.trim().split(/\s+/)
  if (parts.length === 0) {
    return toItems(SUBCOMMANDS, '')
  }
  const head = (parts[0] ?? '').toLowerCase()
  if (parts.length === 1 && !hasTrailingSpace) {
    return toItems(SUBCOMMANDS, head)
  }
  const arg1 = hasTrailingSpace && parts.length === 1 ? '' : (parts[1] ?? '')
  const arg2 = hasTrailingSpace && parts.length === 2 ? '' : (parts[2] ?? '')

  switch (head) {
    case 'natural':
      return parts.length <= 2 ? toItems(['on', 'off'], arg1) : null
    case 'render':
      return parts.length <= 2 ? toItems(RENDER_MODES, arg1) : null
    case 'model':
      return parts.length <= 2 ? toItems(['auto', 'off', ...availableModels], arg1) : null
    case 'ignore':
      return parts.length <= 2 ? toItems(['list', 'add', 'rm'], arg1) : null
    case 'stats':
    case 'review':
      return parts.length <= 2 ? toItems(['7d', '30d', 'all', 'since '], arg1) : null
    case 'history':
      return parts.length <= 2 ? toItems(['on', 'off', 'clear'], arg1) : null
    case 'ask':
      if (arg1.toLowerCase() === 'memory' && (parts.length === 3 || (parts.length === 2 && hasTrailingSpace))) {
        return toItems(['on', 'off'], arg2)
      }
      return parts.length <= 2 ? toItems(['list', 'clear', 'memory', '7d', '30d', 'since '], arg1) : null
    case 'config':
      if (parts.length === 3 || (parts.length === 2 && hasTrailingSpace)) {
        const key = arg1.toLowerCase()
        if (key === 'model') {
          return toItems(['auto', 'off', 'unset', ...availableModels], arg2)
        }
        if (key === 'model_reviewer') {
          return toItems(['auto', 'unset', ...availableModels], arg2)
        }
        return null
      }
      return parts.length <= 2 ? toItems(CONFIG_KEYS, arg1) : null
    default:
      return null
  }
}

const isDistinctModel = <M extends ModelLike>(a: ResolvedModel<M>, b: ResolvedModel<M>): b is Extract<ResolvedModel<M>, { kind: 'ready' }> =>
  b.kind === 'ready' && (a.kind !== 'ready' || a.model.provider !== b.model.provider || a.model.id !== b.model.id)

/** Execute a `/grammar ...` command cleanly against Pi settings, history, branch state, and ModelRegistry. */
export const runGrammarCommand = async <M extends ModelLike = Model<any>>({
  args,
  paths,
  session,
  activeModel,
  scopedModels,
  registry,
  now = Date.now(),
}: CommandContext<M>): Promise<CommandOutput> => {
  const { settings: s, lists, projectAllowsHistory } = loadConfigAndLists(paths)
  const reviewerAppend = s.systemPromptAppendReviewer ?? s.systemPromptAppend
  const checkResolved = resolveCheckModel(s.model, { activeModel, registry, scopedModels })
  const coachResolved = resolveCoachingModel(s.model, {
    activeModel,
    registry,
    scopedModels,
    reviewerModel: s.modelReviewer,
  })
  const coachName = coachResolved.kind === 'ready' ? coachResolved.spec : 'the session model'

  const trimmed = args.trim()
  const [first = '', ...rest] = trimmed === '' ? [] : trimmed.split(/\s+/)
  const cmd = first.toLowerCase()
  const sub = (rest[0] ?? '').toLowerCase()

  const report = (kind: ReportEntry['kind'], body: string, extra?: Omit<ReportEntry, 'kind' | 'body'>, askTurn?: GrammarTurn): CommandOutput => ({
    kind: 'report',
    report: { kind, body, ...extra },
    ...(askTurn ? { askTurn } : {}),
  })

  const loadHistorySafe = (): { h: History; ignore: ReturnType<typeof compileIgnore> } | string => {
    try {
      const h = readHistoryFile(paths.historyFile)
      return { h, ignore: compileIgnore(lists.ignore) }
    } catch (err) {
      return `${paths.historyFile} does not parse (${err instanceof Error ? err.message : String(err)}). Fix it by hand, or /grammar history clear to start over.`
    }
  }

  switch (cmd) {
    case 'help':
    case '?': {
      const paused = session.fails >= MAX_FAILS
      let authWarning = ''
      if (checkResolved.kind === 'ready') {
        const auth = await checkModelAuth(registry, checkResolved.model)
        if (!auth.ok) {
          authWarning = ` Auth warning: ${auth.warning}.`
        }
      }
      let coachAuthWarning = ''
      const showReviewerLine = s.modelReviewer !== undefined || coachResolved.kind === 'missing'
      if (showReviewerLine && isDistinctModel(checkResolved, coachResolved)) {
        const auth = await checkModelAuth(registry, coachResolved.model)
        if (!auth.ok) {
          coachAuthWarning = ` Auth warning: ${auth.warning}.`
        }
      }
      const check = !s.enabled
        ? 'off'
        : s.model === 'off'
          ? 'off (model is off)'
          : checkResolved.kind === 'missing'
            ? `waiting (${checkResolved.error})`
            : paused
              ? `paused after ${MAX_FAILS} failures (/grammar on resumes)${session.lastError ? ` — last error: ${session.lastError}` : ''}`
              : session.fails > 0 && session.lastError
                ? `on (${session.fails} recent failure${session.fails === 1 ? '' : 's'}: ${session.lastError})`
                : 'on'
      const loaded = loadHistorySafe()
      const n = typeof loaded === 'string' ? 0 : visible(loaded.h, loaded.ignore).length
      const status = [
        `Check: ${check}. Natural line: ${s.natural ? 'on' : 'off'}. Render: ${s.render}.`,
        `Language: ${s.language === AUTO ? 'auto (each prompt in its own language)' : languagesOf(s.language).length > 1 ? `${s.language} (each prompt in one of them)` : s.language}.`,
        `Model: ${describeModel(checkResolved)}, spelling ${s.dialect}, at least ${s.minWords} words, up to ${s.maxChars} chars.${authWarning}`,
        ...(showReviewerLine ? [`Reviewer model: ${describeModel(coachResolved)}.${coachAuthWarning}`] : []),
        `History: ${s.history ? 'on' : 'off'}, ${n} fixes kept${n >= REVIEW_FROM ? '' : ` (/grammar review from ${REVIEW_FROM})`}.`,
        s.askMemory
          ? `Ask memory: on, ${plural(session.thread.length, 'exchange')} remembered (/grammar ask list).`
          : 'Ask memory: off.',
      ]
      return report('help', `${status.join('\n')}\n\n${usage(s, coachName)}`)
    }

    case '':
    case 'on':
    case 'off': {
      const want = cmd === 'on' ? true : cmd === 'off' ? false : !s.enabled
      const res = writeGlobalField(paths.globalConfig, 'enabled', want)
      if (!res.ok) {
        return { kind: 'notify', level: 'error', message: res.error }
      }
      if (!want) {
        return { kind: 'notify', message: `${capital(languageName(s))} check off.` }
      }
      if (checkResolved.kind === 'off') {
        return {
          kind: 'notify',
          level: 'warning',
          resetFails: true,
          message: `${capital(languageName(s))} check on, but model is "off". Run /grammar model auto (or <provider>/<modelId>).`,
        }
      }
      if (checkResolved.kind === 'missing') {
        return {
          kind: 'notify',
          level: 'warning',
          resetFails: true,
          message: `${capital(languageName(s))} check on, waiting for model (${checkResolved.error}).`,
        }
      }
      return {
        kind: 'notify',
        resetFails: true,
        message: `${capital(languageName(s))} check on: ${checkResolved.spec} checks each prompt${s.language === AUTO ? ', in its own language' : ''}.`,
      }
    }

    case 'natural': {
      if (sub !== '' && sub !== 'on' && sub !== 'off') {
        return report('help', usage(s, coachName))
      }
      const want = sub === 'on' ? true : sub === 'off' ? false : !s.natural
      const res = writeGlobalField(paths.globalConfig, 'natural', want)
      if (!res.ok) {
        return { kind: 'notify', level: 'error', message: res.error }
      }
      return {
        kind: 'notify',
        message: want
          ? 'Natural phrasing on: the check also says when a native speaker would put it differently.'
          : 'Natural phrasing off: grammar fixes only.',
      }
    }

    case 'render': {
      if (sub === '') {
        return { kind: 'notify', message: `Render mode: ${s.render} (options: ${RENDER_MODES.join(', ')}).` }
      }
      const mode = normalizeRender(rest.join(' '))
      if (mode === undefined) {
        return { kind: 'notify', level: 'warning', message: `render expects ${RENDER_MODES.join(', ')}.` }
      }
      const res = writeGlobalField(paths.globalConfig, 'render', mode)
      if (!res.ok) {
        return { kind: 'notify', level: 'error', message: res.error }
      }
      return {
        kind: 'notify',
        clearWidget: mode === 'entry' || mode === 'off',
        message: `Render set to "${mode}" in ${paths.globalConfig}.`,
      }
    }

    case 'hide':
      return { kind: 'notify', clearWidget: true, message: 'Grammar widget hidden (ctrl+alt+g also toggles/hides).' }

    case 'model': {
      const target = rest.join(' ').trim()
      if (target === '') {
        const available = registry
          .getAvailable()
          .filter(m => m.api !== 'pi-virtual' && m.input.includes('text'))
          .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
        let authLine = ''
        if (checkResolved.kind === 'ready') {
          const auth = await checkModelAuth(registry, checkResolved.model)
          if (!auth.ok) {
            authLine = `\nWarning: ${auth.warning}`
          }
        }
        if (isDistinctModel(checkResolved, coachResolved)) {
          const coachAuth = await checkModelAuth(registry, coachResolved.model)
          if (!coachAuth.ok) {
            authLine += `\nWarning (reviewer): ${coachAuth.warning}`
          }
        }
        const rows = available
          .slice(0, 25)
          .map(m => `  ${m.provider}/${m.id}  (${estimateCost(m).text}${m.reasoning ? ', reasoning' : ''})`)
        const more = available.length > 25 ? [`  ... (${available.length - 25} more available)`] : []
        const body = [
          `Setting: ${s.model}`,
          `Reviewer setting: ${s.modelReviewer ?? '(inherit model)'}`,
          `Check model: ${describeModel(checkResolved)}`,
          `Coaching model (/grammar review, /grammar ask): ${describeModel(coachResolved)}${authLine}`,
          '',
          available.length > 0 ? 'Available text models:' : 'No available text models found in Pi registry.',
          ...rows,
          ...more,
          '',
          'Set with: /grammar model auto | off | <provider>/<modelId>',
          'Set reviewer with: /grammar config model_reviewer auto | <provider>/<modelId> | unset',
        ].join('\n')
        return report('model', body)
      }
      const validated = validateModelSetting(target, registry)
      if (!validated.ok) {
        return { kind: 'notify', level: 'error', message: validated.error }
      }
      let warning = ''
      if (validated.model) {
        const auth = await checkModelAuth(registry, validated.model)
        if (!auth.ok) {
          warning = ` Warning: ${auth.warning}.`
        }
      }
      const res = writeGlobalField(paths.globalConfig, 'model', validated.value)
      if (!res.ok) {
        return { kind: 'notify', level: 'error', message: res.error }
      }
      return {
        kind: 'notify',
        level: warning ? 'warning' : 'info',
        refreshModel: true,
        message: `Grammar model set to "${validated.value}" in ${paths.globalConfig}.${warning}`,
      }
    }

    case 'ignore': {
      const words = entriesFrom(rest.slice(1).join(' '))
      if (sub === '' || sub === 'list') {
        const files = [paths.globalConfig, paths.projectConfig].filter((p): p is string => p !== undefined)
        const lines: string[] = []
        for (const file of [...new Set(files)]) {
          const parsed = readRawConfig(file)
          const l = parsed.error === undefined ? parseLists(JSON.stringify(parsed.raw)) : { ignore: [], skip: [], history: true }
          lines.push(
            `${file}\n  ignore: ${l.ignore.length > 0 ? l.ignore.join(', ') : 'none'}\n  skip: ${l.skip.length > 0 ? l.skip.join(', ') : 'none'}`,
          )
        }
        return report('ignore', lines.join('\n'))
      }
      if ((sub === 'add' || sub === 'rm') && words.length > 0) {
        const existing = readRawConfig(paths.globalConfig)
        if (existing.error !== undefined) {
          return { kind: 'notify', level: 'error', message: `${paths.globalConfig} does not parse (${existing.error}), so it was left as it is.` }
        }
        const current = parseLists(JSON.stringify(existing.raw)).ignore
        const lower = new Set(words.map(w => w.toLowerCase()))
        const next = sub === 'add' ? [...new Set([...current, ...words])] : current.filter(w => !lower.has(w.toLowerCase()))
        const res = writeGlobalField(paths.globalConfig, 'ignore', next)
        if (!res.ok) {
          return { kind: 'notify', level: 'error', message: res.error }
        }
        const list = words.map(w => JSON.stringify(w)).join(', ')
        return {
          kind: 'notify',
          message: sub === 'add' ? `Never flagged now: ${list}.` : `Flagged again: ${list}.`,
        }
      }
      return report('help', usage(s, coachName))
    }

    case 'stats': {
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return report('stats', loaded)
      }
      const words = rest.join(' ')
      const picked = forLanguage(loaded.h, words, s)
      const period = parsePeriod(picked.rest, now)
      if (typeof period === 'string') {
        return report('stats', withLanguages(period, loaded.h))
      }
      const others = picked.others
        .map(o => ({ lang: o.lang, fixes: visible(within(inLanguage(loaded.h, o.lang), period), loaded.ignore).length }))
        .filter(o => o.fixes > 0)
      const h = loaded.h.fixes.length + loaded.h.days.length === 0 ? loaded.h : inLanguage(loaded.h, picked.lang)
      const language = picked.show ? picked.lang : undefined
      return report(
        'stats',
        statsText(h, loaded.ignore, now, paths.historyFile, s.history, period, words, coachName, language, others),
      )
    }

    case 'review': {
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return { kind: 'notify', level: 'error', message: loaded }
      }
      const words = rest.join(' ')
      const picked = forLanguage(loaded.h, words, s)
      const period = parsePeriod(picked.rest, now)
      if (typeof period === 'string') {
        return { kind: 'notify', level: 'warning', message: withLanguages(period, loaded.h) }
      }
      const h = inLanguage(loaded.h, picked.lang)
      const fixes = visible(within(h, period), loaded.ignore)
      if (fixes.length < REVIEW_FROM) {
        const longer = period.before === undefined ? '' : ' Try a longer period.'
        const where = picked.show ? ` in ${picked.lang}` : ''
        return {
          kind: 'notify',
          message: `Not enough to go on yet: ${fixes.length} fixes kept${where} for ${period.label}, the review starts at ${REVIEW_FROM}.${longer}`,
        }
      }
      if (coachResolved.kind !== 'ready') {
        return {
          kind: 'notify',
          level: 'warning',
          message: `No review: ${coachResolved.kind === 'missing' ? coachResolved.error : 'no model available'}.`,
        }
      }
      const summary = summaryOf(h, loaded.ignore, period, now, picked.show ? picked.lang : undefined)
      const r = await runModelCall(
        registry,
        coachResolved.model,
        appendSystemPrompt(reviewSystem(picked.lang), reviewerAppend),
        reviewInput(fixes),
        { maxTokens: 8000, timeoutMs: 180_000 },
      )
      if (!r.ok) {
        return { kind: 'notify', level: 'error', message: `No review: ${r.error}` }
      }
      const advice = r.text.trim()
      const footer = `${coachResolved.spec}, from ${summary.fixes} fixes${s.askMemory ? ' · /grammar ask <question> follows up' : ''}`
      const entry: ReportEntry = { kind: 'review', body: '', summary, advice, footer }
      entry.body = formatReportPlain(entry)
      const turn: GrammarTurn | undefined = s.askMemory
        ? { q: cut(`/grammar review ${words}`.trim(), MAX_QUESTION), a: cut(advice, MAX_ANSWER) }
        : undefined
      return report('review', entry.body, { summary, advice, footer }, turn)
    }

    case 'ask': {
      const rawTail = trimmed.slice(first.length).trim()
      const lower = rawTail.toLowerCase()
      const askList = () => {
        if (!s.askMemory) {
          return 'Ask memory: off. Each /grammar ask starts fresh. /grammar ask memory on remembers asks for follow-ups.'
        }
        if (session.thread.length === 0) {
          return `Ask memory: on, nothing remembered yet. Each /grammar ask and /grammar review is remembered for follow-ups, the last ${ASK_MEMORY}.`
        }
        const short = (t: string) => {
          const line = t.replace(/\s+/g, ' ').trim()
          return line.length > 90 ? `${cut(line, 90)}…` : line
        }
        return [
          `Ask memory: on. Follow-ups remember ${plural(session.thread.length, 'exchange')}, oldest first (the last ${ASK_MEMORY} are kept):`,
          ...session.thread.map((t, i) => `${i + 1}. ${short(t.q)}\n   ${short(t.a)}`),
          '/grammar ask clear forgets them; /grammar ask memory off stops remembering. Gone when the session ends.',
        ].join('\n')
      }

      if (lower === '' || lower === 'help') {
        const how = `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${coachName} about your writing, with your kept fixes at hand.\n/grammar ask list|clear, /grammar ask memory on|off.`
        return report('ask', `${how}\n\n${askList()}`)
      }
      if (lower === 'list') {
        return report('ask', askList())
      }
      if (lower === 'clear') {
        const n = session.thread.length
        return {
          kind: 'notify',
          clearAsk: n > 0,
          message: n === 0 ? 'Nothing remembered, nothing to forget.' : `Forgot ${plural(n, 'exchange')}: the next /grammar ask starts fresh.`,
        }
      }
      const mem = /^memory(?:\s+(on|off))?$/.exec(lower)
      if (mem !== null) {
        const want = mem[1] === 'on' ? true : mem[1] === 'off' ? false : !s.askMemory
        const res = writeGlobalField(paths.globalConfig, 'ask_memory', want)
        if (!res.ok) {
          return { kind: 'notify', level: 'error', message: res.error }
        }
        const n = session.thread.length
        return {
          kind: 'notify',
          clearAsk: !want && n > 0,
          message: want
            ? `Ask memory on: follow-ups remember the last ${ASK_MEMORY} asks and reviews of the session. /grammar ask list shows them.`
            : `Ask memory off: each /grammar ask starts fresh${n > 0 ? `, and the ${plural(n, 'remembered exchange')} ${n === 1 ? 'is' : 'are'} forgotten` : ''}.`,
        }
      }

      const split = splitAsk(rawTail, now)
      if (typeof split === 'string') {
        return { kind: 'notify', level: 'warning', message: split }
      }
      if (split.question === '') {
        return { kind: 'notify', level: 'warning', message: 'Ask what? /grammar ask 7d which prepositions do I mix up?' }
      }
      if (coachResolved.kind !== 'ready') {
        return {
          kind: 'notify',
          level: 'warning',
          message: `No answer: ${coachResolved.kind === 'missing' ? coachResolved.error : 'no model available'}.`,
        }
      }
      const question = cut(split.question, MAX_QUESTION)
      const loaded = loadHistorySafe()
      const fixes = typeof loaded === 'string' ? [] : visible(within(loaded.h, split.period), loaded.ignore)
      const recent = session.recentFixes.slice(0, ASK_RECENT)
      const turns = s.askMemory ? session.thread : []
      const r = await runModelCall(
        registry,
        coachResolved.model,
        appendSystemPrompt(ASK_SYSTEM, reviewerAppend),
        askInput(fixes, split.period.label, recent, turns, question),
        { maxTokens: 4000, timeoutMs: 120_000 },
      )
      if (!r.ok) {
        return { kind: 'notify', level: 'error', message: `No answer: ${r.error}` }
      }
      const advice = r.text.trim()
      const memoryNote = !s.askMemory
        ? 'memory off, each ask starts fresh'
        : turns.length === 0
          ? 'follow-ups remember this · /grammar ask clear forgets'
          : `remembered ${turns.length} earlier · /grammar ask list, clear`
      const footer = `${coachResolved.spec}, from ${plural(fixes.length, 'fix', 'fixes')} · ${memoryNote}`
      const entry: ReportEntry = { kind: 'ask', body: '', advice, footer }
      entry.body = formatReportPlain(entry)
      const turn: GrammarTurn | undefined = s.askMemory ? { q: question, a: cut(advice, MAX_ANSWER) } : undefined
      return report('ask', entry.body, { advice, footer }, turn)
    }

    case 'history': {
      if (sub === 'clear') {
        if (!existsSync(paths.historyFile)) {
          return { kind: 'notify', message: 'Nothing kept, nothing to clear.' }
        }
        clearHistoryFile(paths.historyFile)
        return { kind: 'notify', message: `Cleared: ${paths.historyFile} holds no fixes now.` }
      }
      if (sub === 'on' || sub === 'off') {
        const want = sub === 'on'
        const res = writeGlobalField(paths.globalConfig, 'history', want)
        if (!res.ok) {
          return { kind: 'notify', level: 'error', message: res.error }
        }
        return {
          kind: 'notify',
          message: want
            ? `History on: each fix is kept in ${paths.historyFile} for /grammar stats and /grammar review.`
            : `History off: no new fixes are kept. What ${paths.historyFile} holds stays; /grammar history clear empties it.`,
        }
      }
      if (sub !== '') {
        return report('help', usage(s, coachName))
      }
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return report('history', `History: ${s.history ? 'on' : 'off'}. ${loaded}`)
      }
      return report(
        'history',
        [
          `History: ${s.history ? 'on' : 'off'}${s.history && !projectAllowsHistory ? ', but off in this project (its .pi/grammar.json says "history": false)' : ''}.`,
          `${visible(loaded.h, loaded.ignore).length} fixes kept in ${paths.historyFile}: the last ${KEEP_DAYS} days, up to ${MAX_ENTRIES}.`,
          '/grammar history on|off switches it; /grammar history clear empties the file.',
        ].join('\n'),
      )
    }

    case 'config': {
      if (rest.length === 0) {
        return report(
          'config',
          [
            `Config file: ${paths.globalConfig}`,
            ...(paths.projectConfig && existsSync(paths.projectConfig) ? [`Project file: ${paths.projectConfig}`] : []),
            `enabled: ${s.enabled}`,
            `natural: ${s.natural}`,
            `language: ${s.language}`,
            `dialect: ${s.dialect}`,
            `min_words: ${s.minWords}`,
            `max_chars: ${s.maxChars}`,
            `show_why: ${s.showWhy}`,
            `history: ${s.history}`,
            `clean: ${s.clean}`,
            `ask_memory: ${s.askMemory}`,
            `render: ${s.render}`,
            `model: ${s.model}`,
            `model_reviewer: ${s.modelReviewer ?? '(inherit model)'}`,
            `system_prompt_append: ${s.systemPromptAppend || '(none)'}`,
            `system_prompt_append_reviewer: ${s.systemPromptAppendReviewer === undefined ? '(inherit system_prompt_append)' : s.systemPromptAppendReviewer || '(none)'}`,
            `timeout_ms: ${s.timeoutMs}`,
            '',
            `Set with: /grammar config <key> <value> (or \`unset\` to reset).`,
          ].join('\n'),
        )
      }
      const key = (rest[0] ?? '').toLowerCase()
      const rawVal = rest.slice(1).join(' ')
      if (rawVal === '') {
        return { kind: 'notify', level: 'warning', message: `Usage: /grammar config <key> <value>. Valid keys: ${CONFIG_KEYS.join(', ')}.` }
      }
      const parsed = parseConfigValue(key, rawVal, registry)
      if (!parsed.ok) {
        return { kind: 'notify', level: 'warning', message: parsed.error }
      }
      let warning = ''
      if (parsed.model) {
        const auth = await checkModelAuth(registry, parsed.model)
        if (!auth.ok) {
          warning = ` Warning: ${auth.warning}.`
        }
      }
      const res = writeGlobalField(paths.globalConfig, key, parsed.value)
      if (!res.ok) {
        return { kind: 'notify', level: 'error', message: res.error }
      }
      const shown = parsed.value === undefined ? '(default)' : parsed.value === '' ? '""' : String(parsed.value)
      return {
        kind: 'notify',
        level: warning ? 'warning' : 'info',
        clearWidget: key === 'render' && (parsed.value === 'entry' || parsed.value === 'off'),
        refreshModel: key === 'model',
        message: `Updated ${key} = ${shown} in ${paths.globalConfig}.${warning}`,
      }
    }

    default:
      return report('help', usage(s, coachName))
  }
}
