"""
Agent communication protocols.

This module provides the communication infrastructure for agents to exchange
messages, delegate tasks, and coordinate their activities.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4
import asyncio
from threading import Lock


class CommunicationType(str, Enum):
    """Types of communication between agents."""
    
    REQUEST = "request"  # Request for action or information
    RESPONSE = "response"  # Response to a request
    NOTIFICATION = "notification"  # One-way notification
    DELEGATION = "delegation"  # Task delegation
    RESULT = "result"  # Result of delegated task


@dataclass
class AgentCommunication:
    """
    Message exchanged between agents.
    
    Attributes:
        communication_id: Unique identifier for this communication
        from_agent_id: ID of the sending agent
        to_agent_id: ID of the receiving agent
        communication_type: Type of communication
        payload: The actual message content
        timestamp: When the communication was created
        in_reply_to: ID of communication this is replying to (if applicable)
        metadata: Additional context about the communication
    """
    
    communication_id: str = field(default_factory=lambda: str(uuid4()))
    from_agent_id: str = ""
    to_agent_id: str = ""
    communication_type: CommunicationType = CommunicationType.NOTIFICATION
    payload: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)
    in_reply_to: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert communication to dictionary for serialization."""
        return {
            "communication_id": self.communication_id,
            "from_agent_id": self.from_agent_id,
            "to_agent_id": self.to_agent_id,
            "communication_type": self.communication_type.value,
            "payload": self.payload,
            "timestamp": self.timestamp.isoformat(),
            "in_reply_to": self.in_reply_to,
            "metadata": self.metadata,
        }


@dataclass
class DelegationRequest:
    """
    Request to delegate a task to another agent.
    
    Attributes:
        task_description: Description of the task to delegate
        task_parameters: Parameters for the task
        delegated_mandate_id: Mandate ID for the delegated agent
        expected_result_type: Expected type of result
        timeout_seconds: Maximum time to wait for result
    """
    
    task_description: str
    task_parameters: Dict[str, Any] = field(default_factory=dict)
    delegated_mandate_id: str = ""
    expected_result_type: str = "dict"
    timeout_seconds: int = 300
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert delegation request to dictionary."""
        return {
            "task_description": self.task_description,
            "task_parameters": self.task_parameters,
            "delegated_mandate_id": self.delegated_mandate_id,
            "expected_result_type": self.expected_result_type,
            "timeout_seconds": self.timeout_seconds,
        }


@dataclass
class DelegationResult:
    """
    Result of a delegated task.
    
    Attributes:
        success: Whether the task completed successfully
        result: The actual result data
        error: Error message if task failed
        execution_time_seconds: How long the task took
    """
    
    success: bool
    result: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    execution_time_seconds: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert delegation result to dictionary."""
        return {
            "success": self.success,
            "result": self.result,
            "error": self.error,
            "execution_time_seconds": self.execution_time_seconds,
        }


class CommunicationBus:
    """
    Central communication bus for agent-to-agent communication.
    
    This class provides a publish-subscribe mechanism for agents to communicate
    with each other asynchronously. Agents can send messages, subscribe to
    messages, and handle incoming communications.
    
    Attributes:
        _subscribers: Dictionary mapping agent_id to list of handler functions
        _communications: List of all communications sent through the bus
        _lock: Thread lock for thread-safe operations
    """
    
    def __init__(self):
        """Initialize the communication bus."""
        self._subscribers: Dict[str, List[Callable]] = {}
        self._communications: List[AgentCommunication] = []
        self._lock = Lock()
        self._pending_responses: Dict[str, asyncio.Future] = {}
    
    def subscribe(
        self,
        agent_id: str,
        handler: Callable[[AgentCommunication], None],
    ) -> None:
        """
        Subscribe an agent to receive communications.
        
        Args:
            agent_id: ID of the agent subscribing
            handler: Callback function to handle incoming communications
        """
        with self._lock:
            if agent_id not in self._subscribers:
                self._subscribers[agent_id] = []
            self._subscribers[agent_id].append(handler)
    
    def unsubscribe(self, agent_id: str) -> None:
        """
        Unsubscribe an agent from receiving communications.
        
        Args:
            agent_id: ID of the agent to unsubscribe
        """
        with self._lock:
            if agent_id in self._subscribers:
                del self._subscribers[agent_id]
    
    async def send(self, communication: AgentCommunication) -> None:
        """
        Send a communication through the bus.
        
        Args:
            communication: The communication to send
        """
        with self._lock:
            self._communications.append(communication)
            handlers = self._subscribers.get(communication.to_agent_id, [])
        
        # Call handlers outside the lock to avoid deadlocks
        for handler in handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(communication)
                else:
                    handler(communication)
            except Exception as e:
                # Log error but don't stop other handlers
                print(f"Error in communication handler: {e}")
    
    async def request(
        self,
        from_agent_id: str,
        to_agent_id: str,
        payload: Dict[str, Any],
        timeout_seconds: float = 30.0,
    ) -> Dict[str, Any]:
        """
        Send a request and wait for a response.
        
        Args:
            from_agent_id: ID of the requesting agent
            to_agent_id: ID of the agent to request from
            payload: Request payload
            timeout_seconds: Maximum time to wait for response
        
        Returns:
            Response payload
        
        Raises:
            TimeoutError: If no response received within timeout
        """
        # Create request communication
        request = AgentCommunication(
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            communication_type=CommunicationType.REQUEST,
            payload=payload,
        )
        
        # Create future for response
        future = asyncio.Future()
        with self._lock:
            self._pending_responses[request.communication_id] = future
        
        # Send request
        await self.send(request)
        
        # Wait for response
        try:
            response = await asyncio.wait_for(future, timeout=timeout_seconds)
            return response
        except asyncio.TimeoutError:
            with self._lock:
                self._pending_responses.pop(request.communication_id, None)
            raise TimeoutError(
                f"No response received from {to_agent_id} within {timeout_seconds}s"
            )
    
    async def respond(
        self,
        to_communication_id: str,
        from_agent_id: str,
        to_agent_id: str,
        payload: Dict[str, Any],
    ) -> None:
        """
        Send a response to a previous request.
        
        Args:
            to_communication_id: ID of the communication being responded to
            from_agent_id: ID of the responding agent
            to_agent_id: ID of the agent to respond to
            payload: Response payload
        """
        response = AgentCommunication(
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            communication_type=CommunicationType.RESPONSE,
            payload=payload,
            in_reply_to=to_communication_id,
        )
        
        # Check if there's a pending future for this response
        with self._lock:
            future = self._pending_responses.pop(to_communication_id, None)
        
        if future and not future.done():
            future.set_result(payload)
        
        await self.send(response)
    
    async def notify(
        self,
        from_agent_id: str,
        to_agent_id: str,
        payload: Dict[str, Any],
    ) -> None:
        """
        Send a one-way notification (no response expected).
        
        Args:
            from_agent_id: ID of the notifying agent
            to_agent_id: ID of the agent to notify
            payload: Notification payload
        """
        notification = AgentCommunication(
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            communication_type=CommunicationType.NOTIFICATION,
            payload=payload,
        )
        await self.send(notification)
    
    async def delegate(
        self,
        from_agent_id: str,
        to_agent_id: str,
        delegation_request: DelegationRequest,
        timeout_seconds: Optional[float] = None,
    ) -> DelegationResult:
        """
        Delegate a task to another agent and wait for the result.
        
        Args:
            from_agent_id: ID of the delegating agent
            to_agent_id: ID of the agent to delegate to
            delegation_request: Details of the task to delegate
            timeout_seconds: Maximum time to wait (uses request timeout if None)
        
        Returns:
            DelegationResult containing the task result
        
        Raises:
            TimeoutError: If no result received within timeout
        """
        timeout = timeout_seconds or delegation_request.timeout_seconds
        
        # Send delegation request
        delegation = AgentCommunication(
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            communication_type=CommunicationType.DELEGATION,
            payload=delegation_request.to_dict(),
        )
        
        # Create future for result
        future = asyncio.Future()
        with self._lock:
            self._pending_responses[delegation.communication_id] = future
        
        await self.send(delegation)
        
        # Wait for result
        try:
            result_payload = await asyncio.wait_for(future, timeout=timeout)
            return DelegationResult(**result_payload)
        except asyncio.TimeoutError:
            with self._lock:
                self._pending_responses.pop(delegation.communication_id, None)
            raise TimeoutError(
                f"Delegation to {to_agent_id} timed out after {timeout}s"
            )
    
    async def send_delegation_result(
        self,
        to_communication_id: str,
        from_agent_id: str,
        to_agent_id: str,
        result: DelegationResult,
    ) -> None:
        """
        Send the result of a delegated task.
        
        Args:
            to_communication_id: ID of the delegation communication
            from_agent_id: ID of the agent sending the result
            to_agent_id: ID of the agent to send result to
            result: The delegation result
        """
        result_comm = AgentCommunication(
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            communication_type=CommunicationType.RESULT,
            payload=result.to_dict(),
            in_reply_to=to_communication_id,
        )
        
        # Check if there's a pending future for this result
        with self._lock:
            future = self._pending_responses.pop(to_communication_id, None)
        
        if future and not future.done():
            future.set_result(result.to_dict())
        
        await self.send(result_comm)
    
    def get_communications(
        self,
        agent_id: Optional[str] = None,
        communication_type: Optional[CommunicationType] = None,
    ) -> List[AgentCommunication]:
        """
        Get communications, optionally filtered by agent or type.
        
        Args:
            agent_id: Filter by agent (sender or receiver)
            communication_type: Filter by communication type
        
        Returns:
            List of matching communications
        """
        with self._lock:
            communications = list(self._communications)
        
        if agent_id:
            communications = [
                c for c in communications
                if c.from_agent_id == agent_id or c.to_agent_id == agent_id
            ]
        
        if communication_type:
            communications = [
                c for c in communications
                if c.communication_type == communication_type
            ]
        
        return communications
    
    def clear(self) -> None:
        """Clear all communications and subscriptions."""
        with self._lock:
            self._communications.clear()
            self._subscribers.clear()
            self._pending_responses.clear()
    
    def __len__(self) -> int:
        """Return the number of communications sent through the bus."""
        with self._lock:
            return len(self._communications)
    
    def __repr__(self) -> str:
        """String representation of the communication bus."""
        with self._lock:
            return (
                f"<CommunicationBus "
                f"communications={len(self._communications)} "
                f"subscribers={len(self._subscribers)}>"
            )


# Global communication bus instance
_global_communication_bus: Optional[CommunicationBus] = None


def get_communication_bus() -> CommunicationBus:
    """
    Get the global communication bus instance.
    
    Returns:
        The global CommunicationBus instance
    """
    global _global_communication_bus
    if _global_communication_bus is None:
        _global_communication_bus = CommunicationBus()
    return _global_communication_bus


def reset_communication_bus() -> None:
    """Reset the global communication bus (useful for testing)."""
    global _global_communication_bus
    if _global_communication_bus is not None:
        _global_communication_bus.clear()
    _global_communication_bus = None
