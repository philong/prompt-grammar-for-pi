// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied 2026-11-20.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
// The grammar check prompt, reply parsing, and fix filtering (ported from claude-grammar v1.7.0).
import type { GrammarFix, GrammarReply } from './types'
import { AUTO, ENGLISH, applyFixes, isIgnored, joinNames, languageOf, languagesOf } from './config'
import type { Dialect, Ignore } from './config'
import { KINDS, kindOf } from './history'

const MAX_PROMPT_WORDS = 100

const ENGLISH_BASE = `You proofread English that a non-native speaker typed as a prompt to a coding assistant.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase "i" or sentence start is fine), punctuation style, apostrophes left out of contractions (lets, dont, im, thats), a casual tone, slang and short forms (smth, pls, u, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`

const base = (language: string) => {
  const names = languagesOf(language)
  return `${
    names.length === 0
      ? 'You proofread a prompt typed to a coding assistant, in whatever language it is written in; the writer may not be a native speaker of it.'
      : names.length > 1
        ? `You proofread a prompt typed to a coding assistant in ${joinNames(names)}; the writer may not be a native speaker of it.`
        : `You proofread ${language} that a non-native speaker typed as a prompt to a coding assistant.`
  }
Check the text in its main language. Words from another language mixed in (English technical terms, say) are fine as they are.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order and the like), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase sentence start, or "i" in English, is fine), punctuation style, apostrophes left out of contractions (lets, dont, im), a casual tone, slang and chat short forms (smth, pls, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`
}

const DIALECT: Record<Dialect, string> = {
  any: 'Accept American and British spelling alike.',
  us: 'The writer uses American English: a British spelling (colour, organise) is a spelling mistake.',
  uk: 'The writer uses British English: an American spelling (color, organize) is a spelling mistake.',
}

const dialectRule = (language: string, dialect: Dialect) =>
  language === ENGLISH
    ? [DIALECT[dialect]]
    : language === AUTO || languagesOf(language).includes(ENGLISH)
      ? [`In English text: ${DIALECT[dialect]}`]
      : []

const KIND = `, "kind": "<one of: ${KINDS.join(', ')}>"`

const answer = (language: string, showWhy: boolean, kind: boolean) => {
  const fix = (why: string) =>
    `[{"from": "<exact words from the text>", "to": "<the fixed words>"${showWhy ? `, "why": "<2 to 4 words${why}>"` : ''}${kind ? KIND : ''}}]`
  if (language === ENGLISH) {
    return `Answer with JSON only, no prose and no code fence:
{"english": true, "fixes": ${fix('')}}
"fixes" is [] when the English is fine. If the text is not mainly English, answer {"english": false, "fixes": []}.`
  }
  const names = languagesOf(language)
  const named =
    names.length === 0
      ? '<its main language, named in English>'
      : names.length > 1
        ? `<its main language: ${joinNames(names)}>`
        : language
  const other =
    names.length === 0
      ? 'If the text holds no natural language (only code, say), answer {"language": null, "fixes": []}.'
      : `If the text is not mainly ${joinNames(names)}, answer {"language": null, "fixes": []}.`
  return `Answer with JSON only, no prose and no code fence:
{"language": "${named}", "fixes": ${fix(", in the text's language")}}
"fixes" is [] when the text is fine. ${other}`
}

const ENGLISH_KIND_RULE = `For "kind": article is a missing, extra or wrong a, an or the; missing word and extra word are for any other word.`
const KIND_RULE = `For "kind": article is a missing, extra or wrong article (a, an, the; le, la, un; der, die, das); missing word and extra word are for any other word; a wrong gender or case ending is agreement.`

const ENGLISH_NATURAL = `Also add "natural" to the JSON: null in most cases. Only when a native speaker would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`
const NATURAL = `Also add "natural" to the JSON: null in most cases. Only when a native speaker of the text's language would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it, in the same language: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`

export type PromptParts = {
  natural: boolean
  language?: string
  dialect?: Dialect
  showWhy?: boolean
  kind?: boolean
  ignore?: readonly string[]
}

/** The system prompt for proofreading one prompt (or a batch when combined with BATCH). */
export const system = ({ natural, language = ENGLISH, dialect = 'any', showWhy = true, kind = true, ignore = [] }: PromptParts) => {
  const words = ignore.slice(0, MAX_PROMPT_WORDS)
  const never =
    words.length > 0 ? [`Never flag these, the writer means them as written: ${words.map(w => JSON.stringify(w)).join(', ')}.`] : []
  const english = language === ENGLISH
  return [
    english ? ENGLISH_BASE : base(language),
    ...dialectRule(language, dialect),
    ...never,
    answer(language, showWhy, kind),
    ...(kind ? [english ? ENGLISH_KIND_RULE : KIND_RULE] : []),
    ...(natural ? [english ? ENGLISH_NATURAL : NATURAL] : []),
  ].join('\n')
}

const isFix = (x: unknown): x is GrammarFix => {
  const f = x as Record<string, unknown>
  return typeof f?.from === 'string' && typeof f.to === 'string'
}

/** Parse a model reply into fixes, optional natural rewrite, and language (or null if skipped language). */
export const parseReply = (text: string, fallback?: string): GrammarReply | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error('no JSON in the reply')
  }
  const reply = JSON.parse(text.slice(start, end + 1)) as {
    language?: unknown
    english?: unknown
    fixes?: unknown
    natural?: unknown
  }
  if (reply.language === null || reply.english === false) {
    return null
  }
  if (!Array.isArray(reply.fixes)) {
    throw new Error('no fixes in the reply')
  }
  const said = languageOf(reply.language)
  const language = said !== undefined && said !== AUTO ? said : reply.english === true ? ENGLISH : fallback
  if (language === undefined) {
    throw new Error('no language in the reply')
  }
  const fixes = reply.fixes
    .filter(isFix)
    .filter(f => f.from.trim() !== f.to.trim())
    .map(f => ({ from: f.from, to: f.to, why: typeof f.why === 'string' ? f.why : '', kind: kindOf(f.kind) }))
  const natural = typeof reply.natural === 'string' && reply.natural.trim() !== '' ? reply.natural.trim() : null
  return { fixes, natural, language }
}

/** The language a reply leaves out is the one set, when there is just one. */
export const fallbackFor = (setting: string) => (languagesOf(setting).length === 1 ? setting : undefined)

/** Keep only fixes whose `from` actually appears in the prompt and is not ignored. */
export const keepFixes = (fixes: readonly GrammarFix[], text: string, ignore: Ignore) => {
  const lower = text.toLowerCase()
  return fixes.filter(f => f.from.trim() !== '' && lower.includes(f.from.toLowerCase()) && !isIgnored(ignore, f.from))
}

const same = (a: string, b: string) => {
  const plain = (s: string) => s.trim().toLowerCase().replace(/[.!?]+$/, '')
  return plain(a) === plain(b)
}

/** The natural rewrite, unless it repeats the prompt/fixed prompt or drops an ignored word. */
export const usefulNatural = (
  natural: string | null,
  text: string,
  fixes: readonly GrammarFix[],
  ignore: Ignore = { words: [], matchers: [] },
) => {
  if (natural === null || same(natural, text) || same(natural, applyFixes(text, fixes))) {
    return null
  }
  const lower = natural.toLowerCase()
  const dropsKept = ignore.words.some(w => text.toLowerCase().includes(w.toLowerCase()) && !lower.includes(w.toLowerCase()))
  return dropsKept ? null : natural
}

const ANSWERS = /(^|\n\n)Answers? to your question/
const USER_REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/

/** Extract the user-typed portion of a prompt (unwrapping Antigravity `<USER_REQUEST>` tags if present). */
export const typedPart = (text: string) => {
  const wrapped = USER_REQUEST.exec(text)
  const inner = wrapped !== null ? (wrapped[1] ?? '') : text
  const m = ANSWERS.exec(inner)
  return (m === null ? inner : inner.slice(0, m.index)).trim()
}

export const BATCH = `This time the message holds several texts, as a JSON array of {"id": <number>, "text": "..."}. Check each text on its own, as if it were the only one.
Answer with a JSON array only, no prose and no code fence: one object per text, in the shape above plus its "id", like [{"id": 1, "language": "French", "fixes": []}].`

export const parseBatch = (text: string, fallback?: string): Map<number, GrammarReply | null> => {
  const open = text.indexOf('[')
  const brace = text.indexOf('{')
  const lone = brace >= 0 && (open < 0 || brace < open)
  const [start, end] = lone ? [brace, text.lastIndexOf('}')] : [open, text.lastIndexOf(']')]
  if (start < 0 || end < start) {
    throw new Error('no JSON in the reply')
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
  const items = lone ? [parsed] : parsed
  if (!Array.isArray(items)) {
    throw new Error('not a JSON array')
  }
  const out = new Map<number, GrammarReply | null>()
  for (const item of items) {
    const id = (item as { id?: unknown })?.id
    if (typeof id !== 'number') {
      continue
    }
    try {
      out.set(id, parseReply(JSON.stringify(item), fallback))
    } catch {
      // Unusable item skipped; rest stand.
    }
  }
  return out
}
