# Caracal Core Scripts

This directory contains utility scripts for managing Caracal Core.

## Version Management

### VERSION File

The `VERSION` file at the root of the project is the single source of truth for the version number. All other version references are derived from this file.

To update the version:

1. Edit the `VERSION` file with the new version number (e.g., `1.0.0`)
2. Run `./scripts/update-version.sh` to update all references
3. Commit the changes

### update-version.sh

Updates all version references across the codebase from the VERSION file.

**Usage:**

```bash
./scripts/update-version.sh
```

**What it updates:**

- Open-source runtime/package metadata managed in this repository
- Enterprise deployment manifests are versioned in `caracalEnterprise`

### build-images.sh

Builds all Docker images with the version from the VERSION file.

**Usage:**

```bash
./scripts/build-images.sh
```

**Images built:**

- `caracal-mcp-adapter:v{VERSION}`
- `caracal-consumer:v{VERSION}`
- `caracal-cli:v{VERSION}`

### release.sh

Comprehensive release script that automates the entire release process.

**Usage:**

```bash
./scripts/release.sh
```

**Steps:**

1. Updates all version references
2. Creates git tag (optional)
3. Builds Docker images (optional)
4. Publishes to PyPI (optional)

The script is interactive and prompts for confirmation at each step.

## Backup, Recovery, and Security

These operations are now first-class `caracal` subcommands shipped in the host wheel:

| Command | Replaces |
|---|---|
| `caracal backup` | `backup-postgresql.sh` |
| `caracal restore <file>` | `restore-postgresql.sh` |
| `caracal certs` | `generate-certs.sh` |
| `caracal redis init` | `setup-redis-security.sh` |
| `caracal events replay` | `event-replay-recovery.sh` |

Run `caracal --help` for full usage.

## Python Version Management

The Python package version is automatically read from the VERSION file through:

1. **pyproject.toml**: Uses `dynamic = ["version"]` and `[tool.setuptools.dynamic]`
2. **setup.py**: Reads VERSION file and passes to setuptools
3. **caracal/\_version.py**: Module that reads VERSION file at runtime
4. **caracal/**init**.py**: Exports `__version__` from `_version.py`

This ensures the version is always consistent across:

- Package metadata
- Runtime code
- Docker images

## Example Workflow

### Releasing a New Version

1. **Update VERSION file:**

   ```bash
   echo "1.0.0" > VERSION
   ```

2. **Run release script:**

   ```bash
   ./scripts/release.sh
   ```

3. **Follow prompts to:**
   - Update version references
   - Create git tag
   - Build Docker images
   - Publish to PyPI

### Manual Version Update

If you prefer manual control:

```bash
# 1. Update VERSION file
echo "1.0.0" > VERSION

# 2. Update references
./scripts/update-version.sh

# 3. Build images
./scripts/build-images.sh

# 4. Create tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# 5. Publish to PyPI
python -m build
twine upload dist/*
```

## Notes

- All scripts should be run from the Caracal root directory
- Scripts use the VERSION file as the single source of truth
- Docker images are tagged with `v` prefix (e.g., `v1.0.0`)
- Git tags use `v` prefix (e.g., `v1.0.0`)
