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

# Update Helm Chart.yaml
HELM_CHART="$ROOT_DIR/helm/caracal-v03/Chart.yaml"
if [ -f "$HELM_CHART" ]; then
    echo "Updating Helm Chart.yaml..."
    sed -i "s/^version: .*/version: $VERSION/" "$HELM_CHART"
    sed -i "s/^appVersion: .*/appVersion: \"$VERSION\"/" "$HELM_CHART"
fi

# Update Kubernetes manifests
echo "Updating Kubernetes manifests..."
find "$ROOT_DIR/k8s" -name "*.yaml" -type f -exec sed -i "s/app.kubernetes.io\/version: \".*\"/app.kubernetes.io\/version: \"$VERSION\"/" {} \;

echo "Version update complete!"
echo "Updated to version: $VERSION"
