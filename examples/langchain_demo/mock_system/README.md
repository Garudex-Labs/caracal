# Mock System for Caracal Unified Demo

The mock system provides a structured, extensible JSON-based configuration system for simulating LLM responses, external API calls, and agent behaviors in the Caracal demo. This allows the demo to run without external API keys while maintaining realistic behavior and full Caracal integration.

## Architecture

The mock system consists of three main components:

### 1. MockConfigLoader (`config_loader.py`)
Loads and validates JSON-based mock configurations from files.

**Features:**
- JSON schema validation for configuration files
- Configuration caching for performance
- Support for scenarios, LLM responses, tool responses, and agent behaviors
- Extensible configuration structure

**Key Classes:**
- `MockConfigLoader`: Main loader class
- `MockConfig`: Complete scenario configuration
- `PromptPattern`: LLM prompt pattern matching configuration
- `ToolResponse`: Mock tool response configuration
- `AgentDecision`: Agent behavior configuration

### 2. ResponseMatcher (`response_matcher.py`)
Matches requests (prompts, tool calls) to mock responses using pattern matching.

**Features:**
- Multiple matching strategies: regex, exact, contains
- Variable substitution in response templates
- Confidence scoring for best match selection
- Tool call pattern matching with wildcards
- Compiled regex caching for performance

**Key Classes:**
- `ResponseMatcher`: Main matcher class
- `MatchResult`: Result of a pattern match operation

### 3. ScenarioEngine (`scenario_engine.py`)
Executes mock scenarios by coordinating configuration loading and response matching.

**Features:**
- Scenario lifecycle management
- LLM response generation with realistic delays
- Tool call execution with configurable delays
- Execution context tracking and history
- Agent decision configuration retrieval

**Key Classes:**
- `ScenarioEngine`: Main execution engine
- `ScenarioExecutionContext`: Tracks execution state and history

## Directory Structure

```
mock_system/
├── __init__.py                    # Package initialization
├── config_loader.py               # Configuration loading and validation
├── response_matcher.py            # Pattern matching for responses
├── scenario_engine.py             # Scenario execution engine
├── README.md                      # This file
└── configs/                       # Configuration files
    ├── scenarios/                 # Complete scenario configurations
    │   └── default.json          # Default quarterly review scenario
    ├── llm_responses/            # LLM response patterns
    │   ├── openai_responses.json
    │   └── gemini_responses.json
    ├── tool_responses/           # Tool response configurations
    │   ├── finance_api.json
    │   └── ops_api.json
    └── agent_behaviors/          # Agent behavior configurations
        ├── orchestrator.json
        ├── finance.json
        └── ops.json
```

## Configuration Format

### Scenario Configuration

A complete scenario configuration includes:

```json
{
  "version": "1.0",
  "scenario_id": "default",
  "description": "Standard quarterly review scenario",
  "llm_responses": {
    "openai": [
      {
        "pattern": ".*finance.*budget.*",
        "response_template": "Analysis: {findings}",
        "variables": {"findings": "Budget overruns detected"},
        "match_type": "regex"
      }
    ]
  },
  "tool_responses": {
    "finance_data": {
      "response": {"status": "success", "data": {...}},
      "delay_ms": 50,
      "error": null
    }
  },
  "agent_decisions": {
    "orchestrator": {
      "delegation_strategy": "parallel",
      "sub_agents": ["finance", "ops"],
      "max_iterations": 10
    }
  },
  "metadata": {
    "company": "TechCorp Industries",
    "quarter": "Q4"
  }
}
```

### Pattern Matching Types

1. **Exact Match**: Exact string comparison
   ```json
   {
     "pattern": "exact prompt text",
     "response_template": "exact response",
     "match_type": "exact"
   }
   ```

2. **Contains Match**: Substring search
   ```json
   {
     "pattern": "keyword",
     "response_template": "found keyword",
     "match_type": "contains"
   }
   ```

3. **Regex Match**: Regular expression with capture groups
   ```json
   {
     "pattern": "analyze (?P<dept>\\w+)",
     "response_template": "Analyzing {dept}",
     "match_type": "regex"
   }
   ```

### Variable Substitution

Response templates support variable substitution:

- **Simple**: `{variable_name}`
- **Lists**: `{list_var}` → "item1, item2, item3"
- **Dicts**: `{dict_var}` → "key1: value1, key2: value2"
- **Captured Groups**: Regex named groups are automatically available

## Usage Examples

### Loading a Scenario

```python
from mock_system import MockConfigLoader

loader = MockConfigLoader()
config = loader.load_scenario_config("default")

print(f"Loaded scenario: {config.scenario_id}")
print(f"LLM providers: {list(config.llm_responses.keys())}")
```

### Matching Prompts

```python
from mock_system import ResponseMatcher

matcher = ResponseMatcher()
result = matcher.match_prompt(
    prompt="analyze finance budget",
    patterns=config.llm_responses["openai"]
)

if result.matched:
    print(f"Response: {result.response}")
    print(f"Confidence: {result.confidence}")
```

### Executing a Scenario

```python
from mock_system import ScenarioEngine

engine = ScenarioEngine()
context = engine.start_execution("default")

# Generate LLM response
response = await engine.generate_llm_response(
    prompt="analyze finance budget",
    provider="openai"
)

# Execute tool call
result = await engine.execute_tool_call(
    tool_id="finance_data",
    tool_args={}
)

# Complete execution
engine.complete_execution()

# Get summary
summary = engine.get_execution_summary()
print(f"Total prompts: {summary['statistics']['total_prompts']}")
print(f"Total tool calls: {summary['statistics']['total_tool_calls']}")
```

## Extending the Mock System

### Adding a New Scenario

1. Create a new JSON file in `configs/scenarios/`:
   ```bash
   configs/scenarios/my_scenario.json
   ```

2. Define the scenario configuration following the schema

3. Load it:
   ```python
   config = loader.load_scenario_config("my_scenario")
   ```

### Adding LLM Response Patterns

Add patterns to existing provider files or create new ones:

```json
{
  "version": "1.0",
  "provider": "openai",
  "prompt_patterns": [
    {
      "pattern": "your pattern here",
      "response_template": "your response here",
      "match_type": "regex"
    }
  ]
}
```

### Adding Tool Responses

Add tool responses to existing API files or create new ones:

```json
{
  "version": "1.0",
  "api": "my_api",
  "my_tool": {
    "response": {"data": "mock data"},
    "delay_ms": 50,
    "error": null
  }
}
```

## Testing

The mock system includes comprehensive unit tests with >85% coverage target.

Run tests:
```bash
pytest tests/test_mock_system.py -v --cov=mock_system
```

See `tests/README.md` for detailed testing information.

## Design Principles

1. **Separation of Concerns**: Configuration, matching, and execution are separate
2. **Extensibility**: Easy to add new scenarios, patterns, and responses
3. **No Caracal Mocking**: Only external APIs are mocked; Caracal runs normally
4. **Realistic Behavior**: Simulates delays and realistic response patterns
5. **Type Safety**: Uses dataclasses and type hints throughout
6. **Validation**: JSON schema validation ensures configuration correctness

## Integration with Demo

The mock system integrates with the demo through:

1. **Mode Selection**: Environment variable determines mock vs real mode
2. **Provider Routing**: Caracal routes to mock providers in mock mode
3. **Transparent Operation**: Demo code doesn't change between modes
4. **Full Pipeline**: All Caracal components execute normally

## Future Enhancements

Potential improvements:

- [ ] Support for stateful scenarios (multi-turn conversations)
- [ ] Dynamic response generation based on context
- [ ] Response randomization for variety
- [ ] Performance profiling and optimization
- [ ] Visual scenario editor
- [ ] Scenario validation CLI tool
- [ ] Import/export scenarios in different formats
