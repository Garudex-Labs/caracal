"""Validate mock system implementation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Test 1: Import all modules
print("Test 1: Importing modules...")
from mock_system.config_loader import MockConfigLoader
from mock_system.response_matcher import ResponseMatcher
from mock_system.scenario_engine import ScenarioEngine
print("PASS: All modules imported successfully")

# Test 2: Initialize components
print("\nTest 2: Initializing components...")
loader = MockConfigLoader()
matcher = ResponseMatcher()
engine = ScenarioEngine()
print("PASS: All components initialized")

# Test 3: List scenarios
print("\nTest 3: Listing scenarios...")
scenarios = loader.list_available_scenarios()
print(f"PASS: Found {len(scenarios)} scenario(s): {scenarios}")

# Test 4: Load default scenario
print("\nTest 4: Loading default scenario...")
if "default" in scenarios:
    config = loader.load_scenario_config("default")
    print(f"PASS: Loaded scenario '{config.scenario_id}'")
    print(f"  - LLM providers: {list(config.llm_responses.keys())}")
    print(f"  - Tool responses: {len(config.tool_responses)}")
    print(f"  - Agent decisions: {list(config.agent_decisions.keys())}")
else:
    print("SKIP: No default scenario found")

print("\n" + "="*50)
print("All validation tests passed!")
print("="*50)
