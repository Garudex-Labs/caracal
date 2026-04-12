# Mock System Tests

This directory contains unit tests for the mock system components.

## Test Coverage

The test suite covers:

### MockConfigLoader (`test_mock_system.py::TestMockConfigLoader`)
- Initialization with default and custom paths
- Loading scenario configurations
- Configuration caching
- Error handling for missing/invalid configurations
- Parsing LLM responses, tool responses, and agent decisions
- Listing available scenarios

### ResponseMatcher (`test_mock_system.py::TestResponseMatcher`)
- Exact string matching
- Substring (contains) matching
- Regex pattern matching with captured groups
- Variable substitution (simple, list, dict)
- Best match selection from multiple patterns
- Tool call matching (direct, wildcard, regex)
- Pattern cache management

### ScenarioEngine (`test_mock_system.py::TestScenarioEngine`)
- Initialization with default and custom components
- Loading scenarios
- Starting and completing executions
- Generating LLM responses
- Executing tool calls
- Getting agent decisions
- Execution context tracking
- Summary generation

### ScenarioExecutionContext (`test_mock_system.py::TestScenarioExecutionContext`)
- Initialization
- Adding prompts and tool calls to history
- Marking execution as complete
- Converting to dictionary for serialization

## Running Tests

### Run all tests:
```bash
pytest tests/test_mock_system.py -v
```

### Run with coverage:
```bash
pytest tests/test_mock_system.py --cov=mock_system --cov-report=term-missing
```

### Run specific test class:
```bash
pytest tests/test_mock_system.py::TestMockConfigLoader -v
```

### Run specific test:
```bash
pytest tests/test_mock_system.py::TestMockConfigLoader::test_load_scenario_config_success -v
```

## Test Requirements

The tests require:
- pytest >= 7.0.0
- pytest-asyncio >= 0.21.0
- pytest-cov >= 4.0.0 (for coverage)
- jsonschema >= 4.0.0

These are included in `requirements.txt`.

## Coverage Target

The target coverage for mock system components is **>85%**.

## Validation Script

For quick validation without pytest, run:
```bash
python validate_mock_system.py
```

This script performs basic smoke tests to verify the mock system is working correctly.
