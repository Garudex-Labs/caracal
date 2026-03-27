#!/bin/bash
# Build Docker images with version from VERSION file

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

echo "Building Docker images for version: $VERSION"

DOCKER_DIR="$ROOT_DIR/deploy/docker"

echo "Building caracal-runtime:v$VERSION..."
docker build -t caracal-runtime:v$VERSION -f "$DOCKER_DIR/Dockerfile.runtime" "$ROOT_DIR"

# Backward-compatible tags for existing workflows.
docker tag caracal-runtime:v$VERSION caracal-mcp-adapter:v$VERSION
docker tag caracal-runtime:v$VERSION caracal-cli:v$VERSION
docker tag caracal-runtime:v$VERSION caracal-flow:v$VERSION

echo ""
echo "Docker images built successfully!"
echo "Images:"
echo "  - caracal-runtime:v$VERSION"
echo "  - caracal-mcp-adapter:v$VERSION"
echo "  - caracal-cli:v$VERSION"
echo "  - caracal-flow:v$VERSION"
