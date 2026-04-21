# Caracal Test Suite

This directory contains the comprehensive test suite for Caracal Core.

## Directory Structure

```
tests/
├── unit/              # Unit tests (isolated component testing)
│   ├── cli/          # CLI command tests
│   ├── config/       # Configuration tests
│   ├── core/         # Core logic tests
│   ├── db/           # Database layer tests
│   ├── deployment/   # Deployment tests
│   ├── enterprise/   # Enterprise feature tests
│   ├── flow/         # Flow UI tests
│   ├── mcp/          # MCP adapter tests
│   ├── merkle/       # Merkle tree tests
│   ├── monitoring/   # Monitoring tests
│   ├── provider/     # Provider tests
│   ├── redis/        # Redis integration tests
│   ├── runtime/      # Runtime tests
│   └── storage/      # Storage tests
│
├── integration/       # Integration tests (multi-component)
│   ├── api/          # API integration tests
│   ├── core/         # Core integration tests
│   ├── db/           # Database integration tests
│   ├── deployment/   # Deployment integration tests
│   ├── enterprise/   # Enterprise integration tests
│   ├── mcp/          # MCP integration tests
│   ├── merkle/       # Merkle integration tests
│   ├── monitoring/   # Monitoring integration tests
│   └── redis/        # Redis integration tests
│
├── e2e/              # End-to-end tests (full system)
│   ├── cli/          # CLI workflow tests
│   ├── enterprise/   # Enterprise workflow tests
│   ├── flow/         # Flow UI workflow tests
│   └── workflows/    # Complete workflow tests
│
├── security/         # Security-focused tests
│   ├── abuse/        # Abuse case tests
│   ├── fuzzing/      # Fuzz testing
│   └── regression/   # Security regression tests
│
├── sdk/              # SDK tests (placeholder)
│   ├── python/       # Python SDK tests
│   └── typescript/   # TypeScript SDK tests
│
├── fixtures/         # Reusable shared fixtures
│
├── conftest.py       # Global pytest configuration
├── test_simple.py    # Basic sanity tests
│
└── validate_*.py     # Test infrastructure validation scripts
```

## Running Tests

### Prerequisites

Install development dependencies:
```bash
pip install -e ".[dev]"
# or with uv:
uv pip install -e ".[dev]"
```

### Quick Start

```bash
# Run all unit tests
pytest -m unit

# Run specific test file
pytest tests/test_simple.py -v

# Run with coverage
pytest -m unit --cov=caracal --cov-report=term-missing

# Run all tests (like CI)
pytest --cov=caracal --cov-report=html
```

### Test Categories

Tests are organized by markers:

- `unit` - Unit tests (isolated component testing)
- `integration` - Integration tests (multi-component)
- `e2e` - End-to-end tests (full system)
- `security` - Security-focused tests
- `property` - Property-based tests (using Hypothesis)
- `asyncio` - Async tests
- `slow` - Slow-running tests

Run specific categories:
```bash
pytest -m unit           # Unit tests only
pytest -m integration    # Integration tests only
pytest -m e2e           # E2E tests only
pytest -m security      # Security tests only
```

### Coverage

Generate coverage reports:
```bash
# Terminal report
pytest --cov=caracal --cov-report=term-missing

# HTML report
pytest --cov=caracal --cov-report=html
# Open htmlcov/index.html in browser

# XML report (for CI)
pytest --cov=caracal --cov-report=xml
```

Check coverage threshold:
```bash
coverage report --fail-under=10  # Current threshold
```

## Writing Tests

### Test File Naming

- Test files must start with `test_`
- Example: `test_authority.py`, `test_mandate.py`

### Test Function Naming

- Test functions must start with `test_`
- Use descriptive names: `test_create_authority_success`

### Test Structure

Follow the Arrange-Act-Assert pattern:

```python
import pytest

@pytest.mark.unit
def test_my_feature():
    """Test description."""
    # Arrange - Set up test data
    expected = "value"
    
    # Act - Execute the code under test
    result = my_function()
    
    # Assert - Verify the results
    assert result == expected
```

### Using Fixtures

```python
@pytest.mark.unit
def test_with_fixture(db_session):
    """Test using database fixture."""
    # Fixture is automatically provided
    user = db_session.query(User).first()
    assert user is not None
```

### Property-Based Testing

```python
from hypothesis import given, strategies as st

@pytest.mark.unit
@pytest.mark.property
class TestAuthorityProperties:
    @given(st.text(min_size=1, max_size=100))
    def test_authority_name_preserved(self, name):
        """Property: authority name must be preserved."""
        authority = Authority.create(name=name)
        assert authority.name == name
```

## Shared Fixtures

Located in `fixtures/`:
- `crypto.py` - Cryptographic fixtures
- `database.py` - Database fixtures

## Validation Scripts

### Test Infrastructure Validation

Run validation scripts to verify test infrastructure:

```bash
# Validate all
python tests/validate_all.py

# Individual validations
python tests/validate_structure.py    # Directory structure
python tests/validate_execution.py    # Test execution
python tests/validate_coverage.py     # Coverage measurement
python tests/validate_cicd.py         # CI/CD configuration
```

### Simulate CI Locally

```bash
python tests/simulate_ci.py
```

This simulates the CI workflow locally to catch issues before pushing.

## CI/CD Integration

The GitHub Actions workflow (`.github/workflows/test.yml`) runs:

1. Unit tests with coverage
2. Integration tests with coverage
3. Security tests with coverage
4. E2E tests with coverage
5. Coverage threshold check (currently 10%)
6. Coverage report generation

### Current Status

- ✓ Test infrastructure complete
- ✓ Directory structure in place
- ✓ CI/CD workflow configured
- ⚠️ Test implementations are placeholders
- ⚠️ Coverage threshold at 10% (target: 90%)

## Troubleshooting

### Tests Not Found

- Ensure test files start with `test_`
- Check `__init__.py` exists in test directories
- Verify pytest is installed: `python -c "import pytest"`

### Import Errors

- Install package: `pip install -e .`
- Check PYTHONPATH includes project root
- Install dev dependencies: `pip install -e ".[dev]"`

### Coverage Issues

- Install pytest-cov: `pip install pytest-cov`
- Check `pyproject.toml` coverage configuration
- Verify source paths are correct

### Database Tests Failing

- Ensure PostgreSQL is running
- Check DATABASE_URL environment variable
- Run database migrations: `caracal db init`

### Redis Tests Failing

- Ensure Redis is running
- Check REDIS_URL environment variable
- Verify Redis connection: `redis-cli ping`

## Best Practices

1. **Write tests first** - TDD approach when possible
2. **Keep tests isolated** - Each test should be independent
3. **Use fixtures** - Reuse common setup code
4. **Mock external dependencies** - Don't rely on external services
5. **Test edge cases** - Include boundary conditions
6. **Use descriptive names** - Test names should explain what they test
7. **Keep tests fast** - Unit tests should run in milliseconds
8. **Document complex tests** - Add docstrings explaining the test
9. **Use property-based testing** - For testing invariants
10. **Monitor coverage** - Aim for 90%+ coverage

## Contributing

When adding new features:

1. Write tests for new code
2. Ensure tests pass locally
3. Check coverage hasn't decreased
4. Run validation scripts
5. Update documentation if needed

## Resources

- [pytest Documentation](https://docs.pytest.org/)
- [pytest-cov Documentation](https://pytest-cov.readthedocs.io/)
- [Hypothesis Documentation](https://hypothesis.readthedocs.io/)
- [Coverage.py Documentation](https://coverage.readthedocs.io/)

## Support

For issues with tests:
1. Check troubleshooting section above
2. Review test infrastructure validation
3. Consult VALIDATION.md for detailed validation info
4. Check CI logs for specific errors

## Next Steps

1. Implement actual test cases (replace `pass` statements)
2. Increase test coverage to 90%+
3. Add comprehensive integration tests
4. Implement security test cases
5. Add E2E workflow tests
6. Restore 90% coverage threshold in CI
