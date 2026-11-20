#!/usr/bin/env node
// Backfill ~/.pi/agent/grammar-history.json from past Pi session JSONL files.
//
//   npx jiti tools/import-pi.ts --dry-run
//   npx jiti tools/import-pi.ts --days 30
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModelRegistry, createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent'

import { BATCH, fallbackFor, keepFixes, parseBatch, system, typedPart } from '../check'
import {
  AUTO,
  compileIgnore,
  compileSkip,
  cut,
  joinNames,
  keptLanguage,
  languagesOf,
  lettersFor,
  loadConfigAndLists,
  resolvePaths,
  wordCount,
} from '../config'
import type { Settings } from '../config'
import { EMPTY_HISTORY, KEEP_DAYS, dayOf, historyText, importWindow, merge, parseHistory, record } from '../history'
import type { History } from '../history'
import { resolveCheckModel, runModelCall } from '../model'
import { atomicWrite } from '../state'
import type { GrammarFix, GrammarReply } from '../types'

const CALL_TIMEOUT_MS = 180_000
const BATCH_SIZE = 20
const PARALLEL = 3
const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms))

export type ImportedPrompt = {
  key: string
  text: string
  at: number
}

const extractUserText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => part !== null && typeof part === 'object')
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}

/** Recursively collect `.jsonl` session files under `sessionsDir` modified at or after `fromMs`. */
export const findPiSessionFiles = (sessionsDir: string, fromMs: number): string[] => {
  if (!existsSync(sessionsDir)) {
    return []
  }
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile() && name.endsWith('.jsonl') && st.mtimeMs >= fromMs) {
        files.push(full)
      }
    }
  }
  walk(sessionsDir)
  return files.sort()
}

/** Extract checkable, deduplicated user prompts from a Pi session JSONL transcript. */
export const extractPiUserPrompts = (
  jsonlText: string,
  params: { from: number; to: number; settings: Settings; skipRegexes: readonly RegExp[]; seen?: Set<string> },
): ImportedPrompt[] => {
  const seen = params.seen ?? new Set<string>()
  const out: ImportedPrompt[] = []
  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') {
      continue
    }
    const entry = parsed as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; timestamp?: unknown } }
    if (entry.type !== 'message' || entry.message?.role !== 'user') {
      continue
    }
    const raw = extractUserText(entry.message.content)
    const text = typedPart(raw)
    if (text === '' || text.startsWith('/')) {
      continue
    }
    const at =
      typeof entry.message.timestamp === 'number' && Number.isFinite(entry.message.timestamp)
        ? entry.message.timestamp
        : typeof entry.timestamp === 'string'
          ? Date.parse(entry.timestamp)
          : Number.NaN
    if (!Number.isFinite(at) || at < params.from || at >= params.to) {
      continue
    }
    if (!lettersFor(params.settings.language).test(text) || wordCount(text) < params.settings.minWords) {
      continue
    }
    if (params.skipRegexes.some(re => re.test(text))) {
      continue
    }
    const key = `${at}\0${text}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push({ key, text, at })
  }
  return out
}

export const batchPrompts = <T>(items: readonly T[], size = BATCH_SIZE): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: npx jiti tools/import-pi.ts [options]',
        '',
        'Options:',
        `  --days <1..${KEEP_DAYS}>     Days to backfill (default: 7)`,
        '  --sessions-dir <dir>  Override ~/.pi/agent/sessions',
        '  --agent-dir <dir>     Override ~/.pi/agent',
        '  --model <provider/id> Override check model',
        '  --delay-ms <ms>       Optional delay between batch calls',
        '  --dry-run             Count prompts and batches without model calls',
      ].join('\n'),
    )
    return
  }

  const flag = (name: string) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  const fail = (msg: string): never => {
    console.error(msg)
    process.exit(1)
  }

  const dryRun = args.includes('--dry-run')
  const days = Number(flag('--days') ?? 7)
  if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) {
    fail(`--days takes a whole number from 1 to ${KEEP_DAYS}, the days the history keeps.`)
  }
  const delayMs = flag('--delay-ms') !== undefined ? Number(flag('--delay-ms')) : 0
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    fail('--delay-ms takes a non-negative integer in milliseconds.')
  }

  const agentDir = flag('--agent-dir') ?? getAgentDir()
  const sessionsDir = flag('--sessions-dir') ?? join(agentDir, 'sessions')
  const paths = resolvePaths(agentDir)
  const { settings: s, lists } = loadConfigAndLists(paths)
  if (!s.history) {
    fail('The history is off in your settings (/grammar history on turns it on); nothing imported.')
  }

  let existing = EMPTY_HISTORY
  if (existsSync(paths.historyFile)) {
    try {
      existing = parseHistory(readFileSync(paths.historyFile, 'utf8'))
    } catch (err) {
      fail(`${paths.historyFile} does not parse (${err instanceof Error ? err.message : String(err)}); fix it or run /grammar history clear first.`)
    }
  }

  const first = existing.days[0]?.day
  const span = importWindow(Date.now(), days, first)
  if (span === undefined) {
    console.log(`The history already covers the last ${days} days (from ${first}); nothing to import.`)
    return
  }

  const files = findPiSessionFiles(sessionsDir, span.from)
  if (files.length === 0) {
    console.log(`No Pi session transcripts found in ${sessionsDir} for the last ${days} days.`)
    return
  }

  const seen = new Set<string>()
  const skipRegexes = compileSkip(lists.skip)
  const prompts: ImportedPrompt[] = []
  for (const file of files) {
    prompts.push(...extractPiUserPrompts(readFileSync(file, 'utf8'), { from: span.from, to: span.to, settings: s, skipRegexes, seen }))
  }
  prompts.sort((a, b) => a.at - b.at)

  const numbered = prompts.map((p, id) => ({ ...p, id }))
  const calls = batchPrompts(numbered, BATCH_SIZE)
  console.log(
    `${prompts.length} prompts typed from ${dayOf(span.from)} to ${first === undefined ? 'now' : `the end of ${dayOf(span.to - 1)}`} (UTC); ${calls.length} calls.`,
  )
  if (dryRun || prompts.length === 0) {
    return
  }

  const services = await createAgentSessionServices({ cwd: process.cwd(), agentDir })
  const registry = new ModelRegistry(services.modelRuntime)
  const defProvider = services.settingsManager.getDefaultProvider()
  const defModelId = services.settingsManager.getDefaultModel()
  const defaultActive =
    (defProvider && defModelId ? registry.find(defProvider, defModelId) : undefined) ?? registry.getAvailable()[0]
  const resolved = resolveCheckModel(flag('--model') ?? s.model, { activeModel: defaultActive, registry })
  if (resolved.kind !== 'ready') {
    return fail(`Cannot resolve model: ${resolved.kind === 'missing' ? resolved.error : 'model is off'}`)
  }
  const checkModel = resolved.model
  const checkSpec = resolved.spec

  const ignore = compileIgnore(lists.ignore)
  const sys = `${system({ natural: false, language: s.language, dialect: s.dialect, showWhy: s.showWhy, kind: true, ignore: ignore.words })}\n${BATCH}`
  const callTimeoutMs = Math.max(CALL_TIMEOUT_MS, delayMs + 60_000)
  const results = new Map<number, { fixes: GrammarFix[]; language: string } | null>()
  let done = 0

  const ask = async (batch: typeof numbered) => {
    const input = JSON.stringify(batch.map(p => ({ id: p.id, text: cut(p.text, s.maxChars) })))
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await runModelCall(registry, checkModel, sys, input, { maxTokens: 4096, timeoutMs: callTimeoutMs })
      if (!r.ok) {
        if (attempt === 1) {
          console.error(`\n  a call failed twice, ${batch.length} prompts left out: ${r.error}`)
        }
        continue
      }
      try {
        const replies = parseBatch(r.text, fallbackFor(s.language))
        if (replies.size === 0) {
          throw new Error(`no usable answer: ${r.text.slice(0, 120)}`)
        }
        return replies
      } catch (err) {
        if (attempt === 1) {
          console.error(`\n  a call failed twice, ${batch.length} prompts left out: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return new Map<number, GrammarReply | null>()
  }

  const queue = [...calls]
  const worker = async () => {
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      const replies = await ask(batch)
      const missing = batch.filter(p => !replies.has(p.id))
      if (missing.length > 0 && missing.length < batch.length) {
        for (const [id, r] of await ask(missing)) {
          replies.set(id, r)
        }
      }
      for (const p of batch) {
        const reply = replies.get(p.id)
        if (reply === undefined) continue
        const language = reply === null ? undefined : keptLanguage(s.language, reply.language)
        results.set(p.id, reply === null || language === undefined ? null : { fixes: keepFixes(reply.fixes, p.text, ignore), language })
      }
      done += 1
      process.stdout.write(`\r  ${done}/${calls.length} calls (${checkSpec})`)
      if (delayMs > 0 && queue.length > 0) {
        await sleep(delayMs)
      }
    }
  }

  await Promise.all(Array.from({ length: PARALLEL }, worker))
  process.stdout.write('\n')

  let imported = EMPTY_HISTORY
  for (const p of numbered) {
    const r = results.get(p.id)
    if (r !== undefined && r !== null) {
      imported = record(imported, r.fixes, p.at, r.language)
    }
  }

  let latest: History = existing
  if (existsSync(paths.historyFile)) {
    try {
      latest = parseHistory(readFileSync(paths.historyFile, 'utf8'))
    } catch {
      latest = existing
    }
  }
  atomicWrite(paths.historyFile, historyText(merge(imported, latest, Date.now())))

  const checked = imported.days.reduce((n, d) => n + d.checked, 0)
  const withFixes = imported.days.reduce((n, d) => n + d.withFixes, 0)
  const which = s.language === AUTO ? '' : ` in ${joinNames(languagesOf(s.language))}`
  console.log(`${checked} prompts${which} checked, ${withFixes} with a fix, ${imported.fixes.length} fixes kept in ${paths.historyFile}.`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main()
}
