#!/bin/bash
# Update version references across the codebase from VERSION file

set -e

# Get the root directory of the project
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"

# Check if VERSION file exists
if [ ! -f "$VERSION_FILE" ]; then
    echo "ERROR: VERSION file not found at $VERSION_FILE"
    exit 1
fi

# Read version from VERSION file
VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

echo "Updating version references to: $VERSION"

echo "Open-source Caracal no longer maintains gateway Helm/Kubernetes manifests."
echo "Enterprise deployment assets are versioned in the enterprise repository."

echo "Version update complete!"
echo "Updated to version: $VERSION"
