// Model selection, auth verification, cost estimation, and Pi streamSimple wrapper.
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'

const SMALL_MODEL_NAME = /(?:haiku|mini|flash|lite|nano|small|turbo)/i
const EST_INPUT_TOKENS = 600
const EST_OUTPUT_TOKENS = 120

/** Structural subset of Pi's `Model` for provider selection and testing. */
export type ModelLike = {
  id: string
  name?: string
  api: string
  provider: string
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  cost: { input: number; output: number }
  contextWindow: number
}

/** Structural subset of Pi's `ModelRegistry` for testability and decoupling. */
export type ModelRegistryLike<M extends ModelLike = Model<any>> = {
  getAvailable(): M[]
  find(provider: string, modelId: string): M | undefined
  hasConfiguredAuth(model: M): boolean
  getProviderAuth(provider: string): Promise<unknown>
  streamSimple(model: M, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> }
}

export type ScopedModelLike<M extends ModelLike = Model<any>> = {
  model: M
}

export type ResolvedModel<M extends ModelLike = Model<any>> =
  | { kind: 'off' }
  | { kind: 'ready'; model: M; source: 'auto' | 'session' | 'explicit'; spec: string }
  | { kind: 'missing'; spec: string; error: string }

export type AuthCheckResult = { ok: true } | { ok: false; warning: string }

export type CostEstimate = {
  perCheckUsd: number
  per50Usd: number
  text: string
}

export type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string; aborted: boolean }

/** Parse `<provider>/<modelId>` splitting on the first `/` only (OpenRouter, Groq, etc. keep `/` inside modelId). */
export const parseExplicitModelId = (spec: string): { provider: string; modelId: string } | undefined => {
  const trimmed = spec.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined
  }
  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  }
}

const costSum = (m: ModelLike): number => (m.cost?.input ?? 0) + (m.cost?.output ?? 0)

/** Pick the cheapest physical text model on the active provider when strictly cheaper than `activeModel`. */
export const pickAutoModel = <M extends ModelLike>(
  activeModel: M | undefined,
  available: readonly M[],
  scopedModels: readonly ScopedModelLike<M>[] = [],
): M | undefined => {
  if (!activeModel) {
    return undefined
  }
  const pool = scopedModels.length > 0 ? scopedModels.map(s => s.model) : available
  const candidates = pool.filter(
    m =>
      m.provider === activeModel.provider &&
      m.api !== 'pi-virtual' &&
      m.input.includes('text') &&
      m.contextWindow >= 8000,
  )
  if (candidates.length === 0) {
    return activeModel
  }
  const sorted = [...candidates].sort((a, b) => {
    const costDiff = costSum(a) - costSum(b)
    if (costDiff !== 0) {
      return costDiff
    }
    const reasonDiff = Number(a.reasoning) - Number(b.reasoning)
    if (reasonDiff !== 0) {
      return reasonDiff
    }
    const aSmall = SMALL_MODEL_NAME.test(`${a.id} ${a.name ?? ''}`)
    const bSmall = SMALL_MODEL_NAME.test(`${b.id} ${b.name ?? ''}`)
    if (aSmall !== bSmall) {
      return Number(bSmall) - Number(aSmall)
    }
    return a.id.localeCompare(b.id)
  })
  const best = sorted[0]
  if (!best) {
    return activeModel
  }
  return costSum(best) < costSum(activeModel) ? best : activeModel
}

/** Resolve the model used for prompt grammar checks (`"off"`, `"auto"`, or `"<provider>/<modelId>"`). */
export const resolveCheckModel = <M extends ModelLike>(
  modelSetting: string,
  params: { activeModel: M | undefined; registry: ModelRegistryLike<M>; scopedModels?: readonly ScopedModelLike<M>[] },
): ResolvedModel<M> => {
  const spec = modelSetting.trim() || 'auto'
  const lower = spec.toLowerCase()
  if (lower === 'off') {
    return { kind: 'off' }
  }
  if (lower === 'auto') {
    if (!params.activeModel) {
      return { kind: 'missing', spec: 'auto', error: 'no active model selected' }
    }
    const picked = pickAutoModel(params.activeModel, params.registry.getAvailable(), params.scopedModels ?? []) ?? params.activeModel
    const sameAsActive = picked.provider === params.activeModel.provider && picked.id === params.activeModel.id
    return {
      kind: 'ready',
      model: picked,
      source: sameAsActive ? 'session' : 'auto',
      spec: `${picked.provider}/${picked.id}`,
    }
  }
  const parsed = parseExplicitModelId(spec)
  if (!parsed) {
    return { kind: 'missing', spec, error: `invalid model "${spec}" (expected provider/modelId, auto, or off)` }
  }
  const found = params.registry.find(parsed.provider, parsed.modelId)
  if (!found) {
    return { kind: 'missing', spec, error: `model "${spec}" not found in registry` }
  }
  return {
    kind: 'ready',
    model: found,
    source: 'explicit',
    spec: `${found.provider}/${found.id}`,
  }
}

/** Resolve the model used for `/grammar review` and `/grammar ask` (uses `ctx.model` when `auto`/`off`, else explicit). */
export const resolveCoachingModel = <M extends ModelLike>(
  modelSetting: string,
  params: { activeModel: M | undefined; registry: ModelRegistryLike<M>; scopedModels?: readonly ScopedModelLike<M>[] },
): ResolvedModel<M> => {
  const lower = modelSetting.trim().toLowerCase()
  if (lower === '' || lower === 'auto' || lower === 'off') {
    if (params.activeModel) {
      return {
        kind: 'ready',
        model: params.activeModel,
        source: 'session',
        spec: `${params.activeModel.provider}/${params.activeModel.id}`,
      }
    }
    return resolveCheckModel('auto', params)
  }
  return resolveCheckModel(modelSetting, params)
}

/** Check whether an explicit or resolved model has configured or runtime-resolvable auth. */
export const checkModelAuth = async <M extends ModelLike>(
  registry: Pick<ModelRegistryLike<M>, 'hasConfiguredAuth' | 'getProviderAuth'>,
  model: M,
): Promise<AuthCheckResult> => {
  if (registry.hasConfiguredAuth(model)) {
    return { ok: true }
  }
  try {
    const auth = await registry.getProviderAuth(model.provider)
    if (auth !== undefined) {
      return { ok: true }
    }
    return { ok: false, warning: `no configured auth for provider "${model.provider}"` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, warning: `auth check failed for "${model.provider}": ${message}` }
  }
}

const formatUsd = (usd: number): string => {
  if (usd < 0.0001) {
    return '<$0.0001'
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`
  }
  return `$${usd.toFixed(2)}`
}

/** Estimate USD cost per check (~600 input + ~120 output tokens) and per 50 prompts. */
export const estimateCost = (model: Pick<ModelLike, 'cost'>): CostEstimate => {
  const perCheckUsd = (EST_INPUT_TOKENS * (model.cost?.input ?? 0) + EST_OUTPUT_TOKENS * (model.cost?.output ?? 0)) / 1_000_000
  const per50Usd = perCheckUsd * 50
  const text = perCheckUsd === 0 ? '$0 (local/free)' : `~${formatUsd(perCheckUsd)}/check · ~${formatUsd(per50Usd)}/50 prompts`
  return { perCheckUsd, per50Usd, text }
}

/** Run a single model completion via Pi's `streamSimple` with reasoning omitted and an explicit AbortController timeout. */
export const runModelCall = async <M extends ModelLike>(
  registry: Pick<ModelRegistryLike<M>, 'streamSimple'>,
  model: M,
  systemPrompt: string,
  userText: string,
  options: { maxTokens: number; timeoutMs: number; signal?: AbortSignal },
): Promise<ModelCallResult> => {
  if (options.signal?.aborted) {
    return { ok: false, error: 'aborted', aborted: true }
  }
  const ac = new AbortController()
  let timedOut = false
  let callerAborted = false

  const onExternalAbort = () => {
    callerAborted = true
    ac.abort()
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, options.timeoutMs)

  try {
    const context: Context = {
      systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }],
    }
    const stream = registry.streamSimple(model, context, {
      maxTokens: options.maxTokens,
      signal: ac.signal,
    })
    const msg = await stream.result()
    if (timedOut) {
      return { ok: false, error: `timed out after ${Math.round(options.timeoutMs / 1000)}s`, aborted: false }
    }
    if (msg.stopReason === 'error') {
      return { ok: false, error: msg.errorMessage || 'provider error', aborted: false }
    }
    if (msg.stopReason === 'aborted') {
      return {
        ok: false,
        error: msg.errorMessage || 'aborted',
        aborted: callerAborted || !timedOut,
      }
    }
    const text = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('')
    return { ok: true, text }
  } catch (err) {
    if (timedOut) {
      return { ok: false, error: `timed out after ${Math.round(options.timeoutMs / 1000)}s`, aborted: false }
    }
    if (callerAborted || ac.signal.aborted) {
      return { ok: false, error: 'aborted', aborted: true }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), aborted: false }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}
