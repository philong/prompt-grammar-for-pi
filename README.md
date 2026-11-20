# prompt-grammar-for-pi

A [Pi](https://pi.dev) extension (tested on Pi **1.6.0+**) that proofreads each prompt you send, displays grammar fixes directly under the prompt in the transcript or above the editor, and keeps your mistake history for `/grammar stats`, `/grammar review`, and `/grammar ask`.

Ported from [prompt-grammar-for-claude](https://github.com/philong/prompt-grammar-for-claude) and [prompt-grammar-for-agy](https://github.com/philong/prompt-grammar-for-agy) (originally [jaklimoff/claude-grammar](https://github.com/jaklimoff/claude-grammar), MIT).

> **Note:** Like any Pi extension, `prompt-grammar-for-pi` runs inside the Pi process with your user permissions.

## Install

```bash
pi install git:github.com/philong/prompt-grammar-for-pi
```

Or run directly from a local checkout:

```bash
pi -e ./index.ts
```

Or copy into `~/.pi/agent/extensions/prompt-grammar/` for auto-discovery and `/reload` support (ships raw TypeScript loaded via Pi's `jiti` runtime — no build step and zero runtime npm dependencies).

## How model selection works

- **`auto` (default):** Picks the cheapest non-reasoning physical text model (`contextWindow >= 8000`, excluding virtual router models) on your active provider when strictly cheaper than `ctx.model`, otherwise keeps `ctx.model` (so `$0` local Ollama/llama.cpp models stay loaded in VRAM). Reasoning is omitted (off) on check calls.
- **`<provider>/<modelId>`:** Uses any model registered in Pi or `~/.pi/agent/models.json` (for example `anthropic/claude-haiku-4-5`, `openrouter/moonshotai/kimi-k2.7-code`, or `ollama/qwen2.5:7b`).
- **`off`:** Disables automatic prompt checking.

For local or OpenAI-compatible servers (Ollama, llama.cpp, LM Studio, OpenRouter), configure your provider in `~/.pi/agent/models.json` and run `/grammar model <provider>/<modelId>`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b", "reasoning": false }]
    }
  }
}
```

`/grammar review` and `/grammar ask` use `model_reviewer` when configured (`auto` to follow `ctx.model`, or an explicit `<provider>/<modelId>`); otherwise they use `ctx.model` when `model` is `auto`, or your explicit `model` setting.

## Commands

| Command | What it does |
|---|---|
| `/grammar help` | Show status, active model, estimated cost per check/50 prompts, and command list. |
| `/grammar`, `/grammar on\|off` | Toggle or set prompt checking (`on` also resumes after 3 failures in a row). |
| `/grammar natural [on\|off]` | Toggle the native-speaker rewrite line (`↳ ...`). |
| `/grammar render [entry\|widget\|both\|off]` | Choose where fixes appear (transcript entry under prompt, editor widget, both, or off). |
| `/grammar hide` | Hide the widget above the editor (`ctrl+alt+g` shortcut does the same). |
| `/grammar model [auto\|off\|<provider>/<id>]` | Inspect available models or set the check model. |
| `/grammar ignore [add\|rm <words>]` | Show or update words/phrases never flagged (comma-separated for phrases). |
| `/grammar stats [period] [language]` | Mistakes by kind, trend, and repeated fixes (zero model calls). |
| `/grammar review [period] [language]` | Summary card + 3–5 habits from kept fixes (starts at 20 fixes). |
| `/grammar ask [period] <question>` | Ask anything about your writing using kept + recent fixes. |
| `/grammar ask list\|clear\|memory [on\|off]` | Inspect, clear, or toggle per-session ask memory (last 5 asks/reviews). |
| `/grammar history [on\|off\|clear]` | Switch history recording or empty `~/.pi/agent/grammar-history.json`. |
| `/grammar config [key] [value]` | View or update settings in `~/.pi/agent/grammar.json`. |

Periods accept `7d`, `30d`, or `since YYYY-MM-DD` (UTC days).

## Settings

Stored in `~/.pi/agent/grammar.json` (`0600` on POSIX) and optionally overridden per trusted project in `<cwd>/.pi/grammar.json` (except `model`, `model_reviewer`, `system_prompt_append`, and `system_prompt_append_reviewer`, which project configs cannot override):

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable or disable prompt checking. |
| `natural` | `true` | Include native-speaker phrasing rewrites when clearly unidiomatic. |
| `language` | `English` | Language name (`French`, `German`), comma-separated list, or `auto`. |
| `dialect` | `any` | English spelling dialect: `any`, `us`, or `uk`. |
| `min_words` | `2` | Minimum words required to trigger a check. |
| `max_chars` | `6000` | Maximum characters checked per prompt. |
| `show_why` | `true` | Include short reason after each fix. |
| `history` | `true` | Keep fixes in `~/.pi/agent/grammar-history.json` (90 days, up to 2000 fixes). |
| `clean` | `true` | Show `✓ no mistakes · N in a row` starting at 3 clean prompts. |
| `ask_memory` | `true` | Remember last 5 asks/reviews on the session branch. |
| `render` | `entry` | `entry`, `widget`, `both`, or `off`. |
| `model` | `auto` | `auto`, `off`, or `<provider>/<modelId>`. |
| `model_reviewer` | `(inherit)` | Override model for `/grammar review` and `/grammar ask`: `auto` (active session model) or `<provider>/<modelId>`. Cannot be set in `.pi/grammar.json`. |
| `system_prompt_append` | `""` | Text appended to the system prompt on prompt checks, and inherited by `/grammar review` and `/grammar ask` unless `system_prompt_append_reviewer` is set (e.g. `<\|think_off\|>` for Gemma 4). Cannot be set in `.pi/grammar.json`. |
| `system_prompt_append_reviewer` | `(inherit)` | Override appended to the system prompt on `/grammar review` and `/grammar ask` (e.g. `<\|think_on\|>`, or `""` to append nothing). Cannot be set in `.pi/grammar.json`. |
| `timeout_ms` | `30000` | Timeout (ms) for live prompt checks. |

For example, to use a local model for checks while keeping `/grammar review` and `/grammar ask` on your active session model (and toggling thinking tags separately):

```text
/grammar config model ollama/gemma4:e4b
/grammar config model_reviewer auto
/grammar config system_prompt_append <|think_off|>
/grammar config system_prompt_append_reviewer <|think_on|>
```

## Ignore and skip lists

Add `ignore`, `skip`, and `"history": false` in `~/.pi/agent/grammar.json` or a trusted project's `.pi/grammar.json`:

```json
{
  "ignore": ["kubectl", "pnpm", "pull request", "/^[A-Z]+-\\d+$/"],
  "skip": ["^(ok|yes|continue|go on)\\b", "^deploy "],
  "history": false
}
```

## Migration from Claude Code or Antigravity

On first start, if `~/.pi/agent/grammar-history.json` or `~/.pi/agent/grammar.json` is missing, the extension copies history and compatible settings once from `~/.claude/` (`$CLAUDE_CONFIG_DIR`) or `~/.gemini/config/` without altering existing source files. If Antigravity had legacy `endpoint*` settings configured, it prints a ready-to-paste `models.json` snippet.

## Backfill past Pi sessions

```bash
npx jiti tools/import-pi.ts --dry-run
npx jiti tools/import-pi.ts --days 30
```

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
