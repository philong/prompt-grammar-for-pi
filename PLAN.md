# Plan: prompt-grammar for Pi

Port of [prompt-grammar](https://github.com/philong/prompt-grammar-for-claude) (Claude Code mod, v2.x) to a
[Pi](https://pi.dev) extension. This repo is empty: it holds no code yet, and it has no remote.

Reads against:

| Source | Path | Used for |
|---|---|---|
| Pi source, v1.6.0 (`25190b72c`) | `../pi` | Every Pi API fact below. Line numbers are from this checkout. |
| Pi docs | `../pi/packages/coding-agent/docs/` | extensions.md, session-format.md, models.md |
| Installed runtime | `pi` 1.6.0 (`mise`) | The version to test against first |
| Upstream mod | `../prompt-grammar-for-claude` | Feature behaviour, the check prompt, history format |
| Reference port | `../prompt-grammar-for-agy` | The already-decoupled core to copy from |

This file replaces `../prompt-grammar-for-claude/docs/port-to-pi.md`. That plan holds four assumptions that
the Pi source contradicts. They are corrected in [Where the earlier plan was wrong](#where-the-earlier-plan-was-wrong).

## Goal

After each prompt, a cheap model checks its language. The fixes show in the transcript under that prompt.
Fixes are kept, so `/grammar stats`, `/grammar review` and `/grammar ask` work as they do in the other builds.

## Non-goals

- Claude Code parity, and Claude model aliases (`haiku`, `sonnet`).
- Cowork, the desktop app, the statusline band that Antigravity has.
- A build step. Pi loads TypeScript extensions through jiti; this repo ships source.

## Copy from the agy port, not from the Claude mod

The Antigravity port already split host-free core from host glue. Its `src/*.ts` files import only `node:*`
and each other. The Claude mod's `hooks/*.tsx` import the mod API everywhere. So `src/` is the base.

| agy file | Lines | Action |
|---|---|---|
| `src/types.ts` | 47 | Copy. Drop `AgyHookInput` / `AgyHookOutput`, add `GrammarEntry` and `ReportEntry`. |
| `src/check.ts` | 207 | Copy. `SYSTEM` prompt, `typedPart`, `parseReply`, `parseBatch`, `keepFixes`. No host import. |
| `src/history.ts` | 531 | Copy. Record, merge, parse, stats, periods, trends, review and ask prompt builders. |
| `src/config.ts` | 376 | Copy, then edit: new `Settings` (see [Settings](#settings)), paths from `getAgentDir()`. Keep the language, ignore, skip, `cut`, `wordCount` helpers unchanged. |
| `src/commands.ts` | 510 | Copy the sub-command tree and its text. Swap `providers`/`state`/`statusline` calls for the Pi ones, and return report data instead of a markdown string. |
| `src/format.ts` | 173 | Copy `plainFixes` and `cleanText` wording. `markdownFixes` is dropped; styled lines live in `render.ts`. |
| `src/state.ts` | 223 | Partial. The history file and atomic writes stay. Session state (fails, streak, recent fixes, ask thread) moves to Pi session entries. |
| `src/transcript.ts`, `src/runner.ts` | 262 | Read for the flow. Rewrite as `index.ts`. |
| `src/providers.ts`, `src/endpoint.ts` | 193 | Drop. Pi's model registry and `models.json` replace both. |
| `src/statusline.ts`, `src/hook-handler.ts`, `scripts/*` | 697 | Drop. No host hook contract and no CLI band here. |

Each copied file starts with a provenance header:

```ts
// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied <date>.
// Fix the logic upstream and re-copy; edit here only for Pi plumbing.
```

## Pi facts this design rests on

All checked in `../pi`. Cited as `file:line`.

**Prompt capture.** `pi.on("input", …)` sees typed, RPC and `sendUserMessage` prompts, before skill and
template expansion. Extension commands run before it, so `/grammar …` never reaches it
(`core/agent-session.ts:2177-2211`, `_preparePrompt` at `:2217-2247`). Return `{ action: "continue" }`.
`sendUserMessage` arrives with `source: "extension"` (`:2571-2576`), which the gate skips so programmatic
prompts from other extensions are not proofread.

**`input` fires before the prompt is persisted, sometimes long before.** After the input handlers, `_preparePrompt`
still expands templates, validates model and auth, and then either starts the run or, when the agent is
streaming, queues the prompt as steer or follow-up (`:2242`). A queued prompt's user message is persisted only
when the queue delivers it, which can be after the whole current reply. So "the leaf at check time" is not the
prompt by default.

**Where an entry lands.** `pi.appendEntry` writes a `custom` entry with `parentId = leafId`
of the session that is current at call time (`core/session-manager.ts:1307-1319`) and emits `entry_appended`; interactive mode renders it through
`addCustomEntryToChat` (`modes/interactive/interactive-mode.ts:3635-3638`). That method **inserts the
component before the streaming component** when the agent is mid-run (`:4052-4071`). So an appended entry
shows after the last persisted message, not at the end of the screen.

**Extension `message_end` runs before the message is persisted.** `_emitExtensionEvent(event)` awaits every
extension's `message_end` handler before calling `sessionManager.appendMessage`
(`core/agent-session.ts:1212-1237`). An entry appended in a user `message_end` handler becomes the
prompt's parent — it renders **above** the prompt — and an async handler in another extension can delay
`appendMessage` past a blind `setTimeout(0)`. Also, because `addCustomEntryToChat` splices before
`this.streamingComponent` (`interactive-mode.ts:4063-4068`) and the assistant message is persisted only at
assistant `message_end`, a check only needs to beat the first assistant `message_end`, not first token, to
render directly under the prompt.

**Session lifecycle and stale runtimes.** `/new`, `/resume`, `/fork`, and `/reload` replace the
`AgentSession`, emit `session_shutdown`, and call `runtime.invalidate()`
(`core/agent-session-runtime.ts:186-243`, `core/extensions/loader.ts:200-207`). There is no `session_switch`
event; `session_start` fires with `reason: "startup" | "reload" | "new" | "resume" | "fork"`. Calling
`pi.appendEntry()` on a stale runtime throws via `assertActive()` (`loader.ts:405-408`). `teardownCurrent`
awaits the `session_shutdown` handlers before it disposes the session (`agent-session-runtime.ts:186-196`), so
a handler can wait for in-flight work.

**Entries are cheap and invisible to the model.** A `custom` entry never enters LLM context
(`docs/session-format.md`, CustomEntry). With no renderer for its `customType`, or when the renderer returns
`undefined`, it renders nothing, not even a blank line (`interactive-mode.ts:4053-4061`). Sidecar data costs one JSONL line.

**Entry renderers are called once, then cached.** `CustomEntryComponent` builds the child in its
constructor and rebuilds only on `invalidate()`, `setExpanded`, `setOutputPad`
(`modes/interactive/components/custom-entry.ts:19-69`). `invalidate()` runs on theme and width changes. It
adds a `Spacer(1)` above the renderer's component, and only when the renderer returned one (`:63-68`).

**But the tree is re-rendered every frame.** `Container.render` calls `renderChildLines(children, width, …)`,
which calls `child.render(width)` on every child each frame (`packages/tui/src/tui.ts:393-413, 447-468`),
and the screen writer diffs lines (`packages/tui/src/tui-main-screen.ts:250+`). A component that computes
its lines inside `render()` therefore updates live.

**Nothing in `ExtensionUIContext` asks for a frame directly** (`core/extensions/types.ts:164ff`).
`setStatus`, `setWidget` and `notify` all end in `ui.requestRender()`
(`interactive-mode.ts:2500-2503, 2598-2638, 3129-3136 → 4030-4050`). A string-array widget is capped at 10 lines
(`MAX_WIDGET_LINES`, `:2686`); a component factory is not.

**Markdown transformers are not live.** They run when a row is built: new message, restored session,
width change (`docs/extensions.md`, `pi.registerMarkdownTransformer`). `messageId` is defined only for
restored rows. A live user row is not re-transformed when extension state changes.

**Models.** `ctx.modelRegistry` is a `ModelRegistry` class with `getAvailable()`, `find(provider, id)`,
`hasConfiguredAuth(model)`, `streamSimple(model, context, opts)`, `complete(...)`,
`getApiKeyAndHeaders(model)`, `getProviderAuth(provider)` (`core/model-registry.ts:48-196`). `find()` does
not check credentials (`hasConfiguredAuth(model)` does, `:72-87`). `hasConfiguredAuth` only reads a cached
snapshot of configured providers (`core/model-runtime.ts:552-554`); Pi itself falls back to an async auth
check when it is false (`agent-session.ts:2262-2264`), so a false result alone does not mean "no auth". `completeSimple` exists on the runtime,
not on the registry, so the port calls `streamSimple` and collects the result; `streamSimple(…).result()`
resolves (rather than rejects) with `stopReason: "error" | "aborted"` on provider errors or aborts. `Model`
carries `cost`, `contextWindow`, `input`, `reasoning`. OpenAI-compatible servers (Ollama, llama.cpp, LM
Studio, OpenRouter) are configured in `~/.pi/agent/models.json`
(`docs/models.md#configure-a-compatible-endpoint`, `docs/models-configuration.md`).

**Reasoning is off when `reasoning` is omitted.** `SimpleStreamOptions.reasoning` is a `ThinkingLevel`:
`minimal | low | medium | high | xhigh | max` (`ai/src/providers/model-schema.ts:16`). `"off"` exists only in
`MODEL_THINKING_LEVELS` and the agent's own level, so `reasoning: "off"` fails `tsc`. Providers test
`!options?.reasoning` (e.g. `ai/src/api/bedrock-converse-stream.ts:591`).

**`ctx.signal` is the agent's run signal** (`getSignal: () => this.agent.signal`, `agent-session.ts:3612`). At
`input` time no run has started, so it is `undefined`. It cannot bound a check started there.

**Config is read-only from the extension.** `pi.getSettings()` returns a copy
(`core/agent-session.ts:3595`). Writable settings must live in our own file.
`getAgentDir()` and `CONFIG_DIR_NAME` are exported from the package index (`index.ts:7-8`).

**Modes.** `ctx.mode` is `tui | rpc | json | print`; `ctx.hasUI` is false in print and json
(`docs/extensions.md`, Mode Behavior). Renderers are TUI-only.

**Theme.** `theme.fg("error" | "success" | "muted" | "accent", s)`, `theme.strikethrough`, `theme.dim`
(`modes/interactive/theme/theme.ts:330`), `Box` and `Text` from `@earendil-works/pi-tui`.

## Where the earlier plan was wrong

1. **Anchor.** It appended the entry at the user `message_end`. That puts the line above the prompt
   (see the ordering fact above). "Append as soon as the check is ready" is not enough either: a queued
   prompt, or a fast local model, returns before the prompt is persisted, and the line lands above it.
   Decision: see [Anchor](#anchor). Start the check at `input`, append only when **both** the result is back
   **and** the prompt is persisted, and let the leaf decide position from there. Both live and restored
   views agree, because both follow the tree.
2. **Placeholder then update.** Possible, not needed. It needs a component that reads live state in
   `render()`, plus a forced frame through `setStatus` or `setWidget`. Appending on result needs neither,
   and it survives `/reload`, restart, and branch navigation with no reconstruction.
3. **`✓` before the prompt through a markdown transformer.** Not live, so a clean prompt would show nothing
   until a resize. Decision: the clean note stays in the entry line —
   `✓ no mistakes · N in a row` — rendered only from `N ≥ 3` (matching agy's `STREAK_FROM`). Clean prompts
   still append `grammar-check` (so branch rebuild preserves `streak`), but with `display: false` for streaks
   1–2 or when `clean` is false; the renderer returns `undefined` for those, so `CustomEntryComponent` adds no
   component and no `Spacer(1)`. The transformer is not used.
4. **A bespoke OpenAI client.** Dropped. Pi already speaks OpenAI-compatible endpoints through
   `models.json`. The port reads a model from the registry instead of fetching, which removes the client,
   the three `endpoint_*` settings, and the per-server quirks retry.

## Design

### Model path

`model` setting: `"off"` | `"auto"` (default) | `"<provider>/<modelId>"`.

- `"auto"`: pick the cheapest text model of the active provider from `ctx.modelRegistry.getAvailable()`
  (filter `input` includes `"text"`, `contextWindow ≥ 8000`; honour `ctx.scopedModels` when non-empty by
  unwrapping each `ScopedModel`'s `.model`; sort primarily by `cost.input + cost.output` ascending since
  `reasoning` is omitted, tie-breaking by non-reasoning first then a small-name match
  `haiku|mini|flash|lite|nano|small|turbo`). Use the candidate only when strictly cheaper (`<`) than
  `ctx.model`, else keep `ctx.model` (on `$0` ties this intentionally keeps `ctx.model` so local
  Ollama/llama.cpp servers don't swap models out of VRAM).
- `"<provider>/<modelId>"`: split on the **first** `/` only (`indexOf("/")`), because providers such as
  OpenRouter, Groq, and Fireworks include `/` inside `modelId` (e.g., `openrouter/moonshotai/kimi-k2.7-code`);
  call `ctx.modelRegistry.find()`, then check `ctx.modelRegistry.hasConfiguredAuth(model)`, and when that is
  false, `await ctx.modelRegistry.getProviderAuth(model.provider)` (the snapshot can miss auth that resolves
  at request time); warn in `/grammar model` and `/grammar help` only when both find no auth, instead of
  failing 3 checks. `/grammar model`
  lists what the registry offers.
- `"off"`: no checks, no calls.
- Coaching commands (`/grammar review`, `/grammar ask`): use `ctx.model` when `model` is `"auto"` (falling
  back to the check model), or the explicit `<provider>/<modelId>` when configured.
- Always call with `reasoning` omitted (reasoning off, see the facts above), a token cap, and a timeout
  from our own `AbortController` (`ctx.signal` is `undefined` at `input` time and is not used). Inspect
  `msg.stopReason` (`"error" | "aborted"`) on the resolved `AssistantMessage` and extract `type === "text"`
  parts from `msg.content`.
- Resolve at `session_start` and re-resolve on `pi.on("model_select")`. `model_select` does not fire on
  session restore, so the start call is required.
- `/grammar help` prints the model, where it came from, and an estimated cost per check and per 50 prompts.

### Anchor

One pending record per checked prompt, matched by prompt text (FIFO only among identical duplicate prompts):

1. `input`: skip `e.source === "extension"` and non-checkable prompts (short, `/…`, `skip`). Start the check
   with a per-check `AbortController` and push a pending record carrying the trimmed raw prompt text.
2. User `message_end`: extract text from `event.message` (`msgText`) and match the oldest unmatched pending
   record whose `rawText` equals `msgText.trim()` or prefixes it (`msgText.trim().startsWith(rawText + "\n")`,
   covering Pi's appended image-resize hints). Ignore user messages that match no pending record (skipped
   prompts, `sendUserMessage`, etc.) so skipped prompts, `steer` overtaking `followUp`, or another extension
   handling `input` never mis-attach fixes. Resolve `promptEntryId` by searching the tail of
   `ctx.sessionManager.getBranch()` for the persisted `user` message whose
   `message.timestamp === event.message.timestamp` (retrying on next tick / `message_start` if another
   extension's async `message_end` delayed persistence), rather than blindly reading `getLeafId()`.
3. When both the result and `promptEntryId` are present: if `!disposed` and `promptEntryId` is on
   `getBranch()`, `appendEntry("grammar-check", …)`. Otherwise skip the entry; the history record is still
   kept.
4. `session_shutdown`: set `disposed = true` and clear pending records and timers, so a stale runtime never
   calls `appendEntry` or `ctx.ui.*`. Do **not** abort in-flight checks: let each one finish (its own timeout
   still bounds it) and write its history record, which is a plain file write that needs no live runtime.
   Aborting would lose the last prompt's fixes on every `/new`, `/resume`, `/fork`, and `/reload`. In print
   and json modes the run often ends before the check returns, so the handler awaits pending checks, capped
   at 2 s, before the process disposes the runtime; after the cap it aborts them. In TUI on `reason: "quit"`,
   the same 2 s cap applies so quitting never hangs on a slow model.
5. A prompt that never persists (input handled by another extension, run aborted before the save) drops its
   pending record at `agent_end` or after the timeout, whichever comes later.

Result: the line is never above its prompt. It is directly under the prompt when the check beats the first
assistant `message_end`; otherwise it comes after the last persisted message at append time.

### Where fixes show

`render` setting: `"entry"` (default) | `"widget"` | `"both"` | `"off"`.

- In TUI and RPC modes, every checked prompt appends a `custom` entry (`customType: "grammar-check"`)
  carrying the full result plus `display: boolean`. This includes a check the model answered but that is
  skipped (null reply, unsupported language): agy resets `fails` on those (`src/runner.ts:108-113`), so they
  append with `display: false` and `status: "skipped"`, or branch rebuild would keep a stale `fails` count.
  `display` is true when `(render === "entry" || render === "both")` and
  either the check is non-clean (fixes, natural rewrite, or error) or `settings.clean && streak >= 3`. The TUI
  renderer draws struck-through source in `error`, the fix in `success`, the reason in `muted`, and the
  native-speaker line below when `display` is true, and returns `undefined` when false (cleanly skipped by
  `CustomEntryComponent.hasContent()`). Keeping the entry even when hidden preserves branch state across
  render modes without retroactively revealing old checks if `render` changes later.
- `widget` / `both`: the newest result above the editor, through `ctx.ui.setWidget("grammar", lines)`.
- In RPC mode: `grammar-check` and `grammar-report` emit `entry_appended` data (entry renderers are
  TUI-only); `widget` / `both` (and the RPC fallback when `entry` is set) use string-array `setWidget` with
  `linesOf(..., { styled: ctx.mode === "tui" })` so RPC widgets send plain text without ANSI escape sequences,
  and report commands also surface plain text via `ctx.ui.notify`.
- In print and json modes: no entry, no widget, no notify, no migration banner. History recording still runs
  for prompts, because `session_shutdown` waits up to 2 s for pending checks (see [Anchor](#anchor) step 4);
  interactive `/grammar` commands are TUI/RPC-only.

`/grammar hide` clears the widget; `pi.registerShortcut("ctrl+alt+g", …)` does the same.

### Session state

Follows the pattern in `docs/extensions.md` (State Management): rebuild from `ctx.sessionManager.getBranch()`
at `session_start` (covering `startup`, `reload`, `new`, `resume`, `fork`) and `session_tree`.

- Each check appends `grammar-check` (skipped ones too, with `status: "skipped"`), so branch rebuild restores
  `streak`, `fails`, `lastError`, and `recentFixes` (last 20 fixes, used by `/grammar ask`) without in-memory
  drift. Replay rules follow agy `src/runner.ts`: done → `fails = 0`, `lastError` cleared, streak +1 when clean
  else 0; skipped → `fails = 0`, `lastError` cleared, streak unchanged; error → `fails + 1`, `lastError` set,
  streak unchanged.
- Append-only reset sentinels keep cleared state from returning on `/reload` or `/tree`: `/grammar on`
  appends an invisible `grammar-state` entry (`{ failsReset: true }`) so 3 earlier errors no longer re-pause;
  `/grammar ask clear` and `/grammar ask memory off` append a tombstone (`grammar-ask-turn`,
  `{ cleared: true }`) so cleared exchanges stay forgotten.
- Ask memory (last 5 asks and reviews) is appended as `customType: "grammar-ask-turn"`, which has no
  renderer and so stays invisible. `ask_memory: false` stops writing them.
- A `grammar-report` entry (`customType: "grammar-report"`) carries the output of `help`, `stats`, `review`,
  `ask`, `ignore`, and `config`, rendered as a block in the transcript (and surfaced via `notify` in RPC
  mode). It stays out of model context and stays in scrollback, which `notify` cannot do. One-line
  confirmations (`on`, `off`, `ignore add`) use `notify`.

### Settings

File store, because `pi.getSettings()` cannot write:

- `~/.pi/agent/grammar.json` (user, through `getAgentDir()`), then `<cwd>/.pi/grammar.json` over it, read
  only when `ctx.isProjectTrusted()`. Project config cannot override `model` (matching agy's `endpoint*`
  guard), preventing a repo from silently redirecting checks to an expensive model or different provider.
  Same merge rule and same `ignore`, `skip`, `"history": false` keys.
- Keys kept from agy: `enabled`, `natural`, `language`, `dialect`, `min_words`, `max_chars`, `show_why`,
  `history`, `clean`, `ask_memory`.
- Changed: `display` → `render` (`entry|widget|both|off`); `endpoint*` → `model`; `timeout_ms` kept.
- Dropped: `statusline`, `auto`, `user_markdown`, `cowork`, `desktop`, `icons` (Pi draws in any terminal;
  keep `icons` only if a plain-glyph mode proves needed).
- History file: `~/.pi/agent/grammar-history.json`, same format as the other builds. It is this build's own
  file, seeded once from the Claude build's file (step 8), not shared with it: two hosts writing one file would
  lose updates, since atomic writes stop torn files but not lost updates.

## Layout

```
prompt-grammar-for-pi/
  index.ts                ~260  extension factory: events, gate, wiring, modes. No logic.
  render.ts               ~200  linesOf() + entry renderer + widget adapter
  commands.ts             ~520  /grammar sub-commands       <- agy src/commands.ts
  check.ts                ~210  prompt, reply parsing       <- agy src/check.ts
  history.ts              ~530  keep, stats, review, ask    <- agy src/history.ts
  config.ts               ~380  settings, lists, paths      <- agy src/config.ts (edited)
  model.ts                ~110  model resolution, cost estimate   new
  state.ts                ~150  history file, atomic write  <- agy src/state.ts (trimmed)
  types.ts                 ~60  shared types                <- agy src/types.ts
  tests/*.test.ts             vitest
tools/sync-from-agy.sh        sync copied core files from upstream agy
tools/import-pi.ts        ~120  optional: backfill from Pi sessions
README.md PRIVACY.md SECURITY.md LICENSE CHANGELOG.md .github/workflows/test.yml
```

No npm runtime dependencies. `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are
devDependencies for types only, and must not appear in `dependencies`
(`docs/packages.md`, docs/extensions.md imports table).

## Steps

| Step | Work | Done when |
|---|---|---|
| 0 | Copy the agy core (`types`, `check`, `history`, `format` wording, `config`), add the header, port the agy tests from `bun:test` to vitest (import swap). | `history` + `check` + `config` tests pass under vitest in this repo, no Pi import. |
| 1 | Placement spike, one file, no real call. Append `grammar-check` from four places: at `input`, at user `message_end`, 2 s after `input`, and through the [Anchor](#anchor) rule. Run each for an idle prompt and for a prompt queued while the agent streams. Also run `/tree`, `/new`, and `/reload` while a 5 s fake check is pending. | Confirms in a live `pi` session: (a) the first two land above the prompt, (b) the 2 s one lands above a queued prompt, (c) the anchor rule lands under the prompt in both cases, (d) a branch switch skips the entry and `/new` or `/reload` aborts without a stale-runtime throw, (e) after a restart every line comes back in the same place. |
| 2 | `model.ts`: `off` / `auto` / explicit id, cheapest-of-provider pick, `hasConfiguredAuth` check on explicit ids, `reasoning` omitted, `stopReason` handling, cost estimate. | A fresh session with no config file checks prompts against a small model of the active provider. `/grammar help` names the model and the cost. |
| 3 | `index.ts` gate (skip `e.source === "extension"`) + call + `render.ts` entry route. | Ten typed prompts show correct lines under them in a live TUI session. Short prompts, `/commands`, and `skip`/`ignore` all pass through unchecked. |
| 4 | Commands: `help`, `on/off`, `natural`, `render`, `model`, `config`, `ignore`, `history`. `getArgumentCompletions` for sub-commands. Pause after 3 failures, `/grammar on` appends `grammar-state` reset sentinel and resumes. Verify `/reload` on installed `pi` 1.6.0. | Each switch writes `~/.pi/agent/grammar.json` and survives `/reload` on `pi` 1.6.0. |
| 5 | History keep + `stats` + `history` commands; rebuild streak, fails, `lastError`, and `recentFixes` from the branch; append `grammar-check` with `display: false` when `render` is `widget` or `off`. | On a copy of the Claude build's history file, `/grammar stats 30d` prints the same numbers as the Claude build. `/tree` and resume keep the lines and the streak right. |
| 6 | `review` and `ask` (on `ctx.model` when `model` is `auto`, else explicit model), ask memory + `grammar-ask-turn` clear tombstone, as `grammar-report` entries. | One call each, same prompt builders, same output shape as the other builds. |
| 7 | `widget` / `both` routes, `/grammar hide`, `ctrl+alt+g` shortcut, RPC mode path (string-array `setWidget` + `notify` for reports), print/json no-ops. | `/grammar render widget` shows the newest check above the editor; `--mode rpc` shows text, never a broken component. |
| 8 | Migration, once, when the Pi files are absent: from Claude Code (`$CLAUDE_CONFIG_DIR` or `~/.claude`), copy `grammar-history.json` as is and copy `ignore`, `skip`, `history` from `grammar.json`; from Antigravity (`~/.gemini/config/grammar.json`, if present and Pi's `grammar.json` is absent), translate `display` → `render`, keep shared keys, drop `statusline`, `auto`, `user_markdown`, and if `endpoint*` was set drop it and print a `models.json` snippet plus the `model` value to set. Keep `.bak`, print one line (skipped in print/json modes). | A machine with the Claude or Antigravity build installed starts with its history, lists, and settings after one run; an endpoint user sees the snippet. |
| 9 | Docs, sync script, and CI: README, PRIVACY, SECURITY, CHANGELOG, `tools/sync-from-agy.sh`, `tsc --noEmit`, tests in Actions. | `pi install git:…` then a fresh `pi` session works from the README alone. |
| 10 | Optional: `tools/import-pi.ts` over `~/.pi/agent/sessions/**/*.jsonl` (`docs/session-format.md`). Simpler than the Claude importer: prompts are structured entries. | A month of past Pi prompts fills the history, with `--dry-run` first. |

MVP: steps 0–5, about 2 days. Full parity with the other builds: 4 days.

## Tests

Runner: vitest (what the Pi repo uses, `packages/*/test`). No `claude plugin test` or hook-contract tests.

- Copy from agy almost as is: `parseReply`, `parseBatch`, `keepFixes`, `settingsFrom`, `languageOf`,
  `compileIgnore`, `compileSkip`, `cut`, `wordCount`, `parsePeriod`, `parseHistory`, `summaryOf`,
  `statsText`, `trendOf`.
- New: `linesOf()` as plain text with ANSI stripped, for wording and width cut.
- New: `tests/extension.test.ts` against a hand-written fake `ExtensionAPI` and `ctx` (~120 lines). It
  records `on`, `appendEntry`, `registerCommand`, `setWidget`, `notify`, and feeds back a fake branch.
  This is where the placement rule (idle prompt, queued prompt, skipped prompts, `steer` overtaking `followUp`, branch switch and `session_shutdown` mid-check), the gate, the pause-after-3-failures rule, and the mode guards are
  tested without a terminal.
- Manual check per release, in a real `pi` TUI: prompt → line under it → `/grammar render widget` →
  restart the session and check the lines come back.

## Packaging

```json
{
  "name": "prompt-grammar-for-pi",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "devDependencies": { "@earendil-works/pi-coding-agent": "…", "@earendil-works/pi-tui": "…", "vitest": "…", "typescript": "…" }
}
```

Install paths to document (`docs/packages.md`, docs/extensions.md):

```bash
pi install git:github.com/philong/prompt-grammar-for-pi   # published
# or, in-repo:
pi -e ./index.ts                                          # one run
# or: copy to ~/.pi/agent/extensions/prompt-grammar/      # auto-discovered, /reload works
```

README states the tested Pi version (1.6.0+) and that the extension
runs with the user's permissions.

## Privacy note to carry over

Every prompt's first `max_chars` characters go to the model that the session is configured for, or to the
model named by `model`. Nothing else is sent anywhere. Fixes are kept in `~/.pi/agent/grammar-history.json`.
No endpoint key is stored by this extension: an endpoint and its key live in `~/.pi/agent/models.json`,
which is Pi's own file. PRIVACY.md lists the Pi APIs used, as the Claude README does.

## Risks

| Risk | Effect | Handling |
|---|---|---|
| A slow check lands after the first assistant message | The line reads as part of the reply | Cap the check timeout under typical first assistant `message_end` time (checks beat placement as long as they finish before the first assistant turn completes); `/grammar help` says which model is in use; `render: "widget"` always shows the newest check in one place. |
| A local model answers in free prose | Checks fail | `check.ts` keeps `parseReply` recovery and `keepFixes`; README recommends models that follow the JSON shape. |
| `model: "auto"` picks an expensive or reasoning model | A session costs cents, not pennies | Cheapest-of-provider sort, `reasoning` omitted, cost line in help, `"off"` as an escape. |
| Pi's extension API moves | Breakage | Pin tested versions in README; a weekly CI job installs the latest `pi` and runs the fake-API tests. |
| Two entry routes | Extra code | One `linesOf`, thin adapters. |
| Two repos drift | Prompt tuning lands in one build only | Provenance headers and `tools/sync-from-agy.sh`, run after each upstream release. |

## Decisions

1. `render: "both"` always shows both entry and widget (predictable over fallback-only).
2. `model: "auto"` picks the cheapest provider model silently on first run and reports model + cost in
   `/grammar help`.
3. Ask memory stays per session via `grammar-ask-turn` branch entries, matching the other builds.
