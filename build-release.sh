#!/bin/bash

set -e

echo "Building ssh-thing for multiple platforms..."

RELEASE_DIR="release-builds"
mkdir -p "$RELEASE_DIR"
VERSION="$(node -p 'require("./package.json").version')"

TARGETS=(
    "x86_64-apple-darwin"
    "aarch64-apple-darwin"
)

for target in "${TARGETS[@]}"; do
    echo ""
    echo "=========================================="
    echo "Building for $target"
    echo "=========================================="

    BUNDLE_ROOT="target/$target/release/bundle"
    rm -f "$BUNDLE_ROOT/macos"/*.dmg "$BUNDLE_ROOT/dmg"/*.dmg
    
    if cargo tauri build --target "$target"; then
        echo "✓ Successfully built for $target"
        
        BUNDLE_DIR="$BUNDLE_ROOT/macos"
        if [ ! -d "$BUNDLE_DIR" ]; then
            BUNDLE_DIR="$BUNDLE_ROOT/dmg"
        fi
        if [ "$target" = "aarch64-apple-darwin" ]; then
            ASSET_ARCH="aarch64"
        else
            ASSET_ARCH="x64"
        fi

        if [ -d "$BUNDLE_DIR" ]; then
            for dmg in "$BUNDLE_DIR"/*.dmg; do
                if [ -f "$dmg" ]; then
                    destination="$RELEASE_DIR/SSH.THING_${VERSION}_${ASSET_ARCH}.dmg"
                    cp "$dmg" "$destination"
                    echo "  → Copied DMG: $(basename "$destination")"
                fi
            done
        fi
    else
        echo "✗ Failed to build for $target"
        exit 1
    fi
done

echo ""
echo "=========================================="
echo "macOS builds completed successfully!"
echo "=========================================="
echo ""
echo "NOTE: Windows builds require Windows or cross-compilation tools."
echo "      Run this script on Windows or use CI/CD for Windows builds."
echo ""
echo "Output files in $RELEASE_DIR/:"
ls -lh "$RELEASE_DIR/"
