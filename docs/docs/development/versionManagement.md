# Version Management in Caracal Core

## Overview

Caracal Core uses a centralized version management system where the `VERSION` file at the root of the project serves as the single source of truth for all version references.

## Architecture

### Single Source of Truth

The `VERSION` file contains only the version number (e.g., `0.4.0`) and is used by:

1. **Python Package** (`pyproject.toml`, `setup.py`)
2. **Runtime Code** (`caracal/_version.py`, `caracal/__init__.py`)
3. **Docker Images** (via build scripts)
4. **Helm Charts** (`helm/caracal/Chart.yaml`)
5. **Kubernetes Manifests** (all `*.yaml` files in `k8s/`)

### How It Works

#### Python Package

**pyproject.toml:**
```toml
[project]
name = "caracal-core"
dynamic = ["version"]

[tool.setuptools.dynamic]
version = {file = ["VERSION"]}
```

**setup.py:**
```python
from pathlib import Path
from setuptools import setup

version_file = Path(__file__).parent / "VERSION"
version = version_file.read_text().strip()

setup(version=version)
```

**caracal/_version.py:**
```python
from pathlib import Path

def get_version() -> str:
    version_file = Path(__file__).parent.parent / "VERSION"
    if version_file.exists():
        return version_file.read_text().strip()
    return "unknown"

__version__ = get_version()
```

**caracal/__init__.py:**
```python
from caracal._version import __version__

__all__ = ["__version__"]
```

#### Docker Images

Docker images are built with version tags read from the VERSION file:

```bash
VERSION=$(cat VERSION | tr -d '[:space:]')
docker build -t caracal-gateway:v$VERSION -f Dockerfile.gateway .
```

#### Helm Charts

The `update-version.sh` script updates Helm Chart.yaml:

```bash
VERSION=$(cat VERSION | tr -d '[:space:]')
sed -i "s/^version: .*/version: $VERSION/" helm/caracal/Chart.yaml
sed -i "s/^appVersion: .*/appVersion: \"$VERSION\"/" helm/caracal/Chart.yaml
```

#### Kubernetes Manifests

All Kubernetes manifests use version labels that are updated by the script:

```yaml
metadata:
  labels:
    app.kubernetes.io/version: "0.4.0"  # Updated by script
```

## Usage

### Updating the Version

1. **Edit VERSION file:**
   ```bash
   echo "0.4.0" > VERSION
   ```

2. **Update all references:**
   ```bash
   ./scripts/update-version.sh
   ```

3. **Verify changes:**
   ```bash
   git diff
   ```

4. **Commit changes:**
   ```bash
   git add VERSION pyproject.toml helm/ k8s/
   git commit -m "Bump version to 0.4.0"
   ```

### Automated Release

Use the release script for a complete release process:

```bash
./scripts/release.sh
```

This will:
1. Update all version references
2. Create git tag (optional)
3. Build Docker images (optional)
4. Package Helm chart (optional)
5. Publish to PyPI (optional)

### Manual Release Steps

If you prefer manual control:

```bash
# 1. Update version
echo "0.4.0" > VERSION

# 2. Update references
./scripts/update-version.sh

# 3. Commit changes
git add VERSION pyproject.toml helm/ k8s/
git commit -m "Bump version to 0.4.0"

# 4. Create tag
git tag -a v0.4.0 -m "Release v0.4.0"
git push origin main
git push origin v0.4.0

# 5. Build Docker images
./scripts/build-images.sh

# 6. Package Helm chart
cd helm
helm package caracal
helm push caracal-0.4.0.tgz oci://registry.example.com/charts

# 7. Publish to PyPI
cd ..
python -m build
twine upload dist/*
```

## Version Format

Caracal Core follows [Semantic Versioning](https://semver.org/):

- **MAJOR.MINOR.PATCH** (e.g., `0.4.0`)
- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Version Prefixes

- **Git tags**: Use `v` prefix (e.g., `v0.4.0`)
- **Docker images**: Use `v` prefix (e.g., `caracal-gateway:v0.4.0`)
- **Helm charts**: No `v` prefix (e.g., `version: 0.4.0`)
- **Python package**: No `v` prefix (e.g., `version = "0.4.0"`)
- **Kubernetes labels**: No `v` prefix (e.g., `app.kubernetes.io/version: "0.4.0"`)

## Files Updated by Scripts

### update-version.sh

- `helm/caracal/Chart.yaml` (version and appVersion)
- All `k8s/**/*.yaml` files (app.kubernetes.io/version labels)

### build-images.sh

Builds Docker images with version tags:
- `caracal-gateway:v{VERSION}`
- `caracal-mcp-adapter:v{VERSION}`
- `caracal-consumer:v{VERSION}`
- `caracal-cli:v{VERSION}`

### release.sh

Orchestrates the entire release process by calling other scripts and performing git operations.

## Accessing Version at Runtime

### Python Code

```python
import caracal
print(caracal.__version__)  # e.g., "0.4.0"
```

### CLI

```bash
caracal --version
```

### Docker Container

```bash
docker run caracal-gateway:v0.4.0 caracal --version
```

### Kubernetes

```bash
kubectl get deployment caracal-gateway -o jsonpath='{.metadata.labels.app\.kubernetes\.io/version}'
```

## Best Practices

1. **Always update VERSION file first** before running scripts
2. **Run update-version.sh** after changing VERSION file
3. **Commit VERSION file changes** with all updated references
4. **Use semantic versioning** for version numbers
5. **Tag releases** with `v` prefix (e.g., `v0.4.0`)
6. **Test locally** before pushing tags
7. **Document changes** in RELEASE_NOTES.md

## Troubleshooting

### Version Mismatch

If you see version mismatches:

```bash
# Re-run update script
./scripts/update-version.sh

# Verify all files are updated
git diff
```

### Python Package Version

If Python package shows wrong version:

```bash
# Rebuild package
python -m build

# Check version
python -c "import caracal; print(caracal.__version__)"
```

### Docker Image Version

If Docker images have wrong tags:

```bash
# Rebuild images
./scripts/build-images.sh

# Verify tags
docker images | grep caracal
```

## Migration from Hardcoded Versions

If you're migrating from hardcoded versions:

1. Create VERSION file with current version
2. Update pyproject.toml to use dynamic versioning
3. Update setup.py to read from VERSION file
4. Create _version.py module
5. Update __init__.py to import from _version.py
6. Run update-version.sh to update all references
7. Test that version is correctly read everywhere

## References

- [Semantic Versioning](https://semver.org/)
- [PEP 440 - Version Identification](https://www.python.org/dev/peps/pep-0440/)
- [setuptools Dynamic Metadata](https://setuptools.pypa.io/en/latest/userguide/pyproject_config.html#dynamic-metadata)
