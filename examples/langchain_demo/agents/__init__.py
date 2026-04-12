"""
Multi-agent system for Caracal unified demo.

This package provides the agent architecture for orchestrating complex
workflows with multiple specialized agents.
"""

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentMessage,
    AgentState,
    AgentRole,
    MessageType,
)

__all__ = [
    "BaseAgent",
    "AgentMessage",
    "AgentState",
    "AgentRole",
    "MessageType",
]
