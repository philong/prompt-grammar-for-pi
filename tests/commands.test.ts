import { describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGrammarCompletions, runGrammarCommand } from '../commands'
import { resolvePaths } from '../config'
import { EMPTY_HISTORY, historyText, record } from '../history'
import type { ModelLike, ModelRegistryLike } from '../model'
import { emptySession } from '../state'

const NOW = Date.UTC(2026, 9, 30, 12)

const makeModel = (provider: string, id: string, cost = { input: 1, output: 5 }): ModelLike => ({
  id,
  name: id,
  api: 'anthropic-messages',
  provider,
  reasoning: false,
  input: ['text'],
  cost,
  contextWindow: 128_000,
})

const setup = (opts: { replyText?: string; authOk?: boolean; authThrows?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-grammar-cmd-'))
  const paths = resolvePaths(dir)
  const sonnet = makeModel('anthropic', 'claude-sonnet-4-5', { input: 3, output: 15 })
  const haiku = makeModel('anthropic', 'claude-haiku-4-5', { input: 0.8, output: 4 })
  const kimi = makeModel('openrouter', 'moonshotai/kimi-k2.7-code', { input: 0.5, output: 1.5 })
  const models = [sonnet, haiku, kimi]
  const calls: { model: ModelLike; prompt: string; systemPrompt?: string }[] = []

  const registry: ModelRegistryLike<ModelLike> = {
    getAvailable: () => models,
    find: (p, id) => models.find(m => m.provider === p && m.id === id),
    hasConfiguredAuth: () => opts.authOk ?? true,
    getProviderAuth: async () => {
      if (opts.authThrows) throw new Error('missing key')
      return opts.authOk === false ? undefined : { auth: { apiKey: 'k' } }
    },
    streamSimple: (model, ctx) => {
      const first = ctx.messages[0]
      const text =
        first && Array.isArray(first.content)
          ? first.content.map(c => (c.type === 'text' ? c.text : '')).join('')
          : ''
      calls.push({ model, prompt: text, systemPrompt: ctx.systemPrompt })
      return {
        result: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: opts.replyText ?? 'Use "the" before specific nouns.' }],
          api: 'anthropic-messages',
          provider: model.provider,
          model: model.id,
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: NOW,
        }),
      }
    },
  }

  return {
    dir,
    paths,
    sonnet,
    haiku,
    kimi,
    registry,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('commands', () => {
  test('help, on/off, natural, render, hide, ignore, and config mutate grammar.json', async () => {
    const env = setup()
    try {
      const help = await runGrammarCommand({
        args: 'help',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(help.kind).toBe('report')
      if (help.kind === 'report') {
        expect(help.report.body).toContain('anthropic/claude-haiku-4-5')
        expect(help.report.body).toContain('/check')
      }

      const off = await runGrammarCommand({
        args: 'off',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(off).toMatchObject({ kind: 'notify', message: expect.stringContaining('off') })

      const on = await runGrammarCommand({
        args: 'on',
        paths: env.paths,
        session: { ...emptySession(), fails: 3, lastError: 'timeout' },
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(on).toMatchObject({ kind: 'notify', resetFails: true })

      const renderWidget = await runGrammarCommand({
        args: 'render widget',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(renderWidget).toMatchObject({ kind: 'notify', clearWidget: false })

      const renderEntry = await runGrammarCommand({
        args: 'render entry',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(renderEntry).toMatchObject({ kind: 'notify', clearWidget: true })

      const hide = await runGrammarCommand({
        args: 'hide',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(hide).toMatchObject({ kind: 'notify', clearWidget: true })

      await runGrammarCommand({
        args: 'ignore add kubectl, pull request',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      await runGrammarCommand({
        args: 'config min_words 3',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      const saved = JSON.parse(readFileSync(env.paths.globalConfig, 'utf8'))
      expect(saved.ignore).toEqual(['kubectl', 'pull request'])
      expect(saved.min_words).toBe(3)
      expect(saved.enabled).toBe(true)
    } finally {
      env.cleanup()
    }
  })

  test('model command lists models, splits explicit provider/modelId, and warns when auth throws', async () => {
    const env = setup({ authOk: false, authThrows: true })
    try {
      const listed = await runGrammarCommand({
        args: 'model',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(listed.kind).toBe('report')
      if (listed.kind === 'report') {
        expect(listed.report.body).toContain('openrouter/moonshotai/kimi-k2.7-code')
        expect(listed.report.body).toContain('Warning: auth check failed')
      }

      const setNested = await runGrammarCommand({
        args: 'model openrouter/moonshotai/kimi-k2.7-code',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(setNested).toMatchObject({
        kind: 'notify',
        level: 'warning',
        refreshModel: true,
        message: expect.stringContaining('openrouter/moonshotai/kimi-k2.7-code'),
      })

      const unknown = await runGrammarCommand({
        args: 'model openai/missing',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(unknown).toMatchObject({ kind: 'notify', level: 'error' })
    } finally {
      env.cleanup()
    }
  })

  test('stats, review, ask, and completions work cleanly', async () => {
    const env = setup()
    try {
      let h = EMPTY_HISTORY
      for (let i = 0; i < 20; i++) {
        h = record(h, [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }], NOW - i * 1000)
      }
      writeFileSync(env.paths.historyFile, historyText(h), 'utf8')

      const stats = await runGrammarCommand({
        args: 'stats 30d',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(stats.kind).toBe('report')
      if (stats.kind === 'report') {
        expect(stats.report.body).toContain('20 fixes kept')
        expect(stats.report.body).toContain('depend from → depend on')
      }

      await runGrammarCommand({
        args: 'config system_prompt_append <|think_off|>',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      const cfgView = await runGrammarCommand({
        args: 'config',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(cfgView.kind).toBe('report')
      if (cfgView.kind === 'report') {
        expect(cfgView.report.body).toContain('system_prompt_append: <|think_off|>')
        expect(cfgView.report.body).toContain('system_prompt_append_reviewer: (inherit system_prompt_append)')
      }

      const rev = await runGrammarCommand({
        args: 'review 30d',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(rev.kind).toBe('report')
      if (rev.kind === 'report') {
        expect(rev.report.kind).toBe('review')
        expect(rev.askTurn?.q).toBe('/grammar review 30d')
      }
      // Coaching uses ctx.model (sonnet) when model setting is "auto" and inherits system_prompt_append.
      expect(env.calls[0]?.model.id).toBe('claude-sonnet-4-5')
      expect(env.calls[0]?.systemPrompt?.endsWith('\n<|think_off|>')).toBe(true)

      const ask = await runGrammarCommand({
        args: 'ask why prepositions?',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(ask.kind).toBe('report')
      if (ask.kind === 'report') {
        expect(ask.askTurn?.q).toBe('why prepositions?')
      }
      expect(env.calls[1]?.systemPrompt?.endsWith('\n<|think_off|>')).toBe(true)

      await runGrammarCommand({
        args: 'config system_prompt_append_reviewer <|think_on|>',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      const cfgWithReviewer = await runGrammarCommand({
        args: 'config',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(cfgWithReviewer.kind).toBe('report')
      if (cfgWithReviewer.kind === 'report') {
        expect(cfgWithReviewer.report.body).toContain('system_prompt_append_reviewer: <|think_on|>')
      }

      await runGrammarCommand({
        args: 'review 30d',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(env.calls[2]?.systemPrompt?.endsWith('\n<|think_on|>')).toBe(true)
      expect(env.calls[2]?.systemPrompt?.includes('<|think_off|>')).toBe(false)

      await runGrammarCommand({
        args: 'ask why prepositions?',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(env.calls[3]?.systemPrompt?.endsWith('\n<|think_on|>')).toBe(true)
      expect(env.calls[3]?.systemPrompt?.includes('<|think_off|>')).toBe(false)

      const clearAppend = await runGrammarCommand({
        args: 'config system_prompt_append_reviewer ""',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(clearAppend).toMatchObject({ kind: 'notify', message: expect.stringContaining('system_prompt_append_reviewer = ""') })
      expect(JSON.parse(readFileSync(env.paths.globalConfig, 'utf8')).system_prompt_append_reviewer).toBe('')
      const cfgEmptyReviewer = await runGrammarCommand({
        args: 'config',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(cfgEmptyReviewer.kind).toBe('report')
      if (cfgEmptyReviewer.kind === 'report') {
        expect(cfgEmptyReviewer.report.body).toContain('system_prompt_append_reviewer: (none)')
      }
      await runGrammarCommand({
        args: 'review 30d',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(env.calls[4]?.systemPrompt?.includes('<|think_off|>')).toBe(false)
      expect(env.calls[4]?.systemPrompt?.includes('<|think_on|>')).toBe(false)

      await runGrammarCommand({
        args: 'config system_prompt_append_reviewer unset',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(JSON.parse(readFileSync(env.paths.globalConfig, 'utf8')).system_prompt_append_reviewer).toBeUndefined()
      await runGrammarCommand({
        args: 'review 30d',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
        now: NOW,
      })
      expect(env.calls[5]?.systemPrompt?.endsWith('\n<|think_off|>')).toBe(true)

      await runGrammarCommand({
        args: 'config system_prompt_append unset',
        paths: env.paths,
        session: emptySession(),
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(JSON.parse(readFileSync(env.paths.globalConfig, 'utf8')).system_prompt_append).toBeUndefined()

      const clear = await runGrammarCommand({
        args: 'ask clear',
        paths: env.paths,
        session: { ...emptySession(), thread: [{ q: 'q', a: 'a' }] },
        activeModel: env.sonnet,
        scopedModels: [],
        registry: env.registry,
      })
      expect(clear).toMatchObject({ kind: 'notify', clearAsk: true })

      expect(getGrammarCompletions('')?.map(c => c.value)).toContain('render')
      expect(getGrammarCompletions('render ')?.map(c => c.value)).toEqual(['entry', 'widget', 'both', 'off'])
      expect(getGrammarCompletions('ask memory ')?.map(c => c.value)).toEqual(['on', 'off'])
      expect(getGrammarCompletions('config sys')?.map(c => c.value)).toEqual([
        'system_prompt_append',
        'system_prompt_append_reviewer',
      ])
      expect(getGrammarCompletions('model ', ['anthropic/claude-haiku-4-5'])?.map(c => c.value)).toEqual([
        'auto',
        'off',
        'anthropic/claude-haiku-4-5',
      ])
    } finally {
      env.cleanup()
    }
  })
})
