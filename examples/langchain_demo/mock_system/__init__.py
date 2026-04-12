"""
Mock System for Caracal Unified Demo

This module provides a structured, extensible JSON-based mock configuration system
for simulating LLM responses, external API calls, and agent behaviors in the demo.

The mock system allows the demo to run without external API keys while maintaining
realistic behavior and full Caracal integration.
"""

from .config_loader import MockConfigLoader, MockConfig
from .response_matcher import ResponseMatcher, MatchResult
from .scenario_engine import ScenarioEngine, ScenarioExecutionContext

__all__ = [
    "MockConfigLoader",
    "MockConfig",
    "ResponseMatcher",
    "MatchResult",
    "ScenarioEngine",
    "ScenarioExecutionContext",
]
