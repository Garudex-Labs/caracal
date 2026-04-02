# SDK Tests

This directory contains test placeholders for Caracal SDKs.

## Structure

- `python/` - Python SDK tests (placeholder)
- `typescript/` - TypeScript SDK tests (placeholder)

## Status

SDK tests are not currently implemented as the SDK is subject to change.
Once the SDK stabilizes, tests should be added following the structure below.

## Recommended Structure

Each SDK language directory should contain:
- `unit/` - Unit tests for SDK components
- `integration/` - Integration tests with Caracal broker
- `README.md` - Language-specific test guidelines

## Test Categories

### 1. Unit Tests
Test SDK client methods in isolation:
- Client initialization and configuration
- Request formatting and serialization
- Response parsing and deserialization
- Error handling and validation
- Retry logic and timeouts

### 2. Integration Tests
Test SDK against live Caracal broker:
- Authority operations (create, get, list, delete)
- Mandate lifecycle (create, verify, revoke)
- Delegation workflows
- Secret management
- Error scenarios and edge cases

## Adding Tests

When the SDK is ready for testing:

1. Create `unit/` and `integration/` subdirectories in the language folder
2. Follow the test patterns from `tests/unit/` and `tests/integration/`
3. Use language-specific test frameworks:
   - Python: pytest
   - TypeScript: Jest or Vitest
4. Ensure tests can run against local Caracal broker
5. Update this README with specific test instructions
6. Add CI/CD integration for SDK tests

## Test Requirements

### Coverage
- Aim for 90%+ code coverage for SDK code
- All public API methods must have tests
- Error paths must be tested

### Documentation
- Each test should have clear docstrings
- Complex test scenarios should include comments
- Test names should be descriptive

### Performance
- Integration tests should complete in reasonable time
- Use fixtures to avoid redundant setup
- Consider parallel test execution

## Running Tests

Once implemented, tests should be runnable with:

```bash
# Python SDK
pytest tests/sdk/python/

# TypeScript SDK
npm test tests/sdk/typescript/
```

## Contributing

When adding SDK tests:
1. Follow existing test patterns in the main test suite
2. Ensure tests are isolated and repeatable
3. Document any special setup requirements
4. Update this README with new test categories
