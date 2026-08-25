#!/usr/bin/env bash

set -euo pipefail

REPOSITORY="ktappdev/ssh-thing"
APP_NAME="SSH THING.app"
INSTALL_PATH="/Applications/${APP_NAME}"
RELEASES_URL="https://github.com/${REPOSITORY}/releases/latest"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ssh-thing-install.XXXXXX")"
MOUNT_POINT="${TEMP_DIR}/mount"
DMG_PATH="${TEMP_DIR}/ssh-thing.dmg"
MOUNTED="false"

cleanup() {
  if [[ "${MOUNTED}" == "true" ]]; then
    hdiutil detach "${MOUNT_POINT}" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "${TEMP_DIR}"
}

trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This installer supports macOS only.\n' >&2
  exit 1
fi

for command in curl hdiutil ditto xattr open uname mktemp find sudo; do
  require_command "${command}"
done

case "$(uname -m)" in
  arm64)
    ASSET_ARCH="aarch64"
    FRIENDLY_ARCH="Apple Silicon"
    ;;
  x86_64)
    ASSET_ARCH="x64"
    FRIENDLY_ARCH="Intel"
    ;;
  *)
    printf 'Unsupported macOS architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

LATEST_URL="$(curl --fail --silent --show-error --location --output /dev/null --write-out '%{url_effective}' "${RELEASES_URL}")"
RELEASE_TAG="${LATEST_URL##*/}"

if [[ ! "${RELEASE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  printf 'Could not determine a valid latest release tag from %s\n' "${LATEST_URL}" >&2
  exit 1
fi

VERSION="${RELEASE_TAG#v}"
ASSET_NAME="SSH.THING_${VERSION}_${ASSET_ARCH}.dmg"
ASSET_URL="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"

printf 'Latest release: %s\n' "${RELEASE_TAG}"
printf 'Architecture: %s\n' "${FRIENDLY_ARCH}"
printf 'Downloading: %s\n' "${ASSET_NAME}"

mkdir -p "${MOUNT_POINT}"
curl --fail --location --retry 3 --retry-delay 1 --show-error --output "${DMG_PATH}" "${ASSET_URL}"

printf 'Mounting installer...\n'
hdiutil attach "${DMG_PATH}" -nobrowse -readonly -mountpoint "${MOUNT_POINT}" >/dev/null
MOUNTED="true"

APP_SOURCE="${MOUNT_POINT}/${APP_NAME}"
if [[ ! -d "${APP_SOURCE}" ]]; then
  APP_SOURCE="$(find "${MOUNT_POINT}" -type d -name '*.app' -print -quit)"
fi

if [[ -z "${APP_SOURCE}" || ! -d "${APP_SOURCE}" ]]; then
  printf 'The release DMG did not contain %s.\n' "${APP_NAME}" >&2
  exit 1
fi

if [[ -d "${INSTALL_PATH}" ]]; then
  printf 'Replacing existing %s...\n' "${INSTALL_PATH}"
  sudo rm -rf -- "${INSTALL_PATH}"
fi

printf 'Installing into /Applications...\n'
sudo ditto "${APP_SOURCE}" "${INSTALL_PATH}"

printf 'Removing macOS quarantine attribute...\n'
sudo xattr -dr com.apple.quarantine "${INSTALL_PATH}" 2>/dev/null || true

printf 'Installation complete. Launching SSH THING...\n'
open "${INSTALL_PATH}"
