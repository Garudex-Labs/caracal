---
sidebar_position: 1
title: Contributing
---

# Contributing to Caracal

Thank you for your interest in contributing to Caracal! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
pip install -e ".[dev]"
```

## Running Tests

```bash
pytest
```

## Code Style

- Use **Black** for formatting.
- Use **Ruff** for linting.
- Follow PEP 8 guidelines.

```bash
black caracal/
ruff check caracal/
```

## Pull Request Process

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes.
4. Run tests and linting.
5. Submit a pull request.

## Reporting Issues

Use [GitHub Issues](https://github.com/Garudex-Labs/Caracal/issues) for bug reports and feature requests.
