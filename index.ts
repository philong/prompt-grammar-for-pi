// Pi extension entrypoint: event gate, prompt-anchored entry placement, command/widget/shortcut wiring.
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

import { fallbackFor, keepFixes, parseReply, system, typedPart, usefulNatural } from './check'
import { getGrammarCompletions, runGrammarCommand } from './commands'
import {
  ENGLISH,
  compileIgnore,
  compileSkip,
  cut,
  keptLanguage,
  lettersFor,
  loadConfigAndLists,
  resolvePaths,
  wordCount,
} from './config'
import type { Lists, Paths, Settings } from './config'
import { ASK_MEMORY } from './history'
import { migrateFromPriorBuilds } from './migrate'
import { resolveCheckModel, runModelCall } from './model'
import type { ResolvedModel } from './model'
import { STREAK_FROM, formatReportPlain, linesOf, renderCheckEntry, renderReportEntry } from './render'
import { MAX_FAILS, applyCheckOutcome, emptySession, rebuildSessionState, recordToHistoryFile } from './state'
import type { SessionState } from './state'
import type { GrammarAskTurnEntry, GrammarCheck, GrammarEntry, GrammarStateEntry, ReportEntry } from './types'

const WIDGET_KEY = 'grammar'
const DEFAULT_SHUTDOWN_WAIT_MS = 2000
const SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type ExtensionFactoryOptions = {
  agentDir?: string
  now?: () => number
  shutdownWaitMs?: number
  homeDir?: string
  env?: Record<string, string | undefined>
}

type CheckOutcome = {
  check: GrammarCheck
  writesHistory: boolean
}

type PendingCheck = {
  id: number
  rawText: string
  settings: Settings
  ac: AbortController
  writesHistory: boolean
  settled: boolean
  createdAt: number
  matchedAt?: number
  targetTimestamp?: number
  promptEntryId?: string
  result?: CheckOutcome
  donePromise: Promise<void>
}

/** Check whether a persisted user message matches a checked raw prompt (exact or with appended image-resize hints). */
export const matchesPromptText = (rawText: string, msgText: string): boolean => {
  const trimmed = msgText.trim()
  if (trimmed === rawText) {
    return true
  }
  return trimmed.startsWith(rawText) && /^[ \t]*\r?\n/.test(trimmed.slice(rawText.length))
}

const extractMessageText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((part): part is { type: string; text?: unknown } => part !== null && typeof part === 'object')
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}

const checkableText = (rawInput: string, settings: Settings, lists: Lists, fails: number): string | undefined => {
  if (!settings.enabled || settings.model === 'off' || fails >= MAX_FAILS) {
    return undefined
  }
  const text = typedPart(rawInput)
  if (text === '' || text.startsWith('/')) {
    return undefined
  }
  if (!lettersFor(settings.language).test(text) || wordCount(text) < settings.minWords) {
    return undefined
  }
  if (compileSkip(lists.skip).some(re => re.test(text))) {
    return undefined
  }
  return text
}

const findPersistedUserEntryId = (branch: readonly SessionEntry[], timestamp: number): string | undefined => {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    if (entry?.type === 'message' && entry.message.role === 'user' && entry.message.timestamp === timestamp) {
      return entry.id
    }
  }
  return undefined
}

/** Build the Pi grammar extension (accepts test overrides for `agentDir`, clock, and shutdown cap). */
export const createGrammarExtension = (opts: ExtensionFactoryOptions = {}) => {
  const getDir = () => opts.agentDir ?? getAgentDir()
  const now = opts.now ?? Date.now
  const shutdownWaitMs = opts.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS

  return (pi: ExtensionAPI) => {
    let disposed = false
    let migrationChecked = false
    let sessionState: SessionState = emptySession()
    let resolvedCheckModel: ResolvedModel = { kind: 'off' }
    let activeCtx: ExtensionContext | undefined
    let agentEnded = true
    const pending: PendingCheck[] = []
    const inFlight = new Set<PendingCheck>()
    const retryTimers = new Set<ReturnType<typeof setTimeout>>()

    const pathsOf = (ctx: ExtensionContext): Paths => resolvePaths(getDir(), ctx.cwd, ctx.isProjectTrusted())

    const refreshModel = (ctx: ExtensionContext, activeOverride = ctx.model): ResolvedModel => {
      const { settings } = loadConfigAndLists(pathsOf(ctx))
      resolvedCheckModel = resolveCheckModel(settings.model, {
        activeModel: activeOverride,
        registry: ctx.modelRegistry,
        scopedModels: ctx.scopedModels,
      })
      return resolvedCheckModel
    }

    const dropPending = (item: PendingCheck) => {
      const idx = pending.indexOf(item)
      if (idx >= 0) {
        pending.splice(idx, 1)
      }
    }

    const scheduleTimer = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        retryTimers.delete(timer)
        fn()
      }, ms)
      retryTimers.add(timer)
    }

    const clearPendingAndTimers = () => {
      for (const timer of retryTimers) {
        clearTimeout(timer)
      }
      retryTimers.clear()
      pending.length = 0
    }

    const tryFlushPending = (item: PendingCheck, ctx: ExtensionContext) => {
      if (disposed || item.result === undefined || item.promptEntryId === undefined) {
        return
      }
      dropPending(item)

      const branch = ctx.sessionManager.getBranch()
      if (!branch.some(entry => entry.id === item.promptEntryId)) {
        return
      }

      const rawCheck = item.result.check
      sessionState = applyCheckOutcome(sessionState, rawCheck)
      const isClean = rawCheck.status === 'done' && rawCheck.fixes.length === 0 && !rawCheck.natural
      const check: GrammarCheck = {
        ...rawCheck,
        ...(isClean ? { streak: sessionState.streak } : {}),
        ...(rawCheck.status === 'error' ? { paused: sessionState.fails >= MAX_FAILS } : {}),
      }

      const render = item.settings.render
      const wantEntry = render === 'entry' || render === 'both'
      const showEntry =
        check.status === 'skipped'
          ? false
          : check.status === 'error'
            ? wantEntry
            : wantEntry && (!isClean || (item.settings.clean && sessionState.streak >= STREAK_FROM))

      const entry: GrammarEntry = {
        ...check,
        display: showEntry,
        showWhy: item.settings.showWhy,
      }

      if (ctx.mode === 'tui' || ctx.mode === 'rpc') {
        pi.appendEntry<GrammarEntry>('grammar-check', entry)

        const wantWidget = render === 'widget' || render === 'both' || (ctx.mode === 'rpc' && render === 'entry')
        if (wantWidget && check.status !== 'skipped') {
          if (isClean && !item.settings.clean) {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
          } else {
            const lines = linesOf(entry, {
              styled: ctx.mode === 'tui',
              theme: ctx.mode === 'tui' ? ctx.ui.theme : undefined,
              showWhy: item.settings.showWhy,
            })
            ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined)
          }
        }
      }
    }

    const resolveMatchedEntries = (ctx: ExtensionContext) => {
      if (disposed) {
        return
      }
      const branch = ctx.sessionManager.getBranch()
      for (const item of [...pending]) {
        if (item.matchedAt === undefined || item.promptEntryId !== undefined || item.targetTimestamp === undefined) {
          continue
        }
        const entryId = findPersistedUserEntryId(branch, item.targetTimestamp)
        if (entryId !== undefined) {
          item.promptEntryId = entryId
          tryFlushPending(item, ctx)
        }
      }
    }

    const pruneExpiredUnmatched = () => {
      if (disposed || !agentEnded) {
        return
      }
      const ts = now()
      for (const item of [...pending]) {
        if (item.matchedAt === undefined && ts - item.createdAt >= item.settings.timeoutMs) {
          dropPending(item)
        }
      }
    }

    // --- TUI renderers & shortcut ---

    pi.registerEntryRenderer<GrammarEntry>('grammar-check', renderCheckEntry)
    pi.registerEntryRenderer<ReportEntry>('grammar-report', renderReportEntry)

    pi.registerShortcut('ctrl+alt+g', {
      description: 'Hide the grammar widget above the editor',
      handler: async ctx => {
        if (ctx.mode === 'tui' || ctx.mode === 'rpc') {
          ctx.ui.setWidget(WIDGET_KEY, undefined)
        }
      },
    })

    // --- /grammar command ---

    pi.registerCommand('grammar', {
      description: 'Grammar proofreader settings, mistake stats, review, and coaching',
      getArgumentCompletions: prefix => {
        const models = activeCtx
          ? activeCtx.modelRegistry
              .getAvailable()
              .filter(m => m.api !== 'pi-virtual' && m.input.includes('text'))
              .map(m => `${m.provider}/${m.id}`)
          : []
        return getGrammarCompletions(prefix, models)
      },
      handler: async (args, ctx) => {
        if (ctx.mode === 'print' || ctx.mode === 'json') {
          return
        }
        const out = await runGrammarCommand({
          args,
          paths: pathsOf(ctx),
          session: sessionState,
          activeModel: ctx.model,
          scopedModels: ctx.scopedModels,
          registry: ctx.modelRegistry,
          now: now(),
        })
        if (disposed) {
          return
        }
        if (out.clearWidget) {
          ctx.ui.setWidget(WIDGET_KEY, undefined)
        }
        if (out.refreshModel) {
          refreshModel(ctx)
        }
        if (out.kind === 'notify') {
          if (out.resetFails) {
            pi.appendEntry<GrammarStateEntry>('grammar-state', { failsReset: true })
            sessionState = { ...sessionState, fails: 0, lastError: undefined }
          }
          if (out.clearAsk) {
            pi.appendEntry<GrammarAskTurnEntry>('grammar-ask-turn', { cleared: true })
            sessionState = { ...sessionState, thread: [] }
          }
          ctx.ui.notify(out.message, out.level ?? 'info')
          return
        }
        if (out.askTurn) {
          pi.appendEntry<GrammarAskTurnEntry>('grammar-ask-turn', out.askTurn)
          sessionState = { ...sessionState, thread: [...sessionState.thread, out.askTurn].slice(-ASK_MEMORY) }
        }
        pi.appendEntry<ReportEntry>('grammar-report', out.report)
        if (ctx.mode === 'rpc') {
          ctx.ui.notify(formatReportPlain(out.report), 'info')
        }
      },
    })

    // --- Session & agent lifecycle ---

    pi.on('session_start', (_event, ctx) => {
      disposed = false
      activeCtx = ctx
      agentEnded = true
      clearPendingAndTimers()
      if (!migrationChecked) {
        migrationChecked = true
        const mig = migrateFromPriorBuilds({ agentDir: getDir(), env: opts.env, homeDir: opts.homeDir })
        if (mig.migrated && ctx.mode !== 'print' && ctx.mode !== 'json') {
          if (mig.summary) {
            ctx.ui.notify(mig.summary, 'info')
          }
          if (mig.endpointSnippet) {
            pi.appendEntry<ReportEntry>('grammar-report', { kind: 'model', body: mig.endpointSnippet })
            if (ctx.mode === 'rpc') {
              ctx.ui.notify(mig.endpointSnippet, 'info')
            }
          }
        }
      }
      sessionState = rebuildSessionState(ctx.sessionManager.getBranch())
      refreshModel(ctx)
    })

    pi.on('session_tree', (_event, ctx) => {
      activeCtx = ctx
      sessionState = rebuildSessionState(ctx.sessionManager.getBranch())
    })

    pi.on('model_select', (event, ctx) => {
      activeCtx = ctx
      refreshModel(ctx, event.model ?? ctx.model)
    })

    pi.on('input', (event, ctx) => {
      activeCtx = ctx
      if (disposed || event.source === 'extension') {
        return { action: 'continue' }
      }
      const paths = pathsOf(ctx)
      const { settings, lists, projectAllowsHistory } = loadConfigAndLists(paths)
      const text = checkableText(event.text, settings, lists, sessionState.fails)
      if (text === undefined) {
        return { action: 'continue' }
      }
      const resolved = refreshModel(ctx)
      if (resolved.kind !== 'ready') {
        return { action: 'continue' }
      }

      const checkId = now()
      const ac = new AbortController()
      const writesHistory = settings.history && lists.history && projectAllowsHistory
      const item: PendingCheck = {
        id: checkId,
        rawText: event.text.trim(),
        settings,
        ac,
        writesHistory,
        settled: false,
        createdAt: checkId,
        donePromise: Promise.resolve(),
      }
      pending.push(item)
      inFlight.add(item)

      const ignore = compileIgnore(lists.ignore)
      const sysPrompt = system({
        natural: settings.natural,
        language: settings.language,
        dialect: settings.dialect,
        showWhy: settings.showWhy,
        kind: writesHistory,
        ignore: ignore.words,
      })

      scheduleTimer(() => {
        pruneExpiredUnmatched()
      }, settings.timeoutMs)

      item.donePromise = (async () => {
        try {
          const r = await runModelCall(ctx.modelRegistry, resolved.model, sysPrompt, cut(text, settings.maxChars), {
            maxTokens: 2048,
            timeoutMs: settings.timeoutMs,
            signal: ac.signal,
          })
          if (!r.ok) {
            if (r.aborted) {
              dropPending(item)
              return
            }
            item.result = {
              writesHistory: false,
              check: { id: checkId, text, status: 'error', fixes: [], error: r.error },
            }
            tryFlushPending(item, ctx)
            return
          }

          try {
            const reply = parseReply(r.text, fallbackFor(settings.language))
            const language = reply === null ? undefined : keptLanguage(settings.language, reply.language)
            if (reply === null || language === undefined) {
              item.result = {
                writesHistory: false,
                check: { id: checkId, text, status: 'skipped', fixes: [] },
              }
              tryFlushPending(item, ctx)
              return
            }
            const fixes = keepFixes(reply.fixes, text, ignore)
            const natural = settings.natural ? usefulNatural(reply.natural, text, fixes, ignore) : null
            if (writesHistory) {
              recordToHistoryFile(paths.historyFile, fixes, checkId, language ?? ENGLISH)
            }
            item.result = {
              writesHistory,
              check: { id: checkId, text, status: 'done', fixes, natural, language },
            }
            tryFlushPending(item, ctx)
          } catch (err) {
            item.result = {
              writesHistory: false,
              check: {
                id: checkId,
                text,
                status: 'error',
                fixes: [],
                error: err instanceof Error ? err.message : String(err),
              },
            }
            tryFlushPending(item, ctx)
          }
        } finally {
          item.settled = true
          inFlight.delete(item)
        }
      })()

      return { action: 'continue' }
    })

    pi.on('message_end', (event, ctx) => {
      activeCtx = ctx
      if (disposed || event.message.role !== 'user') {
        return
      }
      const msgText = extractMessageText(event.message.content)
      const match = pending.find(p => p.matchedAt === undefined && matchesPromptText(p.rawText, msgText))
      if (!match) {
        return
      }
      match.matchedAt = now()
      match.targetTimestamp = event.message.timestamp
      // SessionManager appends the user message synchronously after message_end handlers return.
      scheduleTimer(() => {
        resolveMatchedEntries(ctx)
      }, 0)
    })

    pi.on('message_start', (_event, ctx) => {
      activeCtx = ctx
      agentEnded = false
      resolveMatchedEntries(ctx)
    })

    pi.on('agent_start', (_event, ctx) => {
      activeCtx = ctx
      agentEnded = false
    })

    pi.on('agent_end', (_event, ctx) => {
      activeCtx = ctx
      resolveMatchedEntries(ctx)
      if (!ctx.hasPendingMessages()) {
        agentEnded = true
        pruneExpiredUnmatched()
      }
    })

    pi.on('session_shutdown', async event => {
      disposed = true
      clearPendingAndTimers()
      if (event.reason === 'quit') {
        const historyChecks = [...inFlight].filter(item => item.writesHistory && !item.settled)
        if (historyChecks.length > 0) {
          await Promise.race([Promise.allSettled(historyChecks.map(item => item.donePromise)), SLEEP(shutdownWaitMs)])
          for (const item of historyChecks) {
            if (!item.settled) {
              item.ac.abort()
            }
          }
        }
      }
    })
  }
}

export default createGrammarExtension()
