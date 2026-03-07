#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-tag.sh <version> [--push] [--allow-dirty]

Examples:
  ./scripts/release-tag.sh 0.1.1
  ./scripts/release-tag.sh 0.1.1 --push

What it does:
  1. Updates version in package.json, package-lock.json, Cargo.toml, and src-tauri/tauri.conf.json
  2. Creates a git commit: Release v<version>
  3. Creates a git tag: v<version>
  4. Optionally pushes the commit and tag with --push
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION=""
PUSH_CHANGES="false"
ALLOW_DIRTY="false"

for arg in "$@"; do
  case "$arg" in
    --push)
      PUSH_CHANGES="true"
      ;;
    --allow-dirty)
      ALLOW_DIRTY="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Unexpected argument: $arg" >&2
        usage
        exit 1
      fi
      VERSION="$arg"
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Missing version." >&2
  usage
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "Version must look like 1.2.3 or 1.2.3-beta.1" >&2
  exit 1
fi

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must run inside the git repository." >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" != "true" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes first, or rerun with --allow-dirty." >&2
  exit 1
fi

TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

VERSION="$VERSION" node <<'EOF'
const fs = require("fs");

const version = process.env.VERSION;
const files = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  cargoToml: "Cargo.toml",
  tauriConf: "src-tauri/tauri.conf.json",
};

const packageJson = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
packageJson.version = version;
fs.writeFileSync(files.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(fs.readFileSync(files.packageLock, "utf8"));
packageLock.version = version;
if (packageLock.packages && packageLock.packages[""]) {
  packageLock.packages[""].version = version;
}
fs.writeFileSync(files.packageLock, `${JSON.stringify(packageLock, null, 2)}\n`);

const cargoToml = fs.readFileSync(files.cargoToml, "utf8");
const nextCargoToml = cargoToml.replace(
  /^(\[workspace\.package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
  `$1${version}$3`,
);
if (nextCargoToml === cargoToml) {
  console.error("Failed to update [workspace.package] version in Cargo.toml");
  process.exit(1);
}
fs.writeFileSync(files.cargoToml, nextCargoToml);

const tauriConf = JSON.parse(fs.readFileSync(files.tauriConf, "utf8"));
tauriConf.version = version;
fs.writeFileSync(files.tauriConf, `${JSON.stringify(tauriConf, null, 2)}\n`);
EOF

git add package.json package-lock.json Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release $TAG"
git tag "$TAG"

echo "Created commit and tag:"
echo "  branch: $CURRENT_BRANCH"
echo "  version: $VERSION"
echo "  tag: $TAG"

if [[ "$PUSH_CHANGES" == "true" ]]; then
  git push origin "$CURRENT_BRANCH"
  git push origin "$TAG"
  echo "Pushed branch and tag to origin."
else
  echo "Nothing pushed yet."
  echo "Run:"
  echo "  git push origin $CURRENT_BRANCH"
  echo "  git push origin $TAG"
fi
