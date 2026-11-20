import { describe, expect, test } from 'vitest'
import type { AssistantMessage, Context, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'

import {
  appendSystemPrompt,
  checkModelAuth,
  estimateCost,
  parseExplicitModelId,
  pickAutoModel,
  resolveCheckModel,
  resolveCoachingModel,
  runModelCall,
} from '../model'
import type { ModelLike, ModelRegistryLike } from '../model'

const makeModel = (overrides: Partial<ModelLike> = {}): ModelLike => ({
  id: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 3, output: 15 },
  contextWindow: 200_000,
  ...overrides,
})

const makeMsg = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: '{"english":true,"fixes":[]}' }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
  ...overrides,
})

const makeRegistry = (models: ModelLike[], opts: {
  configuredAuth?: (m: ModelLike) => boolean
  providerAuth?: (p: string) => Promise<unknown>
  onStream?: (model: ModelLike, context: Context, options?: ModelsSimpleStreamOptions) => Promise<AssistantMessage>
} = {}): ModelRegistryLike<ModelLike> => ({
  getAvailable: () => models,
  find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
  hasConfiguredAuth: opts.configuredAuth ?? (() => true),
  getProviderAuth: opts.providerAuth ?? (async () => ({ auth: { apiKey: 'k' } })),
  streamSimple: (model, context, options) => ({
    result: () => (opts.onStream ? opts.onStream(model, context, options) : Promise.resolve(makeMsg())),
  }),
})

describe('model', () => {
  test('parseExplicitModelId splits on the first slash only', () => {
    expect(parseExplicitModelId('anthropic/claude-haiku-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
    })
    expect(parseExplicitModelId('openrouter/moonshotai/kimi-k2.7-code')).toEqual({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.7-code',
    })
    expect(parseExplicitModelId('noslash')).toBeUndefined()
    expect(parseExplicitModelId('/missing-provider')).toBeUndefined()
    expect(parseExplicitModelId('missing-model/')).toBeUndefined()
  })

  test('pickAutoModel picks cheapest physical non-reasoning small text model, honours scopedModels, and preserves $0 ties', () => {
    const active = makeModel({ id: 'claude-sonnet-4-5', cost: { input: 3, output: 15 }, reasoning: true })
    const virtualRouter = makeModel({
      id: 'cheap-router',
      api: 'pi-virtual',
      cost: { input: 0, output: 0 },
      contextWindow: 128_000,
    })
    const tinyCtx = makeModel({ id: 'tiny-haiku', cost: { input: 0.1, output: 0.2 }, contextWindow: 4000 })
    const imageOnly = makeModel({ id: 'img-only', cost: { input: 0.1, output: 0.2 }, input: ['image'] })
    const otherProvider = makeModel({ provider: 'openai', id: 'gpt-4.1-nano', cost: { input: 0.1, output: 0.4 } })
    const tieReasoning = makeModel({ id: 'claude-reason', cost: { input: 0.8, output: 4 }, reasoning: true })
    const tiePlain = makeModel({ id: 'claude-plain', cost: { input: 0.8, output: 4 }, reasoning: false })
    const haiku = makeModel({ id: 'claude-haiku-4-5', cost: { input: 0.8, output: 4 }, reasoning: false })

    const picked = pickAutoModel(active, [virtualRouter, tinyCtx, imageOnly, otherProvider, tieReasoning, tiePlain, haiku])
    expect(picked?.id).toBe('claude-haiku-4-5')

    // Scoped models constrain candidates.
    const scoped = pickAutoModel(active, [haiku, tiePlain], [{ model: tiePlain }, { model: active }])
    expect(scoped?.id).toBe('claude-plain')

    // $0 ties keep activeModel so local Ollama/llama.cpp models are not evicted from VRAM.
    const localActive = makeModel({ provider: 'ollama', id: 'qwen2.5:14b', cost: { input: 0, output: 0 } })
    const localMini = makeModel({ provider: 'ollama', id: 'qwen2.5-mini:3b', cost: { input: 0, output: 0 } })
    expect(pickAutoModel(localActive, [localMini, localActive])?.id).toBe('qwen2.5:14b')
  })

  test('resolveCheckModel and resolveCoachingModel handle off, auto, and nested explicit ids', () => {
    const active = makeModel({ id: 'claude-sonnet-4-5', cost: { input: 3, output: 15 } })
    const haiku = makeModel({ id: 'claude-haiku-4-5', cost: { input: 0.8, output: 4 } })
    const orModel = makeModel({ provider: 'openrouter', id: 'moonshotai/kimi-k2.7-code', cost: { input: 0.5, output: 1.5 } })
    const registry = makeRegistry([active, haiku, orModel])

    expect(resolveCheckModel('off', { activeModel: active, registry })).toEqual({ kind: 'off' })

    const autoCheck = resolveCheckModel('auto', { activeModel: active, registry })
    expect(autoCheck.kind).toBe('ready')
    if (autoCheck.kind === 'ready') {
      expect(autoCheck.model.id).toBe('claude-haiku-4-5')
      expect(autoCheck.source).toBe('auto')
    }

    const autoCoach = resolveCoachingModel('auto', { activeModel: active, registry })
    expect(autoCoach.kind).toBe('ready')
    if (autoCoach.kind === 'ready') {
      expect(autoCoach.model.id).toBe('claude-sonnet-4-5')
      expect(autoCoach.source).toBe('session')
    }

    const explicit = resolveCheckModel('openrouter/moonshotai/kimi-k2.7-code', { activeModel: active, registry })
    expect(explicit.kind).toBe('ready')
    if (explicit.kind === 'ready') {
      expect(explicit.spec).toBe('openrouter/moonshotai/kimi-k2.7-code')
      expect(explicit.source).toBe('explicit')
    }
  })

  test('checkModelAuth falls back to getProviderAuth and catches thrown errors', async () => {
    const m = makeModel({ provider: 'custom' })

    expect(await checkModelAuth(makeRegistry([m], { configuredAuth: () => true }), m)).toEqual({ ok: true })
    expect(
      await checkModelAuth(
        makeRegistry([m], { configuredAuth: () => false, providerAuth: async () => ({ auth: { apiKey: 'ok' } }) }),
        m,
      ),
    ).toEqual({ ok: true })

    const missing = await checkModelAuth(
      makeRegistry([m], { configuredAuth: () => false, providerAuth: async () => undefined }),
      m,
    )
    expect(missing.ok).toBe(false)

    const threw = await checkModelAuth(
      makeRegistry([m], {
        configuredAuth: () => false,
        providerAuth: async () => {
          throw new Error('missing $CUSTOM_KEY')
        },
      }),
      m,
    )
    expect(threw).toEqual({ ok: false, warning: 'auth check failed for "custom": missing $CUSTOM_KEY' })
  })

  test('estimateCost formats free and paid estimates', () => {
    expect(estimateCost(makeModel({ cost: { input: 0, output: 0 } })).text).toContain('$0')
    expect(estimateCost(makeModel({ cost: { input: 1, output: 5 } })).text).toContain('/check')
  })

  test('appendSystemPrompt leaves empty appends unchanged and adds trimmed suffix on a new line', () => {
    expect(appendSystemPrompt('base prompt', '')).toBe('base prompt')
    expect(appendSystemPrompt('base prompt', '   \n ')).toBe('base prompt')
    expect(appendSystemPrompt('base prompt', '  <|think_off|>  ')).toBe('base prompt\n<|think_off|>')
  })

  test('runModelCall omits reasoning, checks stopReason, and enforces AbortController timeout', async () => {
    const m = makeModel()
    let seenOptions: ModelsSimpleStreamOptions | undefined
    const reg = makeRegistry([m], {
      onStream: async (_model, _ctx, options) => {
        seenOptions = options
        return makeMsg({ content: [{ type: 'text', text: '{"english":true,"fixes":[]}' }] })
      },
    })
    const okRes = await runModelCall(reg, m, 'sys', 'user prompt', { maxTokens: 512, timeoutMs: 5000 })
    expect(okRes).toEqual({ ok: true, text: '{"english":true,"fixes":[]}' })
    expect(seenOptions?.reasoning).toBeUndefined()
    expect('reasoning' in (seenOptions ?? {})).toBe(false)

    const errReg = makeRegistry([m], {
      onStream: async () => makeMsg({ stopReason: 'error', errorMessage: '429 rate limit' }),
    })
    expect(await runModelCall(errReg, m, 'sys', 'u', { maxTokens: 100, timeoutMs: 5000 })).toEqual({
      ok: false,
      error: '429 rate limit',
      aborted: false,
    })

    const abortReg = makeRegistry([m], {
      onStream: async () => makeMsg({ stopReason: 'aborted' }),
    })
    expect(await runModelCall(abortReg, m, 'sys', 'u', { maxTokens: 100, timeoutMs: 5000 })).toEqual({
      ok: false,
      error: 'aborted',
      aborted: true,
    })

    const timeoutReg = makeRegistry([m], {
      onStream: (_model, _ctx, options) =>
        new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => {
            resolve(makeMsg({ stopReason: 'aborted' }))
          })
        }),
    })
    const timed = await runModelCall(timeoutReg, m, 'sys', 'u', { maxTokens: 100, timeoutMs: 25 })
    expect(timed.ok).toBe(false)
    if (!timed.ok) {
      expect(timed.aborted).toBe(false)
      expect(timed.error).toContain('timed out')
    }
  })
})
