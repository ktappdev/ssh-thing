#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/update-homebrew.sh <version>

Examples:
  ./scripts/update-homebrew.sh 1.1.23

What it does:
  1. Downloads macOS DMGs from GitHub release
  2. Computes SHA256 hashes for both architectures
  3. Clones or updates homebrew-tap in /tmp
  4. Updates the cask with new version and SHAs
  5. Commits and pushes changes

Requires:
  - gh CLI installed and authenticated (gh auth token)
EOF
}

if [[ $# -lt 1 ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
  usage
  exit 0
fi

VERSION="$1"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "Version must look like 1.2.3 or 1.2.3-beta.1" >&2
  exit 1
fi

TAP_DIR="/tmp/homebrew-tap"
RELEASE_TAG="v$VERSION"

echo "Updating Homebrew cask for ssh-thing version $VERSION"

# Download DMGs
echo "Downloading DMGs from GitHub release..."
cd /tmp
rm -f "SSH.THING_${VERSION}_"*.dmg
curl -fL -o "SSH.THING_${VERSION}_aarch64.dmg" "https://github.com/ktappdev/ssh-thing/releases/download/${RELEASE_TAG}/SSH.THING_${VERSION}_aarch64.dmg"
curl -fL -o "SSH.THING_${VERSION}_x64.dmg" "https://github.com/ktappdev/ssh-thing/releases/download/${RELEASE_TAG}/SSH.THING_${VERSION}_x64.dmg"

# Compute SHA256 hashes
echo "Computing SHA256 hashes..."
SHA256_ARM=$(shasum -a 256 "SSH.THING_${VERSION}_aarch64.dmg" | awk '{print $1}')
SHA256_INTEL=$(shasum -a 256 "SSH.THING_${VERSION}_x64.dmg" | awk '{print $1}')

echo "ARM SHA256: $SHA256_ARM"
echo "Intel SHA256: $SHA256_INTEL"

# Clone or update homebrew-tap
echo "Cloning/updating homebrew-tap..."
rm -rf "$TAP_DIR"
git clone "https://github.com/ktappdev/homebrew-tap.git" "$TAP_DIR"
cd "$TAP_DIR"

# Configure git with gh token
GITHUB_TOKEN=$(gh auth token)
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# Update cask
echo "Updating cask..."
cat > "$TAP_DIR/Casks/ssh-thing.rb" <<EOF
cask "ssh-thing" do
  version "${VERSION}"
  name "SSH Thing"
  desc "SSH client"
  homepage "https://github.com/ktappdev/ssh-thing"

  on_arm do
    url "https://github.com/ktappdev/ssh-thing/releases/download/v#{version}/SSH.THING_#{version}_aarch64.dmg"
    sha256 "${SHA256_ARM}"
  end
  on_intel do
    url "https://github.com/ktappdev/ssh-thing/releases/download/v#{version}/SSH.THING_#{version}_x64.dmg"
    sha256 "${SHA256_INTEL}"
  end

  app "SSH THING.app"
end
EOF

# Commit and push
echo "Committing and pushing changes..."
cd "$TAP_DIR"
git add Casks/ssh-thing.rb
git diff --cached --quiet || git commit -m "Update ssh-thing to v${VERSION}"
git push "https://${GITHUB_TOKEN}@github.com/ktappdev/homebrew-tap.git" main

echo "Homebrew cask updated successfully!"