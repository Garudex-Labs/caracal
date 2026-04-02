# Test Infrastructure Validation

This document describes the validation scripts available to verify the test infrastructure is properly configured and functional.

## Overview

The test infrastructure includes several validation scripts that check different aspects of the testing setup:

1. **Structure Validation** - Verifies directory structure and file organization
2. **Execution Validation** - Verifies tests can be discovered and executed
3. **Coverage Validation** - Verifies code coverage measurement works
4. **CI/CD Validation** - Verifies GitHub Actions workflow configuration

## Validation Scripts

### Individual Validation Scripts

#### 1. Structure Validation

```bash
python tests/validate_structure.py
```

Checks:
- All required directories exist
- `__init__.py` files are present
- Configuration files exist
- Test files follow naming conventions
- SDK README files are present
- Fixture and mock directories have content

#### 2. Execution Validation

```bash
python tests/validate_execution.py
```

Checks:
- pytest can discover tests
- Unit tests can be executed
- Integration tests can be executed
- Pytest markers are properly configured
- Async test support is available

#### 3. Coverage Validation

```bash
python tests/validate_coverage.py
```

Checks:
- Coverage package is installed
- pytest-cov plugin is available
- Coverage configuration exists in pyproject.toml
- Coverage can be measured
- Coverage reports can be generated (HTML, XML, terminal)
- Coverage threshold is configured

#### 4. CI/CD Validation

```bash
python tests/validate_cicd.py
```

Checks:
- GitHub Actions workflow file exists
- Workflow structure is valid
- Multiple Python versions are tested
- Required services (PostgreSQL, Redis) are configured
- All test categories are executed
- Coverage measurement is included
- Test artifacts are uploaded

### Master Validation Script

Run all validations at once:

```bash
python tests/validate_all.py
```

This script runs all individual validation scripts and provides a summary of results.

## Running Validations

### Prerequisites

Ensure you have the development dependencies installed:

```bash
uv pip install -e ".[dev]"
```

### Quick Validation

To quickly validate the entire test infrastructure:

```bash
# Run all validations
python tests/validate_all.py

# Or run individual validations
python tests/validate_structure.py
python tests/validate_execution.py
python tests/validate_coverage.py
python tests/validate_cicd.py
```

### Using uv

If you prefer to use uv:

```bash
uv run python tests/validate_all.py
```

## Expected Output

### Successful Validation

When all checks pass, you'll see output like:

```
======================================================================
Test Infrastructure - Complete Validation Suite
======================================================================

======================================================================
Running: Structure Validation
======================================================================
Checking: Directory Structure
  ✓ PASSED
Checking: __init__.py Files
  ✓ PASSED
...

======================================================================
Validation Summary
======================================================================
Structure Validation................................ ✓ PASSED
Execution Validation................................ ✓ PASSED
Coverage Validation................................. ✓ PASSED
CI/CD Validation.................................... ✓ PASSED
======================================================================

✓ All validations passed! Test infrastructure is ready.
======================================================================
```

### Failed Validation

If any checks fail, you'll see detailed error messages:

```
Checking: Directory Structure
  ✗ FAILED
    - Missing directory: tests/unit/core
    - Missing directory: tests/integration/api
```

## Troubleshooting

### Common Issues

#### Missing Dependencies

If validation fails due to missing packages:

```bash
uv pip install -e ".[dev]"
```

#### Missing Directories

If structure validation fails, ensure all directories were created:

```bash
# Check if tests directory exists
ls -la tests/

# Recreate missing directories if needed
mkdir -p tests/unit/core
mkdir -p tests/integration/api
```

#### Test Discovery Fails

If pytest cannot discover tests:

1. Check that test files start with `test_`
2. Verify `__init__.py` files exist in test directories
3. Ensure pytest is installed: `uv run python -c "import pytest"`

#### Coverage Measurement Fails

If coverage validation fails:

1. Verify pytest-cov is installed: `uv run python -c "import pytest_cov"`
2. Check pyproject.toml has `[tool.coverage.run]` section
3. Ensure coverage package is installed: `uv run python -c "import coverage"`

## Integration with CI/CD

These validation scripts can be run in CI/CD pipelines to ensure the test infrastructure remains properly configured:

```yaml
- name: Validate test infrastructure
  run: |
    python tests/validate_all.py
```

## Validation Checklist

Use this checklist to manually verify the test infrastructure:

- [ ] All test directories exist
- [ ] Test files follow naming conventions (`test_*.py`)
- [ ] `__init__.py` files present in all test packages
- [ ] `conftest.py` exists with global fixtures
- [ ] `pyproject.toml` has pytest and coverage configuration
- [ ] GitHub Actions workflow exists (`.github/workflows/test.yml`)
- [ ] Workflow tests multiple Python versions
- [ ] Workflow includes PostgreSQL and Redis services
- [ ] All test categories are executed (unit, integration, e2e, security)
- [ ] Coverage measurement is configured
- [ ] Coverage threshold is set (90%)
- [ ] Test artifacts are uploaded

## Next Steps

After validation passes:

1. **Write Tests**: Start implementing actual test cases in the test files
2. **Run Tests**: Execute tests using `pytest` or `uv run pytest`
3. **Check Coverage**: Monitor coverage with `pytest --cov=caracal --cov-report=html`
4. **Review CI/CD**: Push changes and verify GitHub Actions workflow runs successfully

## Additional Resources

- [pytest Documentation](https://docs.pytest.org/)
- [pytest-cov Documentation](https://pytest-cov.readthedocs.io/)
- [Coverage.py Documentation](https://coverage.readthedocs.io/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Hypothesis Documentation](https://hypothesis.readthedocs.io/) (for property-based testing)

## Support

If you encounter issues with the validation scripts:

1. Check the error messages for specific problems
2. Review the troubleshooting section above
3. Verify all dependencies are installed
4. Consult the test infrastructure design document

## Maintenance

These validation scripts should be updated when:

- New test directories are added
- Test configuration changes
- CI/CD workflow is modified
- New testing tools are introduced

Keep the validation scripts in sync with the actual test infrastructure to ensure they remain accurate and useful.
