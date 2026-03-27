# Contributing to Caracal Core

We welcome contributions to Caracal Core. Please follow these guidelines to ensure a smooth collaboration process.

## Project Overview

Caracal is a pre-execution authority enforcement system for AI agents. The repository contains:

- **caracal/**: Core Python package implementing authority enforcement, ledger, and policy engine
- **caracalEnterprise/**: Next.js web dashboard and enterprise components
- **tests/**: Comprehensive test suite covering core modules
- **docs/**: Documentation and architectural guides
- **scripts/**: Utility scripts for development and deployment

## Development Setup

### System Requirements

- Python 3.10+
- Docker & Docker Compose (for PostgreSQL and Redis)
- uv (Python package manager - auto-installed by Makefile if missing)

### Quick Start (Automated)

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
make setup-dev
```

This automatically:
1. Installs Python dependencies (runtime + dev)
2. Starts PostgreSQL and Redis containers
3. Installs the caracal CLI and caracal-flow TUI

### Manual Setup

If you prefer manual setup:

```bash
# 1. Clone and navigate
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal

# 2. Create and activate virtual environment
uv venv
source .venv/bin/activate

# 3. Install dependencies
uv sync --locked --extra dev

# 4. Start infrastructure (Postgres + Redis)
make infra-up

# 5. Verify setup
caracal --version
caracal-flow  # Launch TUI (Ctrl+C to exit)
```

### Infrastructure Management

The Caracal development stack requires PostgreSQL and Redis. Manage them via:

```bash
make infra-up       # Start PostgreSQL + Redis, wait for health checks
make infra-status   # View container status
make infra-logs     # Tail logs
make infra-down     # Stop containers
```

## Code Organization

### Core Modules

- **caracal/core/**: Authority enforcement engine (principals, policies, mandates)
- **caracal/db/**: Database models and connection management
- **caracal/cli/**: Command-line interface (caracal command)
- **caracal/flow/**: Terminal UI and interactive workflows (caracal-flow command)
- **caracal/provider/**: Integration interfaces for external systems
- **caracal/mcp/**: Model Context Protocol server implementation
- **caracal/monitoring/**: Metrics and telemetry
- **caracal/merkle/**: Cryptographic proof structures

### Testing Structure

- **tests/**: Test modules mirror caracal/ structure
- Use pytest fixtures for database setup (see existing tests/)
- Tests must pass with in-memory and PostgreSQL backends

## Quality Standards

All contributions must pass our quality checks before merging.

### Running Tests

```bash
# Run full test suite with coverage
pytest --cov=caracal --cov-report=html

# Run specific test module
pytest tests/test_cli.py

# Run with verbose output
pytest -vv

# Run async tests (asyncio-aware)
pytest -m asyncio
```

### Code Formatting & Linting

We enforce consistent code style using black, ruff, and mypy.

```bash
# Format code (in-place)
black caracal/ tests/ scripts/

# Check code style
ruff check caracal/ tests/

# Auto-fix ruff issues
ruff check --fix caracal/ tests/

# Type check
mypy caracal/
```

### Pre-commit Guidance

Before submitting a PR, ensure:

1. All tests pass: `pytest`
2. Code is formatted: `black caracal/ tests/`
3. No linting issues: `ruff check caracal/ tests/`
4. Type safety: `mypy caracal/`

Or run all checks in sequence:

```bash
pytest && black caracal/ tests/ && ruff check caracal/ tests/ && mypy caracal/
```

## Development Workflow

### Branch Naming

Create feature branches using the convention:

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation updates
- `refactor/description` — Code refactoring
- `test/description` — Test additions or improvements

Example: `feat/delegation-depth-validation` or `fix/mandate-expiry-check`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Examples:

```
feat(core): add execution mandate delegation support

Implements EIP-003 delegation depth enforcement with backward compatibility for legacy mandates.

Closes #456
```

```
fix(db): handle concurrent partition schema migrations

Added advisory locks to prevent race conditions during schema version updates.
```

### Submitting a Pull Request

1. **Fork and branch**: Create a feature branch from `main`
2. **Develop**: Make focused changes addressing a single concern
3. **Test locally**: Ensure `pytest` passes and formatting checks succeed
4. **Push**: Commit with conventional messages and push to your fork
5. **Create PR**: Submit against the main repository's `main` branch
6. **Address review**: Respond to feedback and push updates
7. **Merge**: Maintainers will merge once approved

### PR Checklist

- [ ] Tests added/updated for new logic
- [ ] All tests pass (`pytest`)
- [ ] Code formatted (`black caracal/ tests/`)
- [ ] No linting issues (`ruff check caracal/ tests/`)
- [ ] Type checks pass (`mypy caracal/`)
- [ ] Docstrings updated for public APIs
- [ ] Commit messages follow Conventional Commits
- [ ] No unrelated changes in this PR

## Architecture & Design Principles

### Key Concepts

- **Principals**: Identities with ECDSA P-256 cryptographic keys
- **Policies**: Fine-grained rules defining allowed actions on resources
- **Mandates**: Signed, short-lived tokens granting execution authority
- **Execution Proof**: Cryptographically verifiable record linking action to mandate

### Adding New Features

1. **Design**: Propose changes via issue before implementing
2. **Implement**: Add feature to appropriate module (e.g., `caracal/core/`)
3. **Test**: Write tests covering happy path, edge cases, and error conditions
4. **Document**: Update docstrings and add architectural notes
5. **Example**: Add usage example to `examples/` if applicable

### Database Schema Changes

Use Alembic for migrations:

```bash
# Generate migration
alembic revision --autogenerate -m "add_new_table"

# Apply migrations
alembic upgrade head

# Downgrade (development only)
alembic downgrade -1
```

## Reporting Issues

When reporting bugs, include:

- Python version and OS
- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs or stack traces
- Caracal version (run `caracal --version`)

## Getting Help

- **Documentation**: See [docs/](docs/) in the repository
- **Examples**: Check [examples/](examples/) for working code samples
- **Issues**: Search existing issues before creating a new one
- **Discussions**: Use GitHub Discussions for questions about usage

## Code of Conduct

Please review [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) to understand our community standards.

---

Thank you for helping build pre-execution authority enforcement for the agentic web!
