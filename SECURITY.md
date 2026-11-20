# Security

`prompt-grammar-for-pi` runs inside the Pi process with your user permissions. [PRIVACY.md](PRIVACY.md) documents what it sends, keeps on disk, and calls in Pi.

## Trust boundaries

- **Untrusted repositories:** Project-local `.pi/grammar.json` is read only when `ctx.isProjectTrusted()` returns `true`.
- **Model override guard:** Even in trusted projects, `.pi/grammar.json` cannot override the global `model` setting, preventing a repository from redirecting prompt checks to another provider or expensive model.
- **File permissions & credentials:** `~/.pi/agent/grammar.json` is written atomically with `0600` permissions on POSIX. The extension never stores endpoint API keys — provider credentials stay in Pi's `~/.pi/agent/auth.json` or `~/.pi/agent/models.json`.
- **Terminal sanitization:** Model-supplied strings (`from`, `to`, `why`, `natural`, `error`) are stripped of ANSI escape sequences and control characters before rendering.

## Reporting a vulnerability

Report security issues privately via GitHub Security Advisories on `philong/prompt-grammar-for-pi` rather than opening a public issue.
