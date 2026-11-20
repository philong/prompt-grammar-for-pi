import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMPTY_HISTORY, historyText, record } from '../history'
import { migrateFromPriorBuilds } from '../migrate'

const NOW = Date.UTC(2026, 9, 30, 12)

describe('migrate', () => {
  test('migrates Claude Code history + ignore/skip/history without creating .bak files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-mig-claude-'))
    try {
      const home = join(tmp, 'home')
      const agentDir = join(home, '.pi', 'agent')
      const claudeDir = join(home, '.claude')
      mkdirSync(claudeDir, { recursive: true })

      const h = record(EMPTY_HISTORY, [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }], NOW)
      const histRaw = historyText(h)
      writeFileSync(join(claudeDir, 'grammar-history.json'), histRaw, 'utf8')
      writeFileSync(
        join(claudeDir, 'grammar.json'),
        JSON.stringify({ ignore: ['kubectl'], skip: ['^deploy '], history: false, model: 'haiku' }),
      )

      const res = migrateFromPriorBuilds({ agentDir, homeDir: home, env: {} })
      expect(res.migrated).toBe(true)
      expect(res.historyFrom).toBe('claude')
      expect(res.settingsFrom).toEqual(['claude'])
      expect(readFileSync(join(agentDir, 'grammar-history.json'), 'utf8')).toBe(histRaw)
      const migratedCfg = JSON.parse(readFileSync(join(agentDir, 'grammar.json'), 'utf8'))
      expect(migratedCfg).toEqual({ ignore: ['kubectl'], skip: ['^deploy '], history: false })
      expect(existsSync(join(claudeDir, 'grammar-history.json.bak'))).toBe(false)
      expect(existsSync(join(claudeDir, 'grammar.json.bak'))).toBe(false)

      // Second run is a no-op once Pi target files exist.
      const second = migrateFromPriorBuilds({ agentDir, homeDir: home, env: {} })
      expect(second.migrated).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('falls back to Antigravity history, translates display, drops legacy keys, and emits models.json snippet', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-mig-agy-'))
    try {
      const home = join(tmp, 'home')
      const agentDir = join(home, '.pi', 'agent')
      const agyCfgDir = join(home, '.gemini', 'config')
      const agyDataDir = join(home, '.gemini', 'antigravity-cli', 'plugin_data', 'prompt-grammar')
      mkdirSync(agyCfgDir, { recursive: true })
      mkdirSync(agyDataDir, { recursive: true })

      const h = record(EMPTY_HISTORY, [{ from: 'tset', to: 'test', why: 'typo', kind: 'spelling' }], NOW)
      writeFileSync(join(agyDataDir, 'grammar-history.json'), historyText(h), 'utf8')
      writeFileSync(
        join(agyCfgDir, 'grammar.json'),
        JSON.stringify({
          natural: false,
          display: 'async',
          statusline: true,
          auto: true,
          user_markdown: true,
          cowork: false,
          desktop: 'band',
          icons: false,
          endpoint: 'http://localhost:11434',
          endpoint_model: 'qwen2.5:7b',
          endpoint_key: 'secret',
        }),
      )

      const res = migrateFromPriorBuilds({ agentDir, homeDir: home, env: {} })
      expect(res.migrated).toBe(true)
      expect(res.historyFrom).toBe('antigravity')
      expect(res.settingsFrom).toEqual(['antigravity'])
      expect(res.endpointSnippet).toContain('http://localhost:11434/v1')
      expect(res.endpointSnippet).toContain('qwen2.5:7b')
      expect(res.endpointSnippet).toContain('/grammar model custom/qwen2.5:7b')
      expect(res.endpointSnippet).not.toContain('secret')

      const cfg = JSON.parse(readFileSync(join(agentDir, 'grammar.json'), 'utf8'))
      expect(cfg).toEqual({ natural: false, render: 'entry' })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
