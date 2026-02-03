#!/bin/bash
# Release script for Caracal Core
# This script automates the release process by:
# 1. Reading version from VERSION file
# 2. Updating all version references
# 3. Creating git tag
# 4. Building Docker images
# 5. Packaging Helm chart

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

echo "=========================================="
echo "Caracal Core Release Script"
echo "Version: $VERSION"
echo "=========================================="
echo ""

# Step 1: Update version references
echo "Step 1: Updating version references..."
bash "$SCRIPT_DIR/update-version.sh"
echo "✓ Version references updated"
echo ""

# Step 2: Git operations
echo "Step 2: Git operations..."
read -p "Create git tag v$VERSION? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git tag -a "v$VERSION" -m "Caracal Core v$VERSION - Enterprise-grade event-driven architecture"
    echo "✓ Git tag v$VERSION created"
    
    read -p "Push tag to remote? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin "v$VERSION"
        echo "✓ Tag pushed to remote"
    fi
else
    echo "⊘ Skipped git tag creation"
fi
echo ""

# Step 3: Build Docker images
echo "Step 3: Building Docker images..."
read -p "Build Docker images? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    bash "$SCRIPT_DIR/build-images.sh"
    echo "✓ Docker images built"
else
    echo "⊘ Skipped Docker image build"
fi
echo ""

# Step 4: Package Helm chart
echo "Step 4: Packaging Helm chart..."
read -p "Package Helm chart? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$ROOT_DIR/helm"
    helm package caracal-v03
    echo "✓ Helm chart packaged: caracal-v03-$VERSION.tgz"
    
    read -p "Push Helm chart to registry? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "Enter Helm registry URL (e.g., oci://registry.example.com/charts): " HELM_REGISTRY
        helm push "caracal-v03-$VERSION.tgz" "$HELM_REGISTRY"
        echo "✓ Helm chart pushed to registry"
    fi
else
    echo "⊘ Skipped Helm chart packaging"
fi
echo ""

# Step 5: PyPI publication
echo "Step 5: PyPI publication..."
read -p "Build and publish to PyPI? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$ROOT_DIR"
    python -m build
    echo "✓ Package built"
    
    read -p "Upload to PyPI? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        twine upload dist/*
        echo "✓ Package uploaded to PyPI"
    fi
else
    echo "⊘ Skipped PyPI publication"
fi
echo ""

echo "=========================================="
echo "Release process complete!"
echo "Version: $VERSION"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Update release notes on GitHub"
echo "2. Announce release on community channels"
echo "3. Update documentation website"
