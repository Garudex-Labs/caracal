"""
Scenario Engine

Executes mock scenarios by coordinating configuration loading, pattern matching,
and response generation for LLM calls and tool executions.
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from datetime import datetime

from .config_loader import MockConfigLoader, MockConfig, ToolResponse
from .response_matcher import ResponseMatcher, MatchResult


@dataclass
class ScenarioExecutionContext:
    """
    Context for scenario execution tracking.
    
    Tracks all interactions during a scenario execution including
    prompts, tool calls, responses, and timing information.
    """
    scenario_id: str
    started_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None
    
    # Execution history
    prompt_history: List[Dict[str, Any]] = field(default_factory=list)
    tool_call_history: List[Dict[str, Any]] = field(default_factory=list)
    
    # Statistics
    total_prompts: int = 0
    total_tool_calls: int = 0
    total_duration_ms: int = 0
    
    # State
    is_complete: bool = False
    error: Optional[str] = None
    
    def add_prompt(
        self,
        prompt: str,
        response: str,
        provider: str,
        match_result: MatchResult,
        duration_ms: int
    ):
        """Record a prompt and its response."""
        self.prompt_history.append({
            "prompt": prompt,
            "response": response,
            "provider": provider,
            "matched": match_result.matched,
            "confidence": match_result.confidence,
            "pattern_used": match_result.pattern_used,
            "duration_ms": duration_ms,
            "timestamp": datetime.now().isoformat()
        })
        self.total_prompts += 1
        self.total_duration_ms += duration_ms
    
    def add_tool_call(
        self,
        tool_id: str,
        tool_args: Dict[str, Any],
        response: Dict[str, Any],
        duration_ms: int,
        error: Optional[str] = None
    ):
        """Record a tool call and its response."""
        self.tool_call_history.append({
            "tool_id": tool_id,
            "tool_args": tool_args,
            "response": response,
            "duration_ms": duration_ms,
            "error": error,
            "timestamp": datetime.now().isoformat()
        })
        self.total_tool_calls += 1
        self.total_duration_ms += duration_ms
    
    def mark_complete(self, error: Optional[str] = None):
        """Mark the scenario execution as complete."""
        self.completed_at = datetime.now()
        self.is_complete = True
        self.error = error
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert context to dictionary for serialization."""
        return {
            "scenario_id": self.scenario_id,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "is_complete": self.is_complete,
            "error": self.error,
            "statistics": {
                "total_prompts": self.total_prompts,
                "total_tool_calls": self.total_tool_calls,
                "total_duration_ms": self.total_duration_ms
            },
            "prompt_history": self.prompt_history,
            "tool_call_history": self.tool_call_history
        }


class ScenarioEngine:
    """
    Executes mock scenarios by coordinating configuration and response matching.
    
    The scenario engine:
    1. Loads scenario configuration
    2. Matches prompts to mock LLM responses
    3. Matches tool calls to mock tool responses
    4. Tracks execution context and history
    5. Simulates realistic delays
    """
    
    def __init__(
        self,
        config_loader: Optional[MockConfigLoader] = None,
        response_matcher: Optional[ResponseMatcher] = None
    ):
        """
        Initialize the scenario engine.
        
        Args:
            config_loader: MockConfigLoader instance (creates new if None)
            response_matcher: ResponseMatcher instance (creates new if None)
        """
        self.config_loader = config_loader or MockConfigLoader()
        self.response_matcher = response_matcher or ResponseMatcher()
        
        self._current_config: Optional[MockConfig] = None
        self._current_context: Optional[ScenarioExecutionContext] = None
    
    def load_scenario(self, scenario_id: str) -> MockConfig:
        """
        Load a scenario configuration.
        
        Args:
            scenario_id: ID of the scenario to load
            
        Returns:
            MockConfig object
            
        Raises:
            MockConfigError: If scenario cannot be loaded
        """
        self._current_config = self.config_loader.load_scenario_config(scenario_id)
        return self._current_config
    
    def start_execution(self, scenario_id: str) -> ScenarioExecutionContext:
        """
        Start a new scenario execution.
        
        Args:
            scenario_id: ID of the scenario to execute
            
        Returns:
            ScenarioExecutionContext for tracking execution
        """
        # Load scenario if not already loaded
        if self._current_config is None or self._current_config.scenario_id != scenario_id:
            self.load_scenario(scenario_id)
        
        # Create new execution context
        self._current_context = ScenarioExecutionContext(scenario_id=scenario_id)
        return self._current_context
    
    async def generate_llm_response(
        self,
        prompt: str,
        provider: str = "openai",
        default_response: Optional[str] = None
    ) -> str:
        """
        Generate a mock LLM response for a prompt.
        
        Args:
            prompt: The prompt text
            provider: LLM provider name (e.g., "openai", "gemini")
            default_response: Default response if no pattern matches
            
        Returns:
            Mock LLM response text
        """
        start_time = time.time()
        
        if self._current_config is None:
            raise RuntimeError("No scenario loaded. Call load_scenario() first.")
        
        # Get patterns for this provider
        patterns = self._current_config.llm_responses.get(provider, [])
        
        # Match prompt to response
        match_result = self.response_matcher.match_prompt(
            prompt=prompt,
            patterns=patterns,
            default_response=default_response
        )
        
        # Simulate realistic LLM delay (50-200ms)
        await asyncio.sleep(0.05 + (0.15 * len(prompt) / 1000))
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        # Record in context if available
        if self._current_context:
            self._current_context.add_prompt(
                prompt=prompt,
                response=match_result.response or default_response or "",
                provider=provider,
                match_result=match_result,
                duration_ms=duration_ms
            )
        
        return match_result.response or default_response or ""
    
    async def execute_tool_call(
        self,
        tool_id: str,
        tool_args: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Execute a mock tool call.
        
        Args:
            tool_id: Tool identifier
            tool_args: Tool call arguments
            
        Returns:
            Mock tool response
            
        Raises:
            RuntimeError: If tool response indicates an error
        """
        start_time = time.time()
        
        if self._current_config is None:
            raise RuntimeError("No scenario loaded. Call load_scenario() first.")
        
        # Match tool call to response
        tool_response = self.response_matcher.match_tool_call(
            tool_id=tool_id,
            tool_args=tool_args,
            tool_responses=self._current_config.tool_responses
        )
        
        if tool_response is None:
            # No mock response configured, return empty response
            response = {"status": "success", "data": {}}
            error = None
        else:
            # Simulate configured delay
            if tool_response.delay_ms > 0:
                await asyncio.sleep(tool_response.delay_ms / 1000)
            
            response = tool_response.response
            error = tool_response.error
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        # Record in context if available
        if self._current_context:
            self._current_context.add_tool_call(
                tool_id=tool_id,
                tool_args=tool_args,
                response=response,
                duration_ms=duration_ms,
                error=error
            )
        
        # Raise error if configured
        if error:
            raise RuntimeError(f"Mock tool error: {error}")
        
        return response
    
    def get_agent_decision(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """
        Get agent decision configuration for an agent.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            Agent decision configuration or None if not found
        """
        if self._current_config is None:
            return None
        
        agent_decision = self._current_config.agent_decisions.get(agent_id)
        
        if agent_decision is None:
            return None
        
        return {
            "agent_id": agent_decision.agent_id,
            "delegation_strategy": agent_decision.delegation_strategy,
            "sub_agents": agent_decision.sub_agents,
            "max_iterations": agent_decision.max_iterations
        }
    
    def complete_execution(self, error: Optional[str] = None):
        """
        Mark the current scenario execution as complete.
        
        Args:
            error: Error message if execution failed
        """
        if self._current_context:
            self._current_context.mark_complete(error=error)
    
    def get_execution_context(self) -> Optional[ScenarioExecutionContext]:
        """
        Get the current execution context.
        
        Returns:
            Current ScenarioExecutionContext or None
        """
        return self._current_context
    
    def get_execution_summary(self) -> Dict[str, Any]:
        """
        Get a summary of the current execution.
        
        Returns:
            Dictionary with execution statistics and history
        """
        if self._current_context is None:
            return {
                "status": "no_execution",
                "message": "No scenario execution in progress"
            }
        
        return self._current_context.to_dict()
    
    def reset(self):
        """Reset the engine state."""
        self._current_config = None
        self._current_context = None
        self.response_matcher.clear_cache()
    
    def list_available_scenarios(self) -> List[str]:
        """
        List all available scenario IDs.
        
        Returns:
            List of scenario IDs
        """
        return self.config_loader.list_available_scenarios()
