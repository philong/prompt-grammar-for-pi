#!/usr/bin/env bash
set -euo pipefail

UPSTREAM="${1:-../prompt-grammar-for-agy}"
DEST="$(cd "$(dirname "$0")/.." && pwd)"
TODAY="$(date -I)"

if [[ ! -d "$UPSTREAM/src" ]]; then
  echo "Upstream repo not found at: $UPSTREAM" >&2
  exit 1
fi

copy_with_header() {
  local src="$UPSTREAM/src/$1"
  local dst="$DEST/$1"
  {
    echo "// From prompt-grammar-for-agy (github.com/philong/prompt-grammar-for-agy), copied $TODAY."
    echo "// Fix the logic upstream and re-copy; edit here only for Pi plumbing."
    cat "$src"
  } > "$dst"
  echo "Synced $1"
}

copy_with_header check.ts
copy_with_header history.ts

echo ""
echo "Pi-adapted files (review diffs manually against upstream before merging changes):"
for f in types.ts config.ts state.ts commands.ts; do
  if [[ -f "$UPSTREAM/src/$f" ]]; then
    diff_lines="$(diff -u "$UPSTREAM/src/$f" "$DEST/$f" | wc -l || true)"
    echo "  $f: $diff_lines diff lines vs upstream src/$f"
  fi
done
