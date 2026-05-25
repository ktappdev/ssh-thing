#!/usr/bin/env bash
#
# release.sh — Auto-bump PATCH version and release.
#
# Reads the current version from package.json, bumps the PATCH segment,
# and calls release-tag.sh <new_version> --push after confirmation.
#
# Usage:
#   ./scripts/release.sh
#   npm run release

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---- Read current version ----
CURRENT="$(node -e "console.log(require('./package.json').version)")"

if [[ ! "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Unexpected version format in package.json: $CURRENT" >&2
  echo "Expected semver like 1.2.3" >&2
  exit 1
fi

# ---- Bump PATCH ----
MAJOR="${CURRENT%%.*}"
REST="${CURRENT#*.}"
MINOR="${REST%%.*}"
PATCH="${REST#*.}"
NEW="${MAJOR}.${MINOR}.$((PATCH + 1))"

echo "Release: ${CURRENT} → ${NEW}"
echo "Press enter to continue or Ctrl+C to cancel."
read -r

# ---- Delegate to release-tag.sh ----
exec ./scripts/release-tag.sh "$NEW" --push
