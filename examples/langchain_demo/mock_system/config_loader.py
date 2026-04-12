"""
Mock Configuration Loader

Loads and validates JSON-based mock configurations for scenarios, LLM responses,
tool responses, and agent behaviors.
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from jsonschema import validate, ValidationError as JsonSchemaValidationError


class MockConfigError(Exception):
    """Raised when mock configuration is invalid or cannot be loaded."""
    pass


@dataclass
class PromptPattern:
    """Pattern for matching prompts to responses."""
    pattern: str
    response_template: str
    variables: Dict[str, Any] = field(default_factory=dict)
    match_type: str = "regex"  # regex, exact, contains


@dataclass
class ToolResponse:
    """Mock response for a tool call."""
    tool_id: str
    response: Dict[str, Any]
    delay_ms: int = 0
    error: Optional[str] = None


@dataclass
class AgentDecision:
    """Agent decision configuration."""
    agent_id: str
    delegation_strategy: str = "parallel"  # parallel, sequential
    sub_agents: List[str] = field(default_factory=list)
    max_iterations: int = 10


@dataclass
class MockConfig:
    """Complete mock configuration for a scenario."""
    version: str
    scenario_id: str
    description: str
    llm_responses: Dict[str, List[PromptPattern]] = field(default_factory=dict)
    tool_responses: Dict[str, ToolResponse] = field(default_factory=dict)
    agent_decisions: Dict[str, AgentDecision] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)


class MockConfigLoader:
    """
    Loads and validates mock configurations from JSON files.
    
    Supports loading:
    - Complete scenario configurations
    - Individual LLM response configurations
    - Individual tool response configurations
    - Individual agent behavior configurations
    """
    
    # JSON Schema for mock configuration validation
    MOCK_CONFIG_SCHEMA = {
        "type": "object",
        "required": ["version", "scenario_id", "description"],
        "properties": {
            "version": {"type": "string"},
            "scenario_id": {"type": "string"},
            "description": {"type": "string"},
            "llm_responses": {
                "type": "object",
                "patternProperties": {
                    ".*": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["pattern", "response_template"],
                            "properties": {
                                "pattern": {"type": "string"},
                                "response_template": {"type": "string"},
                                "variables": {"type": "object"},
                                "match_type": {
                                    "type": "string",
                                    "enum": ["regex", "exact", "contains"]
                                }
                            }
                        }
                    }
                }
            },
            "tool_responses": {
                "type": "object",
                "patternProperties": {
                    ".*": {
                        "type": "object",
                        "required": ["response"],
                        "properties": {
                            "response": {"type": "object"},
                            "delay_ms": {"type": "integer", "minimum": 0},
                            "error": {"type": ["string", "null"]}
                        }
                    }
                }
            },
            "agent_decisions": {
                "type": "object",
                "patternProperties": {
                    ".*": {
                        "type": "object",
                        "properties": {
                            "delegation_strategy": {
                                "type": "string",
                                "enum": ["parallel", "sequential"]
                            },
                            "sub_agents": {
                                "type": "array",
                                "items": {"type": "string"}
                            },
                            "max_iterations": {
                                "type": "integer",
                                "minimum": 1
                            }
                        }
                    }
                }
            },
            "metadata": {"type": "object"}
        }
    }
    
    def __init__(self, config_base_path: Optional[Path] = None):
        """
        Initialize the mock config loader.
        
        Args:
            config_base_path: Base path for configuration files.
                            Defaults to mock_system/configs/
        """
        if config_base_path is None:
            # Default to mock_system/configs relative to this file
            self.config_base_path = Path(__file__).parent / "configs"
        else:
            self.config_base_path = Path(config_base_path)
        
        self._config_cache: Dict[str, MockConfig] = {}
    
    def load_scenario_config(self, scenario_id: str) -> MockConfig:
        """
        Load a complete scenario configuration.
        
        Args:
            scenario_id: ID of the scenario to load
            
        Returns:
            MockConfig object with all configuration data
            
        Raises:
            MockConfigError: If configuration cannot be loaded or is invalid
        """
        # Check cache first
        if scenario_id in self._config_cache:
            return self._config_cache[scenario_id]
        
        # Load from file
        scenario_path = self.config_base_path / "scenarios" / f"{scenario_id}.json"
        
        if not scenario_path.exists():
            raise MockConfigError(
                f"Scenario configuration not found: {scenario_path}"
            )
        
        try:
            with open(scenario_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
        except json.JSONDecodeError as e:
            raise MockConfigError(
                f"Invalid JSON in scenario config {scenario_path}: {e}"
            )
        except IOError as e:
            raise MockConfigError(
                f"Failed to read scenario config {scenario_path}: {e}"
            )
        
        # Validate against schema
        try:
            validate(instance=config_data, schema=self.MOCK_CONFIG_SCHEMA)
        except JsonSchemaValidationError as e:
            raise MockConfigError(
                f"Invalid scenario configuration schema: {e.message}"
            )
        
        # Parse into MockConfig object
        config = self._parse_config(config_data)
        
        # Cache and return
        self._config_cache[scenario_id] = config
        return config
    
    def _parse_config(self, config_data: Dict[str, Any]) -> MockConfig:
        """Parse raw config data into MockConfig object."""
        # Parse LLM responses
        llm_responses = {}
        for provider, patterns_data in config_data.get("llm_responses", {}).items():
            patterns = []
            for pattern_data in patterns_data:
                patterns.append(PromptPattern(
                    pattern=pattern_data["pattern"],
                    response_template=pattern_data["response_template"],
                    variables=pattern_data.get("variables", {}),
                    match_type=pattern_data.get("match_type", "regex")
                ))
            llm_responses[provider] = patterns
        
        # Parse tool responses
        tool_responses = {}
        for tool_id, response_data in config_data.get("tool_responses", {}).items():
            tool_responses[tool_id] = ToolResponse(
                tool_id=tool_id,
                response=response_data["response"],
                delay_ms=response_data.get("delay_ms", 0),
                error=response_data.get("error")
            )
        
        # Parse agent decisions
        agent_decisions = {}
        for agent_id, decision_data in config_data.get("agent_decisions", {}).items():
            agent_decisions[agent_id] = AgentDecision(
                agent_id=agent_id,
                delegation_strategy=decision_data.get("delegation_strategy", "parallel"),
                sub_agents=decision_data.get("sub_agents", []),
                max_iterations=decision_data.get("max_iterations", 10)
            )
        
        return MockConfig(
            version=config_data["version"],
            scenario_id=config_data["scenario_id"],
            description=config_data["description"],
            llm_responses=llm_responses,
            tool_responses=tool_responses,
            agent_decisions=agent_decisions,
            metadata=config_data.get("metadata", {})
        )
    
    def load_llm_responses(self, provider: str) -> List[PromptPattern]:
        """
        Load LLM response patterns for a specific provider.
        
        Args:
            provider: Provider name (e.g., "openai", "gemini")
            
        Returns:
            List of PromptPattern objects
        """
        llm_path = self.config_base_path / "llm_responses" / f"{provider}_responses.json"
        
        if not llm_path.exists():
            return []
        
        try:
            with open(llm_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            patterns = []
            for pattern_data in data.get("prompt_patterns", []):
                patterns.append(PromptPattern(
                    pattern=pattern_data["pattern"],
                    response_template=pattern_data["response_template"],
                    variables=pattern_data.get("variables", {}),
                    match_type=pattern_data.get("match_type", "regex")
                ))
            
            return patterns
        except (json.JSONDecodeError, IOError, KeyError) as e:
            raise MockConfigError(
                f"Failed to load LLM responses for {provider}: {e}"
            )
    
    def load_tool_response(self, tool_id: str) -> Optional[ToolResponse]:
        """
        Load mock response for a specific tool.
        
        Args:
            tool_id: Tool identifier
            
        Returns:
            ToolResponse object or None if not found
        """
        # Try to find tool response in any tool response config file
        tool_responses_dir = self.config_base_path / "tool_responses"
        
        if not tool_responses_dir.exists():
            return None
        
        for config_file in tool_responses_dir.glob("*.json"):
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                if tool_id in data:
                    response_data = data[tool_id]
                    return ToolResponse(
                        tool_id=tool_id,
                        response=response_data["response"],
                        delay_ms=response_data.get("delay_ms", 0),
                        error=response_data.get("error")
                    )
            except (json.JSONDecodeError, IOError, KeyError):
                continue
        
        return None
    
    def load_agent_behavior(self, agent_id: str) -> Optional[AgentDecision]:
        """
        Load behavior configuration for a specific agent.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            AgentDecision object or None if not found
        """
        agent_path = self.config_base_path / "agent_behaviors" / f"{agent_id}.json"
        
        if not agent_path.exists():
            return None
        
        try:
            with open(agent_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            return AgentDecision(
                agent_id=agent_id,
                delegation_strategy=data.get("delegation_strategy", "parallel"),
                sub_agents=data.get("sub_agents", []),
                max_iterations=data.get("max_iterations", 10)
            )
        except (json.JSONDecodeError, IOError, KeyError) as e:
            raise MockConfigError(
                f"Failed to load agent behavior for {agent_id}: {e}"
            )
    
    def clear_cache(self):
        """Clear the configuration cache."""
        self._config_cache.clear()
    
    def list_available_scenarios(self) -> List[str]:
        """
        List all available scenario IDs.
        
        Returns:
            List of scenario IDs
        """
        scenarios_dir = self.config_base_path / "scenarios"
        
        if not scenarios_dir.exists():
            return []
        
        return [
            f.stem for f in scenarios_dir.glob("*.json")
            if f.is_file() and f.suffix == ".json"
        ]
