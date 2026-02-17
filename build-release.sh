#!/bin/bash

set -e

echo "Building ssh-thing for multiple platforms..."

RELEASE_DIR="release-builds"
mkdir -p "$RELEASE_DIR"

TARGETS=(
    "x86_64-apple-darwin"
    "aarch64-apple-darwin"
)

for target in "${TARGETS[@]}"; do
    echo ""
    echo "=========================================="
    echo "Building for $target"
    echo "=========================================="
    
    if cargo tauri build --target "$target"; then
        echo "✓ Successfully built for $target"
        
        BUNDLE_DIR="target/$target/release/bundle"
        
        if [ -d "$BUNDLE_DIR/dmg" ]; then
            for dmg in "$BUNDLE_DIR/dmg"/*.dmg; do
                if [ -f "$dmg" ]; then
                    cp "$dmg" "$RELEASE_DIR/"
                    echo "  → Copied DMG: $(basename "$dmg")"
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
