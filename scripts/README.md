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
- Helm Chart.yaml (version and appVersion)
- Kubernetes manifests (app.kubernetes.io/version labels)

### build-images.sh

Builds all Docker images with the version from the VERSION file.

**Usage:**
```bash
./scripts/build-images.sh
```

**Images built:**
- `caracal-gateway:v{VERSION}`
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
4. Packages Helm chart (optional)
5. Publishes to PyPI (optional)

The script is interactive and prompts for confirmation at each step.

## Backup & Recovery

### backup-postgresql.sh

Creates a backup of the PostgreSQL database.

**Usage:**
```bash
./scripts/backup-postgresql.sh
```

### restore-postgresql.sh

Restores a PostgreSQL database from backup.

**Usage:**
```bash
./scripts/restore-postgresql.sh <backup-file>
```

### backup-kafka-topics.sh

Backs up Kafka topics to disk.

**Usage:**
```bash
./scripts/backup-kafka-topics.sh
```

## Kafka Management

### create-kafka-topics.sh

Creates all required Kafka topics with proper configuration.

**Usage:**
```bash
./scripts/create-kafka-topics.sh
```

### register-schemas.sh

Registers Avro schemas with the Schema Registry.

**Usage:**
```bash
./scripts/register-schemas.sh
```

## Security Setup

### setup-kafka-security.sh

Configures Kafka security (SASL/SCRAM, TLS).

**Usage:**
```bash
./scripts/setup-kafka-security.sh
```

### setup-redis-security.sh

Configures Redis security (password, TLS).

**Usage:**
```bash
./scripts/setup-redis-security.sh
```

## Recovery

### snapshot-recovery.sh

Recovers system state from a ledger snapshot.

**Usage:**
```bash
./scripts/snapshot-recovery.sh <snapshot-id>
```

### event-replay-recovery.sh

Recovers system state by replaying events from Kafka.

**Usage:**
```bash
./scripts/event-replay-recovery.sh <timestamp>
```

## Python Version Management

The Python package version is automatically read from the VERSION file through:

1. **pyproject.toml**: Uses `dynamic = ["version"]` and `[tool.setuptools.dynamic]`
2. **setup.py**: Reads VERSION file and passes to setuptools
3. **caracal/_version.py**: Module that reads VERSION file at runtime
4. **caracal/__init__.py**: Exports `__version__` from `_version.py`

This ensures the version is always consistent across:
- Package metadata
- Runtime code
- Docker images
- Helm charts
- Kubernetes manifests

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
   - Package Helm chart
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

# 5. Package Helm chart
cd helm
helm package caracal
helm push caracal-1.0.0.tgz oci://registry.example.com/charts

# 6. Publish to PyPI
python -m build
twine upload dist/*
```

## Notes

- All scripts should be run from the Caracal root directory
- Scripts use the VERSION file as the single source of truth
- Docker images are tagged with `v` prefix (e.g., `v1.0.0`)
- Helm chart versions do not use `v` prefix (e.g., `1.0.0`)
- Git tags use `v` prefix (e.g., `v1.0.0`)
