// One-time migration from prompt-grammar-for-claude and prompt-grammar-for-agy into Pi's agentDir.
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readRawConfig } from './config'
import { parseHistory } from './history'
import { atomicWrite } from './state'

const SHARED_AGY_KEYS = [
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
  'timeout_ms',
  'ignore',
  'skip',
] as const

export type MigrationResult = {
  migrated: boolean
  historyFrom?: 'claude' | 'antigravity'
  settingsFrom: ('claude' | 'antigravity')[]
  endpointSnippet?: string
  summary?: string
}

const normalizeEndpointUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') {
    return ''
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.pathname === '/' || parsed.pathname === '' ? `${trimmed}/v1` : trimmed
  } catch {
    return trimmed
  }
}

const stringArr = (val: unknown): string[] =>
  Array.isArray(val) ? val.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

const mergeStringArr = (a: unknown, b: unknown): string[] | undefined => {
  const combined = [...new Set([...stringArr(a), ...stringArr(b)])]
  return combined.length > 0 ? combined : undefined
}

const buildEndpointSnippet = (endpoint: string, endpointModel: string, hasKey: boolean): string => {
  const baseUrl = normalizeEndpointUrl(endpoint) || 'http://localhost:11434/v1'
  const modelId = endpointModel.trim() || 'your-model-id'
  const snippet = {
    providers: {
      custom: {
        baseUrl,
        api: 'openai-completions',
        apiKey: hasKey ? '$PROMPT_GRAMMAR_ENDPOINT_KEY' : 'dummy',
        models: [{ id: modelId }],
      },
    },
  }
  return `Configure your endpoint in ~/.pi/agent/models.json, then run /grammar model custom/${modelId}:\n${JSON.stringify(snippet, null, 2)}`
}

/**
 * Copy grammar-history.json and translate grammar.json once when the Pi files are absent.
 * Never modifies or deletes source files (no `.bak` files created).
 */
export const migrateFromPriorBuilds = (params: {
  agentDir: string
  env?: Record<string, string | undefined>
  homeDir?: string
}): MigrationResult => {
  const env = params.env ?? process.env
  const home = (params.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir()).replace(/[\\/]+$/, '')
  const agentDir = params.agentDir.replace(/[\\/]+$/, '')

  const targetHistory = join(agentDir, 'grammar-history.json')
  const targetConfig = join(agentDir, 'grammar.json')
  const needHistory = !existsSync(targetHistory)
  const needConfig = !existsSync(targetConfig)

  if (!needHistory && !needConfig) {
    return { migrated: false, settingsFrom: [] }
  }

  const claudeDir = (env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')).replace(/[\\/]+$/, '')
  const agyConfigDir = (env.PROMPT_GRAMMAR_CONFIG_DIR?.trim() || join(home, '.gemini', 'config')).replace(/[\\/]+$/, '')
  const agyDataDirs = [
    env.PLUGIN_DATA?.trim(),
    env.PROMPT_GRAMMAR_DATA_DIR?.trim(),
    join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'prompt-grammar'),
    join(home, '.gemini', 'antigravity', 'plugin_data', 'prompt-grammar'),
    join(home, '.gemini', 'antigravity-ide', 'plugin_data', 'prompt-grammar'),
    join(agyConfigDir, 'grammar-data'),
  ].filter((d): d is string => Boolean(d && d.trim() !== ''))

  let historyFrom: 'claude' | 'antigravity' | undefined
  if (needHistory) {
    const candidates: Array<{ path: string; source: 'claude' | 'antigravity' }> = [
      { path: join(claudeDir, 'grammar-history.json'), source: 'claude' },
      ...agyDataDirs.map(dir => ({ path: join(dir, 'grammar-history.json'), source: 'antigravity' as const })),
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) {
        continue
      }
      try {
        const raw = readFileSync(candidate.path, 'utf8')
        parseHistory(raw)
        atomicWrite(targetHistory, raw)
        historyFrom = candidate.source
        break
      } catch {
        // Ignore corrupt/unreadable candidate and continue checking fallback.
      }
    }
  }

  const settingsFrom: ('claude' | 'antigravity')[] = []
  let endpointSnippet: string | undefined

  if (needConfig) {
    const nextConfig: Record<string, unknown> = {}
    const agyConfigPath = join(agyConfigDir, 'grammar.json')
    const claudeConfigPath = join(claudeDir, 'grammar.json')

    if (existsSync(agyConfigPath)) {
      const agy = readRawConfig(agyConfigPath)
      if (agy.error === undefined) {
        for (const key of SHARED_AGY_KEYS) {
          if (agy.raw[key] !== undefined) {
            nextConfig[key] = agy.raw[key]
          }
        }
        const rawDisplay = typeof agy.raw.display === 'string' ? agy.raw.display.trim().toLowerCase() : ''
        if (rawDisplay === 'reply' || rawDisplay === 'async' || rawDisplay === 'system') {
          nextConfig.render = 'entry'
        }
        const endpoint = typeof agy.raw.endpoint === 'string' ? agy.raw.endpoint.trim() : ''
        const endpointModel = typeof agy.raw.endpoint_model === 'string' ? agy.raw.endpoint_model.trim() : ''
        const endpointKey = typeof agy.raw.endpoint_key === 'string' ? agy.raw.endpoint_key.trim() : ''
        if (endpoint !== '' || endpointModel !== '' || endpointKey !== '') {
          endpointSnippet = buildEndpointSnippet(endpoint, endpointModel, endpointKey !== '')
        }
        settingsFrom.push('antigravity')
      }
    }

    if (existsSync(claudeConfigPath)) {
      const claude = readRawConfig(claudeConfigPath)
      if (claude.error === undefined) {
        let copiedClaude = false
        const mergedIgnore = mergeStringArr(nextConfig.ignore, claude.raw.ignore)
        if (mergedIgnore !== undefined) {
          nextConfig.ignore = mergedIgnore
          copiedClaude = true
        }
        const mergedSkip = mergeStringArr(nextConfig.skip, claude.raw.skip)
        if (mergedSkip !== undefined) {
          nextConfig.skip = mergedSkip
          copiedClaude = true
        }
        if (typeof claude.raw.history === 'boolean') {
          nextConfig.history = typeof nextConfig.history === 'boolean' ? nextConfig.history && claude.raw.history : claude.raw.history
          copiedClaude = true
        }
        if (copiedClaude) {
          settingsFrom.push('claude')
        }
      }
    }

    if (settingsFrom.length > 0) {
      atomicWrite(targetConfig, `${JSON.stringify(nextConfig, null, 2)}\n`)
      try {
        chmodSync(targetConfig, 0o600)
      } catch {
        // Best-effort POSIX permission tightening.
      }
    }
  }

  const migrated = historyFrom !== undefined || settingsFrom.length > 0 || endpointSnippet !== undefined
  if (!migrated) {
    return { migrated: false, settingsFrom: [] }
  }

  const parts: string[] = []
  if (historyFrom) {
    parts.push(`history from ${historyFrom === 'claude' ? 'Claude Code' : 'Antigravity'}`)
  }
  if (settingsFrom.length > 0) {
    const names = settingsFrom.map(s => (s === 'claude' ? 'Claude Code' : 'Antigravity')).join(' & ')
    parts.push(`settings from ${names}`)
  }
  const summary = `Migrated grammar ${parts.join(' and ')} into ${agentDir}.${endpointSnippet ? ' Legacy endpoint settings were dropped; see models.json snippet.' : ''}`
  return { migrated: true, historyFrom, settingsFrom, endpointSnippet, summary }
}
