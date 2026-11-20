# Privacy

`prompt-grammar-for-pi` runs locally inside Pi. It has no server of its own and collects nothing for its author.

## What it sends

- Each typed prompt (its first `max_chars` characters, default `6000`) is sent only to your configured Pi check model (`ctx.model` or the model selected by `model`), through Pi's `ctx.modelRegistry.streamSimple(...)`.
- Prompts with `source === "extension"`, slash commands, prompts shorter than `min_words`, prompts without enough letters, and prompts matching your `skip` list are never sent.
- When `model` is `"off"` or `enabled` is `false`, no prompts are checked or sent.
- `/grammar review` sends grouped mistake pairs (never raw prompts) to your coaching model (`model_reviewer`, `ctx.model`, or `model`).
- `/grammar ask` sends your question, grouped mistake pairs, up to 10 recent session fixes, and (while `ask_memory` is on) up to 5 earlier ask/review exchanges to your coaching model (`model_reviewer`, `ctx.model`, or `model`).
- `tools/import-pi.ts`, only when run manually without `--dry-run`, batches past user prompts from `~/.pi/agent/sessions/**/*.jsonl` through Pi's `ModelRegistry` (`createAgentSessionServices`).

## What it keeps on disk

- **Settings & lists:** `~/.pi/agent/grammar.json` (global) and optional trusted `<cwd>/.pi/grammar.json` (project).
- **Mistake history:** `~/.pi/agent/grammar-history.json` — keeps at most 90 days and 2000 short fixes (`<= 60` chars, no code/paths, no raw prompts, no native rewrites).
- **Session branch entries:** `custom` entries (`grammar-check`, `grammar-state`, `grammar-ask-turn`, `grammar-report`) stored in Pi's session JSONL. `custom` entries never enter LLM context.
- Set `"history": false` in `.pi/grammar.json` to leave no history trace for a project, or run `/grammar history off` / `/grammar history clear`.

## Pi APIs used

- Events: `session_start`, `session_tree`, `session_shutdown`, `model_select`, `input`, `message_start`, `message_end`, `agent_start`, `agent_end`
- Actions & UI: `pi.appendEntry`, `pi.registerCommand`, `pi.registerShortcut`, `pi.registerEntryRenderer`, `ctx.ui.notify`, `ctx.ui.setWidget`, `ctx.isProjectTrusted`, `ctx.sessionManager.getBranch`, `ctx.modelRegistry` (`getAvailable`, `find`, `hasConfiguredAuth`, `getProviderAuth`, `streamSimple`), `getAgentDir`
