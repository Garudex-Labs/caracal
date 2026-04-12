"""
Base agent classes and data models for the multi-agent system.

This module provides the foundational abstractions for building specialized
agents in the Caracal unified demo.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import uuid4


class AgentRole(str, Enum):
    """Agent role types in the system."""
    
    ORCHESTRATOR = "orchestrator"
    FINANCE = "finance"
    OPS = "ops"
    ANALYST = "analyst"
    REPORTER = "reporter"


class MessageType(str, Enum):
    """Types of messages agents can produce."""
    
    THOUGHT = "thought"  # Internal reasoning
    ACTION = "action"  # Action being taken
    OBSERVATION = "observation"  # Result of an action
    RESPONSE = "response"  # Final response to user
    ERROR = "error"  # Error message


@dataclass
class AgentMessage:
    """
    Message produced by an agent during execution.
    
    Attributes:
        agent_id: Unique identifier for the agent instance
        agent_role: Role of the agent (orchestrator, finance, ops, etc.)
        message_type: Type of message (thought, action, observation, etc.)
        content: The actual message content
        timestamp: When the message was created
        metadata: Additional context about the message
    """
    
    agent_id: str
    agent_role: AgentRole
    message_type: MessageType
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert message to dictionary for serialization."""
        return {
            "agent_id": self.agent_id,
            "agent_role": self.agent_role.value,
            "message_type": self.message_type.value,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "metadata": self.metadata,
        }


@dataclass
class AgentState:
    """
    State maintained by an agent during execution.
    
    Attributes:
        agent_id: Unique identifier for the agent instance
        agent_role: Role of the agent
        mandate_id: Caracal mandate ID for this agent
        parent_agent_id: ID of parent agent (if this is a sub-agent)
        messages: List of messages produced by this agent
        tool_calls: List of tool call IDs made by this agent
        sub_agents: List of sub-agent IDs spawned by this agent
        context: Additional context data for the agent
        status: Current status of the agent (active, completed, error)
        created_at: When the agent was created
        completed_at: When the agent completed (if applicable)
    """
    
    agent_id: str
    agent_role: AgentRole
    mandate_id: str
    parent_agent_id: Optional[str] = None
    messages: List[AgentMessage] = field(default_factory=list)
    tool_calls: List[str] = field(default_factory=list)
    sub_agents: List[str] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=dict)
    status: str = "active"
    created_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    
    def add_message(self, message: AgentMessage) -> None:
        """Add a message to the agent's message history."""
        self.messages.append(message)
    
    def add_tool_call(self, tool_call_id: str) -> None:
        """Record a tool call made by this agent."""
        self.tool_calls.append(tool_call_id)
    
    def add_sub_agent(self, sub_agent_id: str) -> None:
        """Record a sub-agent spawned by this agent."""
        self.sub_agents.append(sub_agent_id)
    
    def mark_completed(self) -> None:
        """Mark the agent as completed."""
        self.status = "completed"
        self.completed_at = datetime.utcnow()
    
    def mark_error(self) -> None:
        """Mark the agent as having encountered an error."""
        self.status = "error"
        self.completed_at = datetime.utcnow()
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert state to dictionary for serialization."""
        return {
            "agent_id": self.agent_id,
            "agent_role": self.agent_role.value,
            "mandate_id": self.mandate_id,
            "parent_agent_id": self.parent_agent_id,
            "messages": [msg.to_dict() for msg in self.messages],
            "tool_calls": self.tool_calls,
            "sub_agents": self.sub_agents,
            "context": self.context,
            "status": self.status,
            "created_at": self.created_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class BaseAgent(ABC):
    """
    Abstract base class for all agents in the system.
    
    This class provides the foundational interface and common functionality
    for all specialized agents. Subclasses must implement the execute method
    to define their specific behavior.
    
    Attributes:
        agent_id: Unique identifier for this agent instance
        role: The role this agent plays (orchestrator, finance, ops, etc.)
        mandate_id: Caracal mandate ID for authority enforcement
        state: Current state of the agent
        parent_agent: Reference to parent agent (if this is a sub-agent)
    """
    
    def __init__(
        self,
        role: AgentRole,
        mandate_id: str,
        parent_agent: Optional["BaseAgent"] = None,
        agent_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize the base agent.
        
        Args:
            role: The role this agent plays
            mandate_id: Caracal mandate ID for this agent
            parent_agent: Parent agent if this is a sub-agent
            agent_id: Optional custom agent ID (generated if not provided)
            context: Optional initial context data
        """
        self.agent_id = agent_id or str(uuid4())
        self.role = role
        self.mandate_id = mandate_id
        self.parent_agent = parent_agent
        
        # Initialize state
        parent_id = parent_agent.agent_id if parent_agent else None
        self.state = AgentState(
            agent_id=self.agent_id,
            agent_role=role,
            mandate_id=mandate_id,
            parent_agent_id=parent_id,
            context=context or {},
        )
    
    def emit_message(
        self,
        message_type: MessageType,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> AgentMessage:
        """
        Emit a message from this agent.
        
        Args:
            message_type: Type of message to emit
            content: Message content
            metadata: Optional metadata about the message
        
        Returns:
            The created AgentMessage
        """
        message = AgentMessage(
            agent_id=self.agent_id,
            agent_role=self.role,
            message_type=message_type,
            content=content,
            metadata=metadata or {},
        )
        self.state.add_message(message)
        return message
    
    def record_tool_call(self, tool_call_id: str) -> None:
        """
        Record that this agent made a tool call.
        
        Args:
            tool_call_id: Unique identifier for the tool call
        """
        self.state.add_tool_call(tool_call_id)
    
    def spawn_sub_agent(
        self,
        sub_agent_role: AgentRole,
        sub_agent_mandate_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> "BaseAgent":
        """
        Spawn a sub-agent to handle a delegated task.
        
        This is an abstract method that subclasses can override to create
        specific types of sub-agents. The default implementation raises
        NotImplementedError.
        
        Args:
            sub_agent_role: Role for the sub-agent
            sub_agent_mandate_id: Mandate ID for the sub-agent
            context: Optional context to pass to the sub-agent
        
        Returns:
            The created sub-agent instance
        
        Raises:
            NotImplementedError: If not implemented by subclass
        """
        raise NotImplementedError(
            f"Agent {self.role.value} does not support spawning sub-agents"
        )
    
    @abstractmethod
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute the agent's primary task.
        
        This is the main entry point for agent execution. Subclasses must
        implement this method to define their specific behavior.
        
        Args:
            task: Description of the task to execute
            **kwargs: Additional task-specific parameters
        
        Returns:
            Dictionary containing the execution results
        
        Raises:
            NotImplementedError: Must be implemented by subclass
        """
        pass
    
    def get_state(self) -> AgentState:
        """
        Get the current state of the agent.
        
        Returns:
            The agent's current state
        """
        return self.state
    
    def get_messages(self) -> List[AgentMessage]:
        """
        Get all messages produced by this agent.
        
        Returns:
            List of agent messages
        """
        return self.state.messages
    
    def __repr__(self) -> str:
        """String representation of the agent."""
        return (
            f"<{self.__class__.__name__} "
            f"id={self.agent_id[:8]} "
            f"role={self.role.value} "
            f"status={self.state.status}>"
        )
