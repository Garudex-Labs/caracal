# Contributing to Caracal Core

Thanks for contributing to Caracal.

This guide is focused on fast setup, clean changes, and predictable review.

## Quick Start

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
make setup-dev

# Start runtime stack
caracal up
```

What this does:

1. Installs runtime and dev dependencies
2. Starts PostgreSQL and Redis
3. Installs CLI and TUI commands

## Manual Setup

```bash
# Create environment
uv venv
source .venv/bin/activate

# Install dependencies
uv sync --locked --extra dev

# Start infra
make infra-up

# Verify
caracal --version

# Start runtime stack
caracal up
```

## Runtime Commands

Host `caracal` is orchestration-only.

```bash
caracal up
caracal down
caracal cli
caracal flow
caracal logs -f
caracal reset
```

Full interactive CLI runs inside container:

```bash
caracal cli
# then inside the restricted Caracal session:
help
```

## Infrastructure Commands

```bash
make infra-up
make infra-status
make infra-logs
make infra-down
```

## Repository Layout

- `caracal/`: core package
- `tests/`: test suite
- `docs/`: docs and architecture notes
- `scripts/`: helper scripts

## Build and Packaging File Roles

These files are active and should be kept:

- `Makefile`: developer wrapper and setup helpers
- `MANIFEST.in`: source distribution include/exclude rules
- `setup.py`: compatibility entrypoint for legacy build tools
- `uv.lock`: locked dependency graph for reproducible `uv sync`
- `alembic.ini`: Alembic configuration for migration commands only

## Development Workflow

### Branch Names

- `feat/<name>`
- `fix/<name>`
- `docs/<name>`
- `refactor/<name>`
- `test/<name>`

### Commits

Use Conventional Commits.

Examples:

- `feat(core): add scoped mandate validation`
- `fix(cli): handle missing workspace config`
- `docs(readme): update docker quickstart`

## Quality Checks

Run these before opening a pull request.

```bash
pytest
black caracal/ tests/
ruff check caracal/ tests/
mypy caracal/
```

Or run in one command:

```bash
pytest && black caracal/ tests/ && ruff check caracal/ tests/ && mypy caracal/
```

## Pull Request Checklist

- [ ] focused change (single concern)
- [ ] tests added or updated
- [ ] all checks pass locally
- [ ] docs updated when behavior changes
- [ ] no unrelated file changes

## Database Changes

Use Alembic.

```bash
alembic revision --autogenerate -m "describe change"
alembic upgrade head
```

## Reporting Issues

Please include:

- OS and Python version
- exact steps to reproduce
- expected behavior and actual behavior
- error logs or traceback
- `caracal --version` output

## Community Standards

Please follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
