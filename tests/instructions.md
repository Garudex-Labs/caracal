---
description: Apply when adding, editing, or reviewing any test file in the Caracal test suite.
applyTo: tests/**
---

## Purpose
Test suite organized into layers: `unit/`, `integration/`, `security/`, `edge/`, `regression/`, `coverage/`.

## Rules
- Test files start with `test_`; names use at most two content words after the prefix.
- Class names: `Test` + one PascalCase noun (e.g., `TestAuthority`).
- Function names: `test_` + short snake_case action (e.g., `test_expired_denied`).
- One assertion path per test; split tests that assert unrelated outcomes.
- All mocks import from `tests/mock/`; never redefine mock objects inline.
- Use `pytest.raises()` for exception assertions; no `try/except` in test bodies.
- Use `uuid4()` for all ID generation; no hardcoded UUIDs.
- Use `freezegun` for time-dependent tests; no `time.sleep()`.
- Mocks must be reset per test; use function-scoped fixtures only.

## Layer Rules
- `unit/`: single class or function in isolation; all dependencies mocked; no DB, no network.
- `integration/`: multi-component interaction; use `db_session` from `mock/database.py`; skip gracefully when DB is unavailable.
- `security/`: abuse, fuzzing, and access control; fuzz tests use `hypothesis`.
- `edge/`: boundary values and unusual inputs; no real DB.
- `regression/`: one test per fixed bug; never delete without a traced replacement.
- `coverage/`: targets specific uncovered branches; every assertion must validate real behavior.

## Constraints
- Forbidden: `pass` in test bodies.
- Forbidden: `pytest.skip()` without a conditional guard.
- Forbidden: DB or filesystem access in `unit/` or `edge/` tests.
- Forbidden: inline crypto fixtures outside `mock/crypto.py`.
- Directory names: single lowercase word; subdirectories mirror source structure.
- Markers are auto-applied by `conftest.py`; do not add `@pytest.mark.<layer>` manually.

## Shared Mocks
- `mock/builders.py`: `mandate()`, `principal()`, `mandate_data()` factory functions.
- `mock/crypto.py`: `crypto_fixtures` — real EC key pairs; use in integration/security only.
- `mock/database.py`: `in_memory_db_engine`, `db_session` — PostgreSQL only; skip if unavailable.
- `mock/signing.py`: `sign_mandate_for_test()`, `sign_merkle_root_for_test()` — crypto/security tests only.

## Imports
- Always import from `tests/mock/` for shared fixtures.
- Never import from `packages/caracal-server` internals in integration tests; use the public API layer.

## Security
- All authority, signing, and delegation boundaries must have corresponding security tests.
- Fuzz inputs must exercise both valid and invalid ranges.
