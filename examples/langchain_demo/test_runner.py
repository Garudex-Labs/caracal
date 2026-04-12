#!/usr/bin/env python3
"""Simple test runner to verify mock system functionality."""

import sys
from pathlib import Path

# Add current directory to path
sys.path.insert(0, str(Path(__file__).parent))

def test_imports():
    """Test that all modules can be imported."""
    print("Testing imports...")
    try:
        from mock_system.config_loader import MockConfigLoader, MockConfig
        from mock_system.response_matcher import ResponseMatcher, MatchResult
        from mock_system.scenario_engine import ScenarioEngine, ScenarioExecutionContext
        print("✓ All imports successful")
        return True
    except Exception as e:
        print(f"✗ Import failed: {e}")
        return False

def test_config_loader():
    """Test MockConfigLoader basic functionality."""
    print("\nTesting MockConfigLoader...")
    try:
        from mock_system.config_loader import MockConfigLoader
        
        loader = MockConfigLoader()
        print(f"  ✓ Loader initialized with path: {loader.config_base_path}")
        
        # Test listing scenarios
        scenarios = loader.list_available_scenarios()
        print(f"  ✓ Found {len(scenarios)} scenarios: {scenarios}")
        
        # Test loading default scenario
        if "default" in scenarios:
            config = loader.load_scenario_config("default")
            print(f"  ✓ Loaded scenario: {config.scenario_id}")
            print(f"    - Version: {config.version}")
            print(f"    - Description: {config.description}")
            print(f"    - LLM providers: {list(config.llm_responses.keys())}")
            print(f"    - Tool responses: {len(config.tool_responses)}")
            print(f"    - Agent decisions: {list(config.agent_decisions.keys())}")
        
        return True
    except Exception as e:
        print(f"✗ ConfigLoader test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_response_matcher():
    """Test ResponseMatcher basic functionality."""
    print("\nTesting ResponseMatcher...")
    try:
        from mock_system.response_matcher import ResponseMatcher
        from mock_system.config_loader import PromptPattern
        
        matcher = ResponseMatcher()
        print("  ✓ Matcher initialized")
        
        # Test exact match
        pattern = PromptPattern(
            pattern="test prompt",
            response_template="test response",
            match_type="exact"
        )
        result = matcher.match_prompt("test prompt", [pattern])
        print(f"  ✓ Exact match: matched={result.matched}, confidence={result.confidence}")
        
        # Test regex match
        pattern = PromptPattern(
            pattern=r"analyze (?P<dept>\w+)",
            response_template="Analyzing {dept}",
            match_type="regex"
        )
        result = matcher.match_prompt("analyze finance", [pattern])
        print(f"  ✓ Regex match: matched={result.matched}, response='{result.response}'")
        
        return True
    except Exception as e:
        print(f"✗ ResponseMatcher test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_scenario_engine():
    """Test ScenarioEngine basic functionality."""
    print("\nTesting ScenarioEngine...")
    try:
        from mock_system.scenario_engine import ScenarioEngine
        
        engine = ScenarioEngine()
        print("  ✓ Engine initialized")
        
        # List scenarios
        scenarios = engine.list_available_scenarios()
        print(f"  ✓ Available scenarios: {scenarios}")
        
        # Load and start execution
        if "default" in scenarios:
            config = engine.load_scenario("default")
            print(f"  ✓ Loaded scenario: {config.scenario_id}")
            
            context = engine.start_execution("default")
            print(f"  ✓ Started execution: {context.scenario_id}")
            
            # Get agent decision
            decision = engine.get_agent_decision("orchestrator")
            if decision:
                print(f"  ✓ Agent decision: {decision['delegation_strategy']}")
            
            # Complete execution
            engine.complete_execution()
            print(f"  ✓ Execution completed: {context.is_complete}")
        
        return True
    except Exception as e:
        print(f"✗ ScenarioEngine test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Run all tests."""
    print("=" * 60)
    print("Mock System Test Runner")
    print("=" * 60)
    
    results = []
    
    results.append(("Imports", test_imports()))
    results.append(("ConfigLoader", test_config_loader()))
    results.append(("ResponseMatcher", test_response_matcher()))
    results.append(("ScenarioEngine", test_scenario_engine()))
    
    print("\n" + "=" * 60)
    print("Test Results Summary")
    print("=" * 60)
    
    for name, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status}: {name}")
    
    total = len(results)
    passed = sum(1 for _, p in results if p)
    print(f"\nTotal: {passed}/{total} tests passed")
    
    return 0 if all(p for _, p in results) else 1

if __name__ == "__main__":
    sys.exit(main())
