# Changelog

## [0.1.0] - 2026-11-20

- Initial Pi extension port (`prompt-grammar-for-pi`, tested on Pi 1.6.0+).
- Prompt checking via `ctx.modelRegistry.streamSimple` with `auto` cheapest-of-provider model selection, explicit `<provider>/<modelId>`, or `off`.
- Prompt-anchored `grammar-check` custom entries rendered below the checked prompt (or via editor widget / `both` / `off`), plus RPC plain-text fallback and print/json mode guards.
- Full `/grammar` subcommands (`help`, `on/off`, `natural`, `render`, `hide`, `model`, `ignore`, `stats`, `review`, `ask`, `history`, `config`) with autocomplete and `ctrl+alt+g` shortcut.
- Branch-rebuilt session state (`streak`, `fails`, `recentFixes`, ask memory) with append-only reset sentinels (`grammar-state`, `grammar-ask-turn`).
- One-time migration from Claude Code and Antigravity configs/history, plus `tools/import-pi.ts` session backfill tool.
