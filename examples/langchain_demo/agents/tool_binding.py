"""
Agent tool binding interface.

This module provides the interface for binding tools to agents, allowing
agents to discover and call tools through Caracal's governed execution pipeline.
"""

import logging
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


@dataclass
class ToolDefinition:
    """
    Definition of a tool that can be bound to an agent.
    
    Attributes:
        tool_id: Unique identifier for the tool (Caracal tool ID)
        name: Human-readable name
        description: Description of what the tool does
        parameters: Dictionary describing tool parameters
        required_permissions: List of required permissions/actions
        category: Tool category (finance, ops, shared, etc.)
        metadata: Additional metadata about the tool
    """
    
    tool_id: str
    name: str
    description: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    required_permissions: List[str] = field(default_factory=list)
    category: str = "shared"
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert tool definition to dictionary."""
        return {
            "tool_id": self.tool_id,
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "required_permissions": self.required_permissions,
            "category": self.category,
            "metadata": self.metadata,
        }


@dataclass
class ToolCall:
    """
    Record of a tool call made by an agent.
    
    Attributes:
        call_id: Unique identifier for this tool call
        tool_id: ID of the tool that was called
        agent_id: ID of the agent that made the call
        principal_id: Principal identity associated with the agent making the call
        tool_args: Arguments passed to the tool
        result: Result returned by the tool
        status: Status of the call (pending, success, error)
        error: Error message if status is error
        duration_ms: Duration of the call in milliseconds
        timestamp: When the call was made
        metadata: Additional metadata about the call
    """
    
    call_id: str
    tool_id: str
    agent_id: str
    principal_id: str
    tool_args: Dict[str, Any]
    result: Optional[Dict[str, Any]] = None
    status: str = "pending"
    error: Optional[str] = None
    duration_ms: Optional[int] = None
    timestamp: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert tool call to dictionary."""
        return {
            "call_id": self.call_id,
            "tool_id": self.tool_id,
            "agent_id": self.agent_id,
            "principal_id": self.principal_id,
            "tool_args": self.tool_args,
            "result": self.result,
            "status": self.status,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


class ToolBinding:
    """
    Tool binding for an agent.
    
    This class manages the relationship between an agent and the tools it can use,
    providing a clean interface for tool discovery and execution through Caracal.
    
    # CARACAL INTEGRATION POINT
    # All tool calls go through Caracal's governed execution pipeline:
    # 1. Agent requests tool execution with its mandate
    # 2. Caracal validates the mandate has authority for the tool
    # 3. Caracal routes to the appropriate provider
    # 4. Tool executes with provider credentials
    # 5. Result is logged to authority ledger
    # 6. Result is returned to agent
    """
    
    def __init__(
        self,
        agent_id: str,
        principal_id: str,
        caracal_client: Any,
        available_tools: Optional[List[ToolDefinition]] = None,
    ):
        """
        Initialize tool binding for an agent.
        
        Args:
            agent_id: ID of the agent
            principal_id: Principal identity for the agent
            caracal_client: Caracal client for governed tool calls
            available_tools: List of tools available to this agent
        """
        self.agent_id = agent_id
        self.principal_id = principal_id
        self.caracal_client = caracal_client
        self.available_tools: Dict[str, ToolDefinition] = {}
        self.call_history: List[ToolCall] = []
        
        # Register available tools
        if available_tools:
            for tool in available_tools:
                self.register_tool(tool)
        
        logger.debug(
            f"Initialized ToolBinding for agent {agent_id[:8]} "
            f"with {len(self.available_tools)} tools"
        )
    
    def register_tool(self, tool: ToolDefinition) -> None:
        """
        Register a tool as available to this agent.
        
        Args:
            tool: Tool definition to register
        """
        self.available_tools[tool.tool_id] = tool
        logger.debug(f"Registered tool {tool.tool_id} for agent {self.agent_id[:8]}")
    
    def unregister_tool(self, tool_id: str) -> None:
        """
        Unregister a tool from this agent.
        
        Args:
            tool_id: ID of the tool to unregister
        """
        self.available_tools.pop(tool_id, None)
        logger.debug(f"Unregistered tool {tool_id} from agent {self.agent_id[:8]}")
    
    def get_tool(self, tool_id: str) -> Optional[ToolDefinition]:
        """
        Get a tool definition by ID.
        
        Args:
            tool_id: ID of the tool
        
        Returns:
            ToolDefinition if found, None otherwise
        """
        return self.available_tools.get(tool_id)
    
    def list_tools(
        self,
        category: Optional[str] = None
    ) -> List[ToolDefinition]:
        """
        List available tools, optionally filtered by category.
        
        Args:
            category: Optional category filter
        
        Returns:
            List of available tool definitions
        """
        tools = list(self.available_tools.values())
        
        if category:
            tools = [t for t in tools if t.category == category]
        
        return tools
    
    def has_tool(self, tool_id: str) -> bool:
        """
        Check if a tool is available to this agent.
        
        Args:
            tool_id: ID of the tool
        
        Returns:
            True if tool is available, False otherwise
        """
        return tool_id in self.available_tools
    
    async def call_tool(
        self,
        tool_id: str,
        tool_args: Dict[str, Any],
        correlation_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ToolCall:
        """
        Call a tool through Caracal's governed execution pipeline.
        
        # CARACAL INTEGRATION POINT
        # This is the primary integration point for tool execution:
        # - Uses agent's mandate for authority
        # - Routes through Caracal's provider system
        # - Logs to authority ledger
        # - Returns governed result
        
        Args:
            tool_id: ID of the tool to call
            tool_args: Arguments to pass to the tool
            correlation_id: Optional correlation ID for tracking
            metadata: Optional metadata about the call
        
        Returns:
            ToolCall record with result or error
        
        Raises:
            ValueError: If tool is not available to this agent
        """
        import time
        
        # Check if tool is available
        if not self.has_tool(tool_id):
            raise ValueError(
                f"Tool {tool_id} is not available to agent {self.agent_id}"
            )
        
        # Create tool call record
        call_id = correlation_id or str(uuid4())
        tool_call = ToolCall(
            call_id=call_id,
            tool_id=tool_id,
            agent_id=self.agent_id,
            principal_id=self.principal_id,
            tool_args=tool_args,
            status="pending",
            timestamp=time.time(),
            metadata=metadata or {},
        )
        
        # Add to history
        self.call_history.append(tool_call)
        
        try:
            start_time = time.time()
            
            # CARACAL_MARKER: TOOL_CALL
            # This tool call goes through Caracal's authority enforcement pipeline
            call_kwargs = {
                "tool_id": tool_id,
                "tool_args": tool_args,
                "correlation_id": call_id,
            }
            try:
                signature = inspect.signature(self.caracal_client.call_tool)
            except (TypeError, ValueError):
                signature = None
            if signature and "principal_id" in signature.parameters:
                call_kwargs["principal_id"] = self.principal_id

            result = await self.caracal_client.call_tool(
                **call_kwargs,
            )
            
            end_time = time.time()
            duration_ms = int((end_time - start_time) * 1000)
            
            # Update tool call record
            tool_call.result = result
            tool_call.status = "success"
            tool_call.duration_ms = duration_ms
            
            logger.info(
                f"Tool call {call_id[:8]} succeeded: {tool_id} "
                f"(duration: {duration_ms}ms)"
            )
            
        except Exception as e:
            end_time = time.time()
            duration_ms = int((end_time - start_time) * 1000)
            
            # Update tool call record with error
            tool_call.status = "error"
            tool_call.error = str(e)
            tool_call.duration_ms = duration_ms
            
            logger.error(
                f"Tool call {call_id[:8]} failed: {tool_id} - {e}",
                exc_info=True
            )
        
        return tool_call
    
    def get_call_history(
        self,
        tool_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[ToolCall]:
        """
        Get tool call history, optionally filtered.
        
        Args:
            tool_id: Filter by tool ID
            status: Filter by status (pending, success, error)
            limit: Maximum number of calls to return
        
        Returns:
            List of tool call records
        """
        calls = list(self.call_history)
        
        if tool_id:
            calls = [c for c in calls if c.tool_id == tool_id]
        
        if status:
            calls = [c for c in calls if c.status == status]
        
        if limit:
            calls = calls[-limit:]
        
        return calls
    
    def get_call_statistics(self) -> Dict[str, Any]:
        """
        Get statistics about tool calls.
        
        Returns:
            Dictionary with call statistics
        """
        stats = {
            "total_calls": len(self.call_history),
            "successful_calls": 0,
            "failed_calls": 0,
            "pending_calls": 0,
            "calls_by_tool": {},
            "average_duration_ms": 0.0,
        }
        
        total_duration = 0
        duration_count = 0
        
        for call in self.call_history:
            if call.status == "success":
                stats["successful_calls"] += 1
            elif call.status == "error":
                stats["failed_calls"] += 1
            elif call.status == "pending":
                stats["pending_calls"] += 1
            
            # Track by tool
            if call.tool_id not in stats["calls_by_tool"]:
                stats["calls_by_tool"][call.tool_id] = 0
            stats["calls_by_tool"][call.tool_id] += 1
            
            # Track duration
            if call.duration_ms is not None:
                total_duration += call.duration_ms
                duration_count += 1
        
        # Calculate average duration
        if duration_count > 0:
            stats["average_duration_ms"] = total_duration / duration_count
        
        return stats
    
    def clear_history(self) -> None:
        """Clear tool call history."""
        self.call_history.clear()
        logger.debug(f"Cleared tool call history for agent {self.agent_id[:8]}")
    
    def __repr__(self) -> str:
        """String representation of the tool binding."""
        return (
            f"<ToolBinding agent={self.agent_id[:8]} "
            f"tools={len(self.available_tools)} "
            f"calls={len(self.call_history)}>"
        )


class ToolRegistry:
    """
    Global registry of tool definitions.
    
    This class maintains a centralized registry of all available tools
    in the system, allowing agents to discover and bind to tools.
    """
    
    def __init__(self):
        """Initialize the tool registry."""
        self.tools: Dict[str, ToolDefinition] = {}
        self.tools_by_category: Dict[str, List[str]] = {}
    
    def register(self, tool: ToolDefinition) -> None:
        """
        Register a tool in the registry.
        
        Args:
            tool: Tool definition to register
        """
        self.tools[tool.tool_id] = tool
        
        # Update category index
        if tool.category not in self.tools_by_category:
            self.tools_by_category[tool.category] = []
        if tool.tool_id not in self.tools_by_category[tool.category]:
            self.tools_by_category[tool.category].append(tool.tool_id)
        
        logger.debug(f"Registered tool {tool.tool_id} in registry")
    
    def unregister(self, tool_id: str) -> None:
        """
        Unregister a tool from the registry.
        
        Args:
            tool_id: ID of the tool to unregister
        """
        tool = self.tools.pop(tool_id, None)
        
        if tool:
            # Update category index
            if tool.category in self.tools_by_category:
                self.tools_by_category[tool.category] = [
                    tid for tid in self.tools_by_category[tool.category]
                    if tid != tool_id
                ]
            
            logger.debug(f"Unregistered tool {tool_id} from registry")
    
    def get(self, tool_id: str) -> Optional[ToolDefinition]:
        """
        Get a tool definition by ID.
        
        Args:
            tool_id: ID of the tool
        
        Returns:
            ToolDefinition if found, None otherwise
        """
        return self.tools.get(tool_id)
    
    def list_all(self) -> List[ToolDefinition]:
        """
        List all registered tools.
        
        Returns:
            List of all tool definitions
        """
        return list(self.tools.values())
    
    def list_by_category(self, category: str) -> List[ToolDefinition]:
        """
        List tools in a specific category.
        
        Args:
            category: Category to filter by
        
        Returns:
            List of tool definitions in the category
        """
        tool_ids = self.tools_by_category.get(category, [])
        return [self.tools[tid] for tid in tool_ids if tid in self.tools]
    
    def list_categories(self) -> List[str]:
        """
        List all tool categories.
        
        Returns:
            List of category names
        """
        return list(self.tools_by_category.keys())
    
    def clear(self) -> None:
        """Clear all registered tools."""
        self.tools.clear()
        self.tools_by_category.clear()
        logger.debug("Cleared tool registry")
    
    def __len__(self) -> int:
        """Return the number of registered tools."""
        return len(self.tools)
    
    def __repr__(self) -> str:
        """String representation of the registry."""
        return f"<ToolRegistry tools={len(self.tools)}>"


# Global tool registry instance
_global_tool_registry: Optional[ToolRegistry] = None


def get_tool_registry() -> ToolRegistry:
    """
    Get the global tool registry instance.
    
    Returns:
        The global ToolRegistry instance
    """
    global _global_tool_registry
    if _global_tool_registry is None:
        _global_tool_registry = ToolRegistry()
    return _global_tool_registry


def reset_tool_registry() -> None:
    """Reset the global tool registry (useful for testing)."""
    global _global_tool_registry
    if _global_tool_registry is not None:
        _global_tool_registry.clear()
    _global_tool_registry = None
