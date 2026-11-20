import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'

type ExtensionMode = ExtensionContext['mode']

import { createGrammarExtension, matchesPromptText } from '../index'
import { readHistoryFile } from '../state'

const makeModel = (provider: string, id: string, inputCost = 1): Model<any> => ({
  id,
  name: id,
  api: 'anthropic-messages',
  provider,
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: inputCost, output: inputCost * 4, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
})

const assistantMsg = (model: Model<any>, text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: model.api,
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
  stopReason,
  timestamp: Date.now(),
})

const flushTicks = () => new Promise<void>(resolve => setTimeout(resolve, 15))

type FakeHarness = {
  agentDir: string
  branch: SessionEntry[]
  entriesAppended: Array<{ customType: string; data: unknown; afterIndex: number }>
  widgets: Array<{ key: string; content: unknown }>
  notifications: Array<{ message: string; type?: string }>
  commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>
  shortcuts: Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>
  emit: (event: string, payload: unknown) => Promise<unknown>
  persistUserMessage: (text: string, ts: number) => string
  ctx: ExtensionContext
  cmdCtx: ExtensionCommandContext
  setMode: (mode: ExtensionMode) => void
  setPendingMessages: (v: boolean) => void
  cleanup: () => void
}

const createHarness = (opts: {
  mode?: ExtensionMode
  shutdownWaitMs?: number
  onStream?: (promptText: string, signal?: AbortSignal) => Promise<AssistantMessage>
} = {}): FakeHarness => {
  const agentDir = mkdtempSync(join(tmpdir(), 'prompt-grammar-ext-'))
  const sonnet = makeModel('anthropic', 'claude-sonnet-4-5', 3)
  const haiku = makeModel('anthropic', 'claude-haiku-4-5', 0.8)
  const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>()
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>()
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>()
  const branch: SessionEntry[] = []
  const entriesAppended: Array<{ customType: string; data: unknown; afterIndex: number }> = []
  const widgets: Array<{ key: string; content: unknown }> = []
  const notifications: Array<{ message: string; type?: string }> = []
  let mode: ExtensionMode = opts.mode ?? 'tui'
  let pendingMessages = false
  let runtimeStale = false
  let idSeq = 0

  const fakeTheme = {
    fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
    bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
    bold: (t: string) => t,
    italic: (t: string) => t,
    strikethrough: (t: string) => `<s>${t}</s>`,
  }

  const ctx = {
    get mode() {
      return mode
    },
    get hasUI() {
      return mode === 'tui' || mode === 'rpc'
    },
    cwd: agentDir,
    model: sonnet,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => pendingMessages,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => '',
    sessionManager: {
      getBranch: () => [...branch],
      getEntries: () => [...branch],
      getLeafId: () => branch[branch.length - 1]?.id ?? null,
    },
    modelRegistry: {
      getAvailable: () => [sonnet, haiku],
      find: (p: string, id: string) => [sonnet, haiku].find(m => m.provider === p && m.id === id),
      hasConfiguredAuth: () => true,
      getProviderAuth: async () => ({ auth: { apiKey: 'k' } }),
      streamSimple: (model: Model<any>, context: any, streamOpts: any) => ({
        result: () => {
          const msg = context.messages[0]
          const txt = Array.isArray(msg?.content) ? msg.content.map((p: any) => p.text ?? '').join('') : ''
          return opts.onStream
            ? opts.onStream(txt, streamOpts?.signal)
            : Promise.resolve(assistantMsg(model, '{"english":true,"fixes":[]}'))
        },
      }),
    },
    ui: {
      theme: fakeTheme,
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
    },
  } as unknown as ExtensionContext

  const api = {
    on: (event: string, fn: (ev: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerShortcut: (key: string, def: any) => shortcuts.set(key, def),
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: unknown) => {
      if (runtimeStale) {
        throw new Error('This extension ctx is stale after session replacement or reload')
      }
      const id = `c-${++idSeq}`
      branch.push({
        type: 'custom',
        customType,
        data,
        id,
        parentId: branch[branch.length - 1]?.id ?? null,
        timestamp: new Date().toISOString(),
      })
      entriesAppended.push({ customType, data, afterIndex: branch.length - 1 })
    },
  } as unknown as ExtensionAPI

  createGrammarExtension({ agentDir, homeDir: join(agentDir, 'isolated-home'), env: {}, shutdownWaitMs: opts.shutdownWaitMs ?? 50 })(api)

  const emit = async (event: string, payload: unknown) => {
    if (event === 'session_start') {
      runtimeStale = false
    }
    let last: unknown
    for (const fn of handlers.get(event) ?? []) {
      last = await fn(payload, ctx)
    }
    if (event === 'session_shutdown') {
      runtimeStale = true
    }
    return last
  }

  const persistUserMessage = (text: string, timestamp: number) => {
    const id = `u-${++idSeq}`
    branch.push({
      type: 'message',
      id,
      parentId: branch[branch.length - 1]?.id ?? null,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }], timestamp },
    })
    return id
  }

  return {
    agentDir,
    branch,
    entriesAppended,
    widgets,
    notifications,
    commands,
    shortcuts,
    emit,
    persistUserMessage,
    ctx,
    cmdCtx: ctx as unknown as ExtensionCommandContext,
    setMode: m => {
      mode = m
    },
    setPendingMessages: v => {
      pendingMessages = v
    },
    cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
  }
}

describe('extension', () => {
  test('matchesPromptText covers exact prompts and image-resize hints with trailing whitespace', () => {
    expect(matchesPromptText('fix the bug', 'fix the bug')).toBe(true)
    expect(matchesPromptText('fix the bug', 'fix the bug  \n\n[Image 1 resized to 1024x768]')).toBe(true)
    expect(matchesPromptText('fix the bug', 'fix the bug extra')).toBe(false)
  })

  test('anchor appends after persisted prompt for both idle and queued prompts, never mis-attaching on steer overtaking followUp', async () => {
    const h = createHarness({
      onStream: async text => {
        const fixes = text.includes('follow')
          ? [{ from: 'follow up', to: 'follow-up', why: 'spelling', kind: 'spelling' }]
          : [{ from: 'stear', to: 'steer', why: 'typo', kind: 'spelling' }]
        return assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), JSON.stringify({ english: true, fixes }))
      },
    })
    try {
      await h.emit('session_start', { type: 'session_start', reason: 'startup' })

      // 1. Follow-up queued while streaming, then a steer prompt overtakes it.
      await h.emit('input', { type: 'input', text: 'please check follow up later', source: 'interactive', streamingBehavior: 'followUp' })
      await h.emit('input', { type: 'input', text: 'stear now please', source: 'interactive', streamingBehavior: 'steer' })
      await flushTicks()

      // Before user message_end + persistence, NO entry should be appended yet.
      expect(h.entriesAppended.length).toBe(0)

      // Steer delivers first, plus an unrelated extension sendUserMessage & skipped prompt!
      const extTs = 1000
      await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: 'from extension', timestamp: extTs } })
      h.persistUserMessage('from extension', extTs)

      const steerTs = 2000
      await h.emit('message_end', {
        type: 'message_end',
        message: { role: 'user', content: 'stear now please \n\n[Image resized]', timestamp: steerTs },
      })
      h.persistUserMessage('stear now please \n\n[Image resized]', steerTs)
      await flushTicks()

      const followTs = 3000
      await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: 'please check follow up later', timestamp: followTs } })
      h.persistUserMessage('please check follow up later', followTs)
      await flushTicks()

      expect(h.entriesAppended.length).toBe(2)
      const idxSteerUser = h.branch.findIndex(e => e.type === 'message' && e.message.timestamp === steerTs)
      const idxSteerCheck = h.branch.findIndex(e => e.type === 'custom' && (e.data as any).text === 'stear now please')
      const idxFollowUser = h.branch.findIndex(e => e.type === 'message' && e.message.timestamp === followTs)
      const idxFollowCheck = h.branch.findIndex(
        e => e.type === 'custom' && (e.data as any).text === 'please check follow up later',
      )

      expect(idxSteerCheck).toBeGreaterThan(idxSteerUser)
      expect(idxSteerCheck).toBeLessThan(idxFollowUser)
      expect(idxFollowCheck).toBeGreaterThan(idxFollowUser)
    } finally {
      h.cleanup()
    }
  })

  test('gate skips extension source, short prompts, slash commands, and skip regexes', async () => {
    let calls = 0
    const h = createHarness({
      onStream: async () => {
        calls += 1
        return assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), '{"english":true,"fixes":[]}')
      },
    })
    try {
      mkdirSync(h.agentDir, { recursive: true })
      writeFileSync(join(h.agentDir, 'grammar.json'), JSON.stringify({ skip: ['^deploy '] }))
      await h.emit('session_start', { type: 'session_start', reason: 'startup' })

      await h.emit('input', { type: 'input', text: 'i want know it', source: 'extension' })
      await h.emit('input', { type: 'input', text: 'ok', source: 'interactive' })
      await h.emit('input', { type: 'input', text: '/model', source: 'interactive' })
      await h.emit('input', { type: 'input', text: 'deploy staging now', source: 'interactive' })
      await flushTicks()

      expect(calls).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  test('branch switch skips entry while keeping history; shutdown does not abort on reload and caps quit at shutdownWaitMs', async () => {
    let releaseCheck!: () => void
    let aborted = false
    const h = createHarness({
      shutdownWaitMs: 30,
      onStream: (_txt, signal) =>
        new Promise(resolve => {
          signal?.addEventListener('abort', () => {
            aborted = true
            resolve(assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), '', 'aborted'))
          })
          releaseCheck = () =>
            resolve(
              assistantMsg(
                makeModel('anthropic', 'claude-haiku-4-5'),
                '{"english":true,"fixes":[{"from":"appea","to":"appear","why":"typo","kind":"spelling"}]}',
              ),
            )
        }),
    })
    try {
      await h.emit('session_start', { type: 'session_start', reason: 'startup' })
      await h.emit('input', { type: 'input', text: 'this should appea here', source: 'interactive' })
      await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: 'this should appea here', timestamp: 100 } })
      h.persistUserMessage('this should appea here', 100)
      await flushTicks()

      // Switch branch before check finishes.
      h.branch.length = 0
      await h.emit('session_tree', { type: 'session_tree', newLeafId: null, oldLeafId: 'u-1' })

      releaseCheck()
      await flushTicks()

      // Entry skipped, but history file updated!
      expect(h.entriesAppended.length).toBe(0)
      expect(aborted).toBe(false)
      expect(readHistoryFile(join(h.agentDir, 'grammar-history.json')).fixes.length).toBe(1)

      // Reload shutdown lets pending check finish without stale-runtime throw.
      await h.emit('input', { type: 'input', text: 'this should appea again', source: 'interactive' })
      await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' })
      releaseCheck()
      await flushTicks()
      expect(aborted).toBe(false)
      expect(readHistoryFile(join(h.agentDir, 'grammar-history.json')).fixes.length).toBe(2)

      // Quit shutdown waits up to cap (30ms) then aborts stuck check.
      await h.emit('session_start', { type: 'session_start', reason: 'reload' })
      await h.emit('input', { type: 'input', text: 'this will hang forever', source: 'interactive' })
      await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' })
      expect(aborted).toBe(true)

      // Quit shutdown skips the wait when history is off.
      aborted = false
      writeFileSync(join(h.agentDir, 'grammar.json'), JSON.stringify({ history: false }))
      await h.emit('session_start', { type: 'session_start', reason: 'reload' })
      await h.emit('input', { type: 'input', text: 'no wait when history is off', source: 'interactive' })
      await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' })
      expect(aborted).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('3 failures pause checks, /grammar on resets via sentinel, skipped checks reset fails, and streak threshold controls display', async () => {
    let mode: 'error' | 'skipped' | 'clean' = 'error'
    const h = createHarness({
      onStream: async () => {
        if (mode === 'error') {
          return assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), '', 'error')
        }
        if (mode === 'skipped') {
          return assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), '{"english":false,"fixes":[]}')
        }
        return assistantMsg(makeModel('anthropic', 'claude-haiku-4-5'), '{"english":true,"fixes":[]}')
      },
    })
    try {
      await h.emit('session_start', { type: 'session_start', reason: 'startup' })

      const sendPrompt = async (text: string, ts: number) => {
        await h.emit('input', { type: 'input', text, source: 'interactive' })
        await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: text, timestamp: ts } })
        h.persistUserMessage(text, ts)
        await flushTicks()
      }

      await sendPrompt('first error prompt', 1)
      await sendPrompt('second error prompt', 2)
      mode = 'skipped'
      await sendPrompt('bonjour tout le monde', 3)
      // Skipped check appends hidden entry and resets fails to 0!
      expect((h.entriesAppended[2]?.data as any).status).toBe('skipped')
      expect((h.entriesAppended[2]?.data as any).display).toBe(false)

      // Now 3 consecutive errors pause checking.
      mode = 'error'
      await sendPrompt('error one two', 4)
      await sendPrompt('error two three', 5)
      await sendPrompt('error three four', 6)
      expect((h.entriesAppended[5]?.data as any).paused).toBe(true)

      const beforePause = h.entriesAppended.length
      await sendPrompt('should be ignored while paused', 7)
      expect(h.entriesAppended.length).toBe(beforePause)

      // /grammar on appends grammar-state reset sentinel and resumes across branch rebuild.
      await h.commands.get('grammar')?.handler('on', h.cmdCtx)
      expect(h.entriesAppended[h.entriesAppended.length - 1]?.customType).toBe('grammar-state')

      await h.emit('session_start', { type: 'session_start', reason: 'reload' })
      mode = 'clean'
      await sendPrompt('clean prompt one', 8)
      await sendPrompt('clean prompt two', 9)
      await sendPrompt('clean prompt three', 10)

      const lastThree = h.entriesAppended.slice(-3).map(e => e.data as any)
      expect(lastThree[0].display).toBe(false)
      expect(lastThree[1].display).toBe(false)
      expect(lastThree[2].display).toBe(true)
      expect(lastThree[2].streak).toBe(3)
    } finally {
      h.cleanup()
    }
  })

  test('mode guards: rpc emits plain-text widget & report notify; print/json emit zero UI/entries while writing history; shortcut clears widget', async () => {
    const h = createHarness({
      mode: 'rpc',
      onStream: async () =>
        assistantMsg(
          makeModel('anthropic', 'claude-haiku-4-5'),
          '{"english":true,"fixes":[{"from":"appea","to":"appear","why":"typo","kind":"spelling"}]}',
        ),
    })
    try {
      await h.emit('session_start', { type: 'session_start', reason: 'startup' })
      await h.emit('input', { type: 'input', text: 'this should appea here', source: 'interactive' })
      await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: 'this should appea here', timestamp: 1 } })
      h.persistUserMessage('this should appea here', 1)
      await flushTicks()

      // RPC sets plain-text widget without ANSI escape codes even when render is "entry".
      const w = h.widgets[h.widgets.length - 1]
      expect(Array.isArray(w?.content)).toBe(true)
      expect(JSON.stringify(w?.content)).not.toContain('\x1b')

      // Shortcut clears widget.
      await h.shortcuts.get('ctrl+alt+g')?.handler(h.ctx)
      expect(h.widgets[h.widgets.length - 1]?.content).toBeUndefined()

      // RPC report commands notify plain text.
      await h.commands.get('grammar')?.handler('stats', h.cmdCtx)
      expect(h.notifications.length).toBeGreaterThan(0)

      // Print mode produces zero entries, widgets, or notifications, and still writes history on quit.
      h.setMode('print')
      const beforeEntries = h.entriesAppended.length
      const beforeWidgets = h.widgets.length
      const beforeNotifs = h.notifications.length
      await h.emit('input', { type: 'input', text: 'another appea prompt', source: 'interactive' })
      await h.emit('message_end', { type: 'message_end', message: { role: 'user', content: 'another appea prompt', timestamp: 2 } })
      h.persistUserMessage('another appea prompt', 2)
      await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' })

      expect(h.entriesAppended.length).toBe(beforeEntries)
      expect(h.widgets.length).toBe(beforeWidgets)
      expect(h.notifications.length).toBe(beforeNotifs)
      expect(existsSync(join(h.agentDir, 'grammar-history.json'))).toBe(true)
      expect(readHistoryFile(join(h.agentDir, 'grammar-history.json')).fixes.length).toBe(2)
    } finally {
      h.cleanup()
    }
  })

  test('migration banner shows once in TUI and is suppressed in print mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-ext-mig-'))
    try {
      const home = join(tmp, 'home')
      const agentDir = join(home, '.pi', 'agent')
      const agyCfgDir = join(home, '.gemini', 'config')
      mkdirSync(agentDir, { recursive: true })
      mkdirSync(agyCfgDir, { recursive: true })
      writeFileSync(
        join(agyCfgDir, 'grammar.json'),
        JSON.stringify({ endpoint: 'http://localhost:11434', endpoint_model: 'qwen2.5:7b', display: 'reply' }),
      )

      const runSession = async (mode: ExtensionMode) => {
        const notifications: string[] = []
        const entries: unknown[] = []
        const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>()
        const api = {
          on: (ev: string, fn: any) => {
            const l = handlers.get(ev) ?? []
            l.push(fn)
            handlers.set(ev, l)
            return () => {}
          },
          registerCommand: () => {},
          registerShortcut: () => {},
          registerEntryRenderer: () => {},
          appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
        } as unknown as ExtensionAPI
        createGrammarExtension({ agentDir, homeDir: home, env: {} })(api)
        const ctx = {
          mode,
          hasUI: mode === 'tui' || mode === 'rpc',
          cwd: tmp,
          model: undefined,
          scopedModels: [],
          isProjectTrusted: () => true,
          hasPendingMessages: () => false,
          sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => null },
          modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false, getProviderAuth: async () => undefined, streamSimple: () => ({}) },
          ui: { notify: (m: string) => notifications.push(m), setWidget: () => {} },
        } as unknown as ExtensionContext
        for (const fn of handlers.get('session_start') ?? []) {
          await fn({ type: 'session_start', reason: 'startup' }, ctx)
        }
        return { notifications, entries }
      }

      // Print mode suppresses migration banner & report entry while migrating file once.
      const printOut = await runSession('print')
      expect(printOut.notifications.length).toBe(0)
      expect(printOut.entries.length).toBe(0)

      // Fresh agentDir in TUI emits one-line notify + endpoint report entry.
      rmSync(join(agentDir, 'grammar.json'), { force: true })
      const tuiOut = await runSession('tui')
      expect(tuiOut.notifications.length).toBe(1)
      expect(tuiOut.notifications[0]).toContain('Migrated grammar settings')
      expect(tuiOut.entries.length).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
