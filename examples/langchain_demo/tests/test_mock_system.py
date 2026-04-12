"""
Unit tests for mock system components.

Tests cover:
- MockConfigLoader: Loading and validating configurations
- ResponseMatcher: Pattern matching for prompts and tool calls
- ScenarioEngine: Scenario execution and tracking
"""

import json
import pytest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from mock_system.config_loader import (
    MockConfigLoader,
    MockConfig,
    PromptPattern,
    ToolResponse,
    AgentDecision,
    MockConfigError
)
from mock_system.response_matcher import ResponseMatcher, MatchResult
from mock_system.scenario_engine import ScenarioEngine, ScenarioExecutionContext


class TestMockConfigLoader:
    """Tests for MockConfigLoader."""
    
    def test_init_default_path(self):
        """Test initialization with default config path."""
        loader = MockConfigLoader()
        assert loader.config_base_path.name == "configs"
        assert loader._config_cache == {}
    
    def test_init_custom_path(self):
        """Test initialization with custom config path."""
        custom_path = Path("/tmp/custom_configs")
        loader = MockConfigLoader(config_base_path=custom_path)
        assert loader.config_base_path == custom_path
    
    def test_load_scenario_config_success(self):
        """Test successful scenario configuration loading."""
        loader = MockConfigLoader()
        
        # Load the default scenario we created
        config = loader.load_scenario_config("default")
        
        assert isinstance(config, MockConfig)
        assert config.version == "1.0"
        assert config.scenario_id == "default"
        assert config.description != ""
        assert "openai" in config.llm_responses
        assert len(config.tool_responses) > 0
        assert "orchestrator" in config.agent_decisions
    
    def test_load_scenario_config_caching(self):
        """Test that configurations are cached."""
        loader = MockConfigLoader()
        
        # Load twice
        config1 = loader.load_scenario_config("default")
        config2 = loader.load_scenario_config("default")
        
        # Should be the same object (cached)
        assert config1 is config2
    
    def test_load_scenario_config_not_found(self):
        """Test loading non-existent scenario."""
        loader = MockConfigLoader()
        
        with pytest.raises(MockConfigError, match="not found"):
            loader.load_scenario_config("nonexistent_scenario")
    
    def test_load_scenario_config_invalid_json(self):
        """Test loading scenario with invalid JSON."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir) / "scenarios"
            config_dir.mkdir(parents=True)
            
            # Create invalid JSON file
            invalid_file = config_dir / "invalid.json"
            invalid_file.write_text("{ invalid json }")
            
            loader = MockConfigLoader(config_base_path=Path(tmpdir))
            
            with pytest.raises(MockConfigError, match="Invalid JSON"):
                loader.load_scenario_config("invalid")
    
    def test_parse_config_llm_responses(self):
        """Test parsing LLM responses from config data."""
        loader = MockConfigLoader()
        
        config_data = {
            "version": "1.0",
            "scenario_id": "test",
            "description": "Test scenario",
            "llm_responses": {
                "openai": [
                    {
                        "pattern": "test.*",
                        "response_template": "Test response",
                        "variables": {"key": "value"},
                        "match_type": "regex"
                    }
                ]
            }
        }
        
        config = loader._parse_config(config_data)
        
        assert "openai" in config.llm_responses
        assert len(config.llm_responses["openai"]) == 1
        pattern = config.llm_responses["openai"][0]
        assert isinstance(pattern, PromptPattern)
        assert pattern.pattern == "test.*"
        assert pattern.response_template == "Test response"
        assert pattern.variables == {"key": "value"}
        assert pattern.match_type == "regex"
    
    def test_parse_config_tool_responses(self):
        """Test parsing tool responses from config data."""
        loader = MockConfigLoader()
        
        config_data = {
            "version": "1.0",
            "scenario_id": "test",
            "description": "Test scenario",
            "tool_responses": {
                "test_tool": {
                    "response": {"data": "test"},
                    "delay_ms": 100,
                    "error": None
                }
            }
        }
        
        config = loader._parse_config(config_data)
        
        assert "test_tool" in config.tool_responses
        tool_response = config.tool_responses["test_tool"]
        assert isinstance(tool_response, ToolResponse)
        assert tool_response.tool_id == "test_tool"
        assert tool_response.response == {"data": "test"}
        assert tool_response.delay_ms == 100
        assert tool_response.error is None
    
    def test_parse_config_agent_decisions(self):
        """Test parsing agent decisions from config data."""
        loader = MockConfigLoader()
        
        config_data = {
            "version": "1.0",
            "scenario_id": "test",
            "description": "Test scenario",
            "agent_decisions": {
                "test_agent": {
                    "delegation_strategy": "parallel",
                    "sub_agents": ["agent1", "agent2"],
                    "max_iterations": 5
                }
            }
        }
        
        config = loader._parse_config(config_data)
        
        assert "test_agent" in config.agent_decisions
        decision = config.agent_decisions["test_agent"]
        assert isinstance(decision, AgentDecision)
        assert decision.agent_id == "test_agent"
        assert decision.delegation_strategy == "parallel"
        assert decision.sub_agents == ["agent1", "agent2"]
        assert decision.max_iterations == 5
    
    def test_clear_cache(self):
        """Test cache clearing."""
        loader = MockConfigLoader()
        
        # Load and cache
        loader.load_scenario_config("default")
        assert len(loader._config_cache) > 0
        
        # Clear cache
        loader.clear_cache()
        assert len(loader._config_cache) == 0
    
    def test_list_available_scenarios(self):
        """Test listing available scenarios."""
        loader = MockConfigLoader()
        
        scenarios = loader.list_available_scenarios()
        
        assert isinstance(scenarios, list)
        assert "default" in scenarios


class TestResponseMatcher:
    """Tests for ResponseMatcher."""
    
    def test_init(self):
        """Test initialization."""
        matcher = ResponseMatcher()
        assert matcher._compiled_patterns == {}
    
    def test_match_exact(self):
        """Test exact string matching."""
        matcher = ResponseMatcher()
        
        pattern = PromptPattern(
            pattern="exact prompt",
            response_template="exact response",
            match_type="exact"
        )
        
        # Should match
        result = matcher.match_prompt("exact prompt", [pattern])
        assert result.matched is True
        assert result.response == "exact response"
        assert result.confidence == 1.0
        
        # Should not match
        result = matcher.match_prompt("different prompt", [pattern])
        assert result.matched is False
    
    def test_match_contains(self):
        """Test substring matching."""
        matcher = ResponseMatcher()
        
        pattern = PromptPattern(
            pattern="keyword",
            response_template="found keyword",
            match_type="contains"
        )
        
        # Should match
        result = matcher.match_prompt("this has keyword in it", [pattern])
        assert result.matched is True
        assert result.response == "found keyword"
        assert result.confidence > 0
        
        # Should not match
        result = matcher.match_prompt("no match here", [pattern])
        assert result.matched is False
    
    def test_match_regex(self):
        """Test regex pattern matching."""
        matcher = ResponseMatcher()
        
        pattern = PromptPattern(
            pattern=r"test\s+\d+",
            response_template="matched regex",
            match_type="regex"
        )
        
        # Should match
        result = matcher.match_prompt("test 123", [pattern])
        assert result.matched is True
        assert result.response == "matched regex"
        
        # Should not match
        result = matcher.match_prompt("test abc", [pattern])
        assert result.matched is False
    
    def test_match_regex_with_groups(self):
        """Test regex matching with captured groups."""
        matcher = ResponseMatcher()
        
        pattern = PromptPattern(
            pattern=r"analyze (?P<department>\w+)",
            response_template="Analyzing {department}",
            match_type="regex"
        )
        
        result = matcher.match_prompt("analyze finance", [pattern])
        assert result.matched is True
        assert result.response == "Analyzing finance"
        assert "department" in result.variables
        assert result.variables["department"] == "finance"
    
    def test_substitute_variables_simple(self):
        """Test simple variable substitution."""
        matcher = ResponseMatcher()
        
        template = "Hello {name}, you are {age} years old"
        variables = {"name": "Alice", "age": 30}
        
        result = matcher._substitute_variables(template, variables)
        assert result == "Hello Alice, you are 30 years old"
    
    def test_substitute_variables_list(self):
        """Test list variable substitution."""
        matcher = ResponseMatcher()
        
        template = "Items: {items}"
        variables = {"items": ["apple", "banana", "cherry"]}
        
        result = matcher._substitute_variables(template, variables)
        assert result == "Items: apple, banana, cherry"
    
    def test_substitute_variables_dict(self):
        """Test dict variable substitution."""
        matcher = ResponseMatcher()
        
        template = "Config: {config}"
        variables = {"config": {"key1": "value1", "key2": "value2"}}
        
        result = matcher._substitute_variables(template, variables)
        assert "key1: value1" in result
        assert "key2: value2" in result
    
    def test_match_prompt_best_match(self):
        """Test that best match is selected from multiple patterns."""
        matcher = ResponseMatcher()
        
        patterns = [
            PromptPattern(
                pattern="test",
                response_template="contains match",
                match_type="contains"
            ),
            PromptPattern(
                pattern="test prompt",
                response_template="exact match",
                match_type="exact"
            )
        ]
        
        # Exact match should win
        result = matcher.match_prompt("test prompt", patterns)
        assert result.response == "exact match"
        assert result.confidence == 1.0
    
    def test_match_tool_call_direct(self):
        """Test direct tool call matching."""
        matcher = ResponseMatcher()
        
        tool_responses = {
            "finance_data": ToolResponse(
                tool_id="finance_data",
                response={"data": "test"}
            )
        }
        
        result = matcher.match_tool_call("finance_data", {}, tool_responses)
        assert result is not None
        assert result.tool_id == "finance_data"
        assert result.response == {"data": "test"}
    
    def test_match_tool_call_wildcard(self):
        """Test wildcard tool call matching."""
        matcher = ResponseMatcher()
        
        tool_responses = {
            "finance_*": ToolResponse(
                tool_id="finance_*",
                response={"data": "wildcard"}
            )
        }
        
        result = matcher.match_tool_call("finance_data", {}, tool_responses)
        assert result is not None
        assert result.response == {"data": "wildcard"}
    
    def test_match_tool_call_not_found(self):
        """Test tool call matching when no match found."""
        matcher = ResponseMatcher()
        
        tool_responses = {
            "other_tool": ToolResponse(
                tool_id="other_tool",
                response={"data": "test"}
            )
        }
        
        result = matcher.match_tool_call("finance_data", {}, tool_responses)
        assert result is None
    
    def test_clear_cache(self):
        """Test clearing compiled regex cache."""
        matcher = ResponseMatcher()
        
        pattern = PromptPattern(
            pattern=r"test\s+\d+",
            response_template="test",
            match_type="regex"
        )
        
        # Trigger compilation
        matcher.match_prompt("test 123", [pattern])
        assert len(matcher._compiled_patterns) > 0
        
        # Clear cache
        matcher.clear_cache()
        assert len(matcher._compiled_patterns) == 0


class TestScenarioEngine:
    """Tests for ScenarioEngine."""
    
    def test_init_default(self):
        """Test initialization with defaults."""
        engine = ScenarioEngine()
        assert engine.config_loader is not None
        assert engine.response_matcher is not None
        assert engine._current_config is None
        assert engine._current_context is None
    
    def test_init_custom(self):
        """Test initialization with custom components."""
        loader = MockConfigLoader()
        matcher = ResponseMatcher()
        
        engine = ScenarioEngine(config_loader=loader, response_matcher=matcher)
        assert engine.config_loader is loader
        assert engine.response_matcher is matcher
    
    def test_load_scenario(self):
        """Test loading a scenario."""
        engine = ScenarioEngine()
        
        config = engine.load_scenario("default")
        
        assert isinstance(config, MockConfig)
        assert config.scenario_id == "default"
        assert engine._current_config is config
    
    def test_start_execution(self):
        """Test starting scenario execution."""
        engine = ScenarioEngine()
        
        context = engine.start_execution("default")
        
        assert isinstance(context, ScenarioExecutionContext)
        assert context.scenario_id == "default"
        assert context.is_complete is False
        assert engine._current_context is context
    
    @pytest.mark.asyncio
    async def test_generate_llm_response(self):
        """Test generating LLM response."""
        engine = ScenarioEngine()
        engine.start_execution("default")
        
        response = await engine.generate_llm_response(
            prompt="analyze finance budget data",
            provider="openai"
        )
        
        assert isinstance(response, str)
        assert len(response) > 0
        
        # Check context was updated
        context = engine.get_execution_context()
        assert context.total_prompts == 1
        assert len(context.prompt_history) == 1
    
    @pytest.mark.asyncio
    async def test_generate_llm_response_no_scenario(self):
        """Test generating LLM response without loaded scenario."""
        engine = ScenarioEngine()
        
        with pytest.raises(RuntimeError, match="No scenario loaded"):
            await engine.generate_llm_response("test prompt")
    
    @pytest.mark.asyncio
    async def test_execute_tool_call(self):
        """Test executing tool call."""
        engine = ScenarioEngine()
        engine.start_execution("default")
        
        response = await engine.execute_tool_call(
            tool_id="finance_data",
            tool_args={}
        )
        
        assert isinstance(response, dict)
        assert "status" in response or "data" in response
        
        # Check context was updated
        context = engine.get_execution_context()
        assert context.total_tool_calls == 1
        assert len(context.tool_call_history) == 1
    
    @pytest.mark.asyncio
    async def test_execute_tool_call_no_scenario(self):
        """Test executing tool call without loaded scenario."""
        engine = ScenarioEngine()
        
        with pytest.raises(RuntimeError, match="No scenario loaded"):
            await engine.execute_tool_call("test_tool", {})
    
    def test_get_agent_decision(self):
        """Test getting agent decision configuration."""
        engine = ScenarioEngine()
        engine.load_scenario("default")
        
        decision = engine.get_agent_decision("orchestrator")
        
        assert decision is not None
        assert decision["agent_id"] == "orchestrator"
        assert "delegation_strategy" in decision
        assert "sub_agents" in decision
    
    def test_get_agent_decision_not_found(self):
        """Test getting non-existent agent decision."""
        engine = ScenarioEngine()
        engine.load_scenario("default")
        
        decision = engine.get_agent_decision("nonexistent_agent")
        assert decision is None
    
    def test_complete_execution(self):
        """Test completing execution."""
        engine = ScenarioEngine()
        context = engine.start_execution("default")
        
        assert context.is_complete is False
        
        engine.complete_execution()
        
        assert context.is_complete is True
        assert context.completed_at is not None
    
    def test_complete_execution_with_error(self):
        """Test completing execution with error."""
        engine = ScenarioEngine()
        context = engine.start_execution("default")
        
        engine.complete_execution(error="Test error")
        
        assert context.is_complete is True
        assert context.error == "Test error"
    
    def test_get_execution_summary(self):
        """Test getting execution summary."""
        engine = ScenarioEngine()
        engine.start_execution("default")
        
        summary = engine.get_execution_summary()
        
        assert isinstance(summary, dict)
        assert "scenario_id" in summary
        assert "statistics" in summary
        assert "prompt_history" in summary
        assert "tool_call_history" in summary
    
    def test_get_execution_summary_no_execution(self):
        """Test getting summary with no execution."""
        engine = ScenarioEngine()
        
        summary = engine.get_execution_summary()
        
        assert summary["status"] == "no_execution"
    
    def test_reset(self):
        """Test resetting engine state."""
        engine = ScenarioEngine()
        engine.start_execution("default")
        
        assert engine._current_config is not None
        assert engine._current_context is not None
        
        engine.reset()
        
        assert engine._current_config is None
        assert engine._current_context is None
    
    def test_list_available_scenarios(self):
        """Test listing available scenarios."""
        engine = ScenarioEngine()
        
        scenarios = engine.list_available_scenarios()
        
        assert isinstance(scenarios, list)
        assert "default" in scenarios


class TestScenarioExecutionContext:
    """Tests for ScenarioExecutionContext."""
    
    def test_init(self):
        """Test initialization."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        assert context.scenario_id == "test"
        assert context.is_complete is False
        assert context.error is None
        assert context.total_prompts == 0
        assert context.total_tool_calls == 0
    
    def test_add_prompt(self):
        """Test adding prompt to history."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        match_result = MatchResult(
            matched=True,
            response="test response",
            confidence=0.9,
            pattern_used="test.*"
        )
        
        context.add_prompt(
            prompt="test prompt",
            response="test response",
            provider="openai",
            match_result=match_result,
            duration_ms=100
        )
        
        assert context.total_prompts == 1
        assert len(context.prompt_history) == 1
        assert context.total_duration_ms == 100
        
        history_entry = context.prompt_history[0]
        assert history_entry["prompt"] == "test prompt"
        assert history_entry["response"] == "test response"
        assert history_entry["provider"] == "openai"
        assert history_entry["matched"] is True
        assert history_entry["confidence"] == 0.9
    
    def test_add_tool_call(self):
        """Test adding tool call to history."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        context.add_tool_call(
            tool_id="test_tool",
            tool_args={"arg": "value"},
            response={"data": "result"},
            duration_ms=50
        )
        
        assert context.total_tool_calls == 1
        assert len(context.tool_call_history) == 1
        assert context.total_duration_ms == 50
        
        history_entry = context.tool_call_history[0]
        assert history_entry["tool_id"] == "test_tool"
        assert history_entry["tool_args"] == {"arg": "value"}
        assert history_entry["response"] == {"data": "result"}
        assert history_entry["error"] is None
    
    def test_mark_complete(self):
        """Test marking execution as complete."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        assert context.is_complete is False
        assert context.completed_at is None
        
        context.mark_complete()
        
        assert context.is_complete is True
        assert context.completed_at is not None
        assert context.error is None
    
    def test_mark_complete_with_error(self):
        """Test marking execution as complete with error."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        context.mark_complete(error="Test error")
        
        assert context.is_complete is True
        assert context.error == "Test error"
    
    def test_to_dict(self):
        """Test converting context to dictionary."""
        context = ScenarioExecutionContext(scenario_id="test")
        
        match_result = MatchResult(matched=True, response="test")
        context.add_prompt("prompt", "response", "openai", match_result, 100)
        context.add_tool_call("tool", {}, {}, 50)
        context.mark_complete()
        
        result = context.to_dict()
        
        assert isinstance(result, dict)
        assert result["scenario_id"] == "test"
        assert result["is_complete"] is True
        assert result["statistics"]["total_prompts"] == 1
        assert result["statistics"]["total_tool_calls"] == 1
        assert result["statistics"]["total_duration_ms"] == 150
        assert len(result["prompt_history"]) == 1
        assert len(result["tool_call_history"]) == 1
