# Caracal Test Suite — Instructions

## Structure

```
tests/
├── conftest.py          # Global fixtures and marker registration
├── instructions.md      # This file
├── mock/                # Centralized mocks, fixtures, and builders
│   ├── __init__.py      # Exports: crypto_fixtures, db_session, in_memory_db_engine
│   ├── builders.py      # Dynamic object builders (no DB required)
│   ├── crypto.py        # Cryptographic fixtures (real key pairs + signed principals)
│   ├── database.py      # DB engine and session fixtures
│   └── signing.py       # Raw signing helpers for tests
├── unit/                # Isolated component tests
├── integration/         # Multi-component interaction tests
├── security/            # Abuse, fuzzing, and boundary security tests
├── edge/                # Boundary value and unusual input tests
├── regression/          # Guards against previously fixed bugs
└── coverage/            # Targets specific uncovered code paths
```

## Directory Rules

- Every directory name is a **single lowercase word**. No hyphens, no underscores.
- Sub-directories inside each layer follow the same rule (e.g., `unit/core/`, `security/fuzzing/`).
- Each layer has a single responsibility. Never mix responsibilities across layers.

## Naming Rules

### Files
- All test files begin with `test_`.
- Names are lowercase, using `_` only to join exactly two words: `test_authority.py`, `test_caveat.py`.
- Names longer than two content words are rejected. Rename or split the file.

### Classes
- Use `Test` prefix followed by one PascalCase noun: `TestAuthority`, `TestCaveat`.
- One class per logical concern. Split when unrelated groups appear in the same class.

### Functions
- Use `test_` prefix followed by a short descriptive snake_case action: `test_expired_denied`, `test_valid_accepted`.
- No more than four words. Names like `test_validate_mandate_denies_subject_binding_mismatch` are rejected.

### Variables
- Keep names minimal and meaningful. Avoid long descriptive chains.
- Use `m`, `db`, `sig`, `pub`, `priv`, `chain` for common local names within a method.

## Layer Responsibilities

### `unit/`
- Tests a single class or function in isolation.
- All external dependencies are mocked.
- No DB sessions, no real network calls, no filesystem access.
- Subdirectories mirror the source package structure (e.g., `unit/core/`, `unit/mcp/`).

### `integration/`
- Tests interactions between two or more real components.
- May use real DB sessions (via `db_session` fixture from `mock/`).
- DB-dependent tests must use the `db_session` fixture and skip gracefully when DB is unavailable.

### `security/`
- Tests abuse scenarios, fuzzing, and access control enforcement.
- Subdirectories: `abuse/`, `fuzzing/`.
- Fuzz tests use `hypothesis` for property-based generation.
- All critical boundaries (authority, signing, delegation) must have security tests.

### `edge/`
- Tests boundary values, empty inputs, type mismatches, and unusual but valid inputs.
- Never use real DB. Mock everything.
- Subdirectories mirror the feature being tested (e.g., `edge/core/`, `edge/crypto/`).

### `regression/`
- Every test here captures a previously fixed bug.
- The test name documents the exact failure scenario.
- Never remove a regression test without an explicit trace to the original issue.

### `coverage/`
- Targets specific uncovered paths identified by coverage reports.
- Each file covers a specific module's uncovered branches.
- Do not inflate coverage artificially — every assertion must validate real behavior.

## Mock and Shared Data

### `mock/builders.py`
- Provides `mandate()`, `principal()`, and `mandate_data()` factory functions.
- Returns `SimpleNamespace` objects that are DB-model compatible for unit tests.
- Use these for all unit and edge tests that construct mandate or principal objects.
- **Never redefine mock objects inline in test files.**

### `mock/crypto.py`
- Provides the `crypto_fixtures` pytest fixture.
- Returns a dict with real EC key pairs and signed `Principal` DB rows.
- Requires `db_session` — only use in integration or security tests.

### `mock/database.py`
- Provides `in_memory_db_engine` and `db_session` fixtures.
- Uses PostgreSQL (not SQLite). Skips if DB is unavailable.
- Use only in integration and security tests that need real DB state.

### `mock/signing.py`
- Provides `sign_mandate_for_test()` and `sign_merkle_root_for_test()`.
- For use in crypto and security tests only.
- Raises `TypeError` or `ValueError` on invalid inputs — do not suppress these.

## Writing Tests

### Rules

1. **One assertion path per test.** Tests that assert multiple unrelated outcomes must be split.
2. **No `pass` statements in test bodies.** A test with only `pass` is deleted.
3. **No `try/except` inside test logic.** Use `pytest.raises()` to assert exceptions.
4. **No hardcoded UUIDs.** Use `uuid4()` for any ID generation.
5. **No inline fixture data.** Import from `mock/` or define as a local `@pytest.fixture`.
6. **No skips without a condition.** `pytest.skip()` is only allowed inside conditional blocks (e.g., missing DB, missing dependency).
7. **No sleeping.** Tests that require timing use `freezegun` or mock time directly.
8. **Mocks are reset per test.** Use `setup_method` or function-scoped fixtures, not class-scoped.

### Markers

Apply exactly one primary marker per test. The marker is derived from the directory (auto-applied by `conftest.py`). Do not manually decorate tests with `@pytest.mark.unit` unless outside a `unit/` directory.

Available markers:
- `unit` — auto-applied to `unit/`
- `integration` — auto-applied to `integration/`
- `security` — auto-applied to `security/`
- `edge` — auto-applied to `edge/`
- `regression` — auto-applied to `regression/`
- `coverage` — auto-applied to `coverage/`

Additional markers allowed:
- `slow` — for tests that take >5 seconds
- `property` — for Hypothesis-based fuzz tests

### Example: Unit Test

```python
from unittest.mock import Mock
from caracal.core.authority import AuthorityEvaluator, AuthorityReasonCode
from tests.mock.builders import mandate as build_mandate

class TestAuthority:
    def setup_method(self) -> None:
        self.db = Mock()
        self.ev = AuthorityEvaluator(self.db)

    def test_revoked_denied(self) -> None:
        m = build_mandate(revoked=True)
        d = self.ev.validate_mandate(mandate=m, requested_action="read", requested_resource="test")
        assert d.allowed is False
        assert d.reason_code == AuthorityReasonCode.MANDATE_REVOKED
```

### Example: Edge Test

```python
import pytest
from caracal.core.caveat_chain import CaveatChainError, parse_caveat

class TestParseCaveat:
    def test_empty_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("")
```

### Example: Security/Fuzz Test

```python
import pytest
from hypothesis import given, strategies as st
from caracal.core.crypto import verify_mandate_signature

class TestFuzzVerify:
    @given(sig=st.binary(), pub=st.text())
    def test_arbitrary_input_never_crashes(self, sig, pub) -> None:
        result = verify_mandate_signature({"k": "v"}, sig.hex(), pub)
        assert isinstance(result, bool)
```

## Adding Tests

1. Choose the correct layer (unit / integration / security / edge / regression / coverage).
2. Place the file in the subdirectory matching the source module being tested.
3. Name the file with at most two content words after `test_`.
4. Create a new `__init__.py` if the subdirectory is new.
5. Import shared objects from `tests/mock/`.
6. Run the new test file independently before committing.

## Modifying Tests

- Never edit a test to make it pass without fixing the underlying bug.
- When a test is wrong, delete and rewrite — do not patch.
- When a source API changes, update the test to reflect the new contract.

## Deleting Tests

- Delete tests that are: incorrect, redundant, flaky, or have no clear assertion.
- For regression tests, only delete if the originating bug is confirmed fixed and the test is fully replaced.
- Never delete a test to inflate coverage or reduce failure count.

## Coverage Targets

- Target >90% meaningful branch coverage across all non-enterprise source modules.
- Check coverage with: `uv run pytest --cov=caracal --cov-report=term-missing`
- Add targeted tests in `coverage/` for uncovered branches.
- Coverage inflation via catch-all skips, trivial assertions, or untested imports is forbidden.

## Running Tests

```bash
# All tests
uv run pytest

# Specific layer
uv run pytest tests/unit/
uv run pytest tests/security/

# By marker
uv run pytest -m unit
uv run pytest -m "security and not slow"

# With coverage
uv run pytest --cov=caracal --cov-report=term-missing

# Skip DB-dependent tests
uv run pytest -m "not integration"
```
