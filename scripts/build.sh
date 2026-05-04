#!/usr/bin/env bash
set -euo pipefail

# Pull LFS objects. Vercel clones without LFS credentials, so we
# re-authenticate using a GitHub token before pulling.
if [ -d .git ] && command -v git-lfs &>/dev/null; then
  echo "→ Pulling Git LFS objects"
  if [ -n "${GH_TOKEN:-}" ]; then
    git config --global url."https://oauth2:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  fi
  git lfs pull || echo "  git lfs pull failed — continuing with files as-is"
fi

# Diagnostic: show NDJSON file sizes so logs reveal if LFS files are real
echo "→ NDJSON file sizes:"
ls -lh ndjson/*.ndjson 2>/dev/null || echo "  (none found)"

readarray -t ARGS < <(python3 scripts/build_args.py | tr -d '\r')
printf '→ Sources:\n'
printf '  %s\n' "${ARGS[@]}"
node scripts/build.mjs "${ARGS[@]}"
