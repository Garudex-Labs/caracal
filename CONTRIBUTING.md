# Contributing to Caracal Core

We welcome contributions to Caracal Core. Please follow these guidelines to ensure a smooth collaboration process.

## Development Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Garudex-Labs/Caracal.git
    cd Caracal
    ```

2.  **Install dependencies using uv (recommended):**
    ```bash
    uv venv
    source .venv/bin/activate
    uv pip install -e ".[dev]"
    ```

## Quality Standards

All contributions must pass our quality checks before merging.

### Testing
Run the comprehensive test suite to ensure no regressions:

```bash
pytest
```

### Linting & Formatting
We strictly enforce code style and type safety.

```bash
# Format code
black caracal/ tests/

# Lint code
ruff check caracal/ tests/

# Type check
mypy caracal/
```

## Submission Process

1.  Fork the repository and create a feature branch (`feat/your-feature`).
2.  Commit your changes using [Conventional Commits](https://www.conventionalcommits.org).
3.  Ensure all tests and linting checks pass locally.
4.  Submit a Pull Request and address any review comments.

Thank you for helping build pre-execution authority enforcement for the agentic web.
