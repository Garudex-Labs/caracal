"""
Nested agent spawning mechanism for multi-level agent hierarchies.

This module provides functionality for spawning sub-agents in a nested
hierarchy, with full support for mandate delegation, context propagation,
and result aggregation.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Type
from uuid import uuid4

from examples.langchain_demo.agents.base import BaseAgent, AgentRole, MessageType
from examples.langchain_demo.agents.delegation import (
    DelegationProtocol,
    get_delegation_protocol,
)

logger = logging.getLogger(__name__)


@dataclass
class SpawnRequest:
    """
    Request to spawn a sub-agent.
    
    Attributes:
        spawn_id: Unique identifier for this spawn request
        parent_agent_id: ID of the parent agent
        parent_agent_role: Role of the parent agent
        sub_agent_role: Role of the sub-agent to spawn
        task_description: Description of the task for the sub-agent
        context: Context to pass to the sub-agent
        mandate_id: Mandate ID for the sub-agent (delegated from parent)
        priority: Priority level (1=highest, 5=lowest)
        created_at: When the request was created
    """
    
    spawn_id: str
    parent_agent_id: str
    parent_agent_role: AgentRole
    sub_agent_role: AgentRole
    task_description: str
    context: Dict[str, Any] = field(default_factory=dict)
    mandate_id: Optional[str] = None
    priority: int = 3
    created_at: datetime = field(default_factory=datetime.utcnow)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert spawn request to dictionary."""
        return {
            "spawn_id": self.spawn_id,
            "parent_agent_id": self.parent_agent_id,
            "parent_agent_role": self.parent_agent_role.value,
            "sub_agent_role": self.sub_agent_role.value,
            "task_description": self.task_description,
            "context": self.context,
            "mandate_id": self.mandate_id,
            "priority": self.priority,
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class SpawnedAgent:
    """
    Record of a spawned sub-agent.
    
    Attributes:
        spawn_id: ID of the spawn request
        agent: The spawned agent instance
        parent_agent_id: ID of the parent agent
        spawned_at: When the agent was spawned
        completed_at: When the agent completed (if applicable)
        status: Current status (spawned, running, completed, error)
    """
    
    spawn_id: str
    agent: BaseAgent
    parent_agent_id: str
    spawned_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    status: str = "spawned"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert spawned agent record to dictionary."""
        return {
            "spawn_id": self.spawn_id,
            "agent_id": self.agent.agent_id,
            "agent_role": self.agent.role.value,
            "parent_agent_id": self.parent_agent_id,
            "spawned_at": self.spawned_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "status": self.status,
        }


class NestedAgentSpawner:
    """
    Manager for spawning and tracking nested sub-agents.
    
    This class provides functionality for:
    1. Spawning sub-agents with proper mandate delegation
    2. Tracking agent hierarchies and relationships
    3. Managing sub-agent lifecycle
    4. Propagating context between parent and child agents
    5. Aggregating results from sub-agents
    
    # CARACAL INTEGRATION POINT
    # The spawner integrates with Caracal's mandate system:
    # - Parent agent delegates a scoped mandate to each sub-agent
    # - Sub-agents inherit authority from parent's mandate
    # - Delegation chain is tracked for audit purposes
    # - Revoking parent mandate cascades to all sub-agents
    """
    
    def __init__(self, caracal_client: Any):
        """
        Initialize the nested agent spawner.
        
        Args:
            caracal_client: Caracal client for mandate operations
        """
        self.caracal_client = caracal_client
        self.delegation_protocol = get_delegation_protocol(caracal_client)
        
        # Track spawned agents
        self.spawn_requests: Dict[str, SpawnRequest] = {}
        self.spawned_agents: Dict[str, SpawnedAgent] = {}
        
        # Agent class registry for spawning
        self.agent_registry: Dict[AgentRole, Type[BaseAgent]] = {}
        
        logger.debug("Initialized NestedAgentSpawner")
    
    def register_agent_class(
        self,
        role: AgentRole,
        agent_class: Type[BaseAgent]
    ) -> None:
        """
        Register an agent class for a specific role.
        
        Args:
            role: Agent role
            agent_class: Agent class to instantiate for this role
        """
        self.agent_registry[role] = agent_class
        logger.debug(f"Registered agent class for role: {role.value}")
    
    async def spawn_sub_agent(
        self,
        parent_agent: BaseAgent,
        sub_agent_role: AgentRole,
        task_description: str,
        sub_agent_mandate_id: str,
        context: Optional[Dict[str, Any]] = None,
        scenario: Optional[Any] = None,
        priority: int = 3,
    ) -> BaseAgent:
        """
        Spawn a sub-agent from a parent agent.
        
        # CARACAL INTEGRATION POINT
        # This method demonstrates nested mandate delegation:
        # 1. Parent agent has a mandate with certain authority
        # 2. Parent spawns sub-agent with delegated mandate
        # 3. Sub-agent can only access tools within delegated scope
        # 4. Delegation is tracked in the delegation protocol
        # 5. Sub-agent can further delegate to its own sub-agents
        
        Args:
            parent_agent: The parent agent spawning the sub-agent
            sub_agent_role: Role for the sub-agent
            task_description: Description of the task for the sub-agent
            sub_agent_mandate_id: Mandate ID for the sub-agent (delegated)
            context: Optional context to pass to the sub-agent
            scenario: Optional scenario context
            priority: Priority level (1=highest, 5=lowest)
        
        Returns:
            The spawned sub-agent instance
        
        Raises:
            ValueError: If sub_agent_role is not registered
        """
        # Create spawn request
        spawn_request = SpawnRequest(
            spawn_id=str(uuid4()),
            parent_agent_id=parent_agent.agent_id,
            parent_agent_role=parent_agent.role,
            sub_agent_role=sub_agent_role,
            task_description=task_description,
            context=context or {},
            mandate_id=sub_agent_mandate_id,
            priority=priority,
        )
        
        self.spawn_requests[spawn_request.spawn_id] = spawn_request
        
        logger.info(
            f"Spawning sub-agent: {parent_agent.role.value} → {sub_agent_role.value} "
            f"(spawn_id: {spawn_request.spawn_id[:8]})"
        )
        
        # Get agent class for the role
        agent_class = self.agent_registry.get(sub_agent_role)
        if not agent_class:
            raise ValueError(
                f"No agent class registered for role: {sub_agent_role.value}. "
                f"Available roles: {list(self.agent_registry.keys())}"
            )
        
        # Prepare context for sub-agent
        sub_agent_context = {
            "spawn_id": spawn_request.spawn_id,
            "parent_agent_id": parent_agent.agent_id,
            "parent_agent_role": parent_agent.role.value,
            "task_description": task_description,
            **(context or {}),
        }
        
        # Instantiate sub-agent
        sub_agent = agent_class(
            mandate_id=sub_agent_mandate_id,
            caracal_client=self.caracal_client,
            scenario=scenario,
            parent_agent=parent_agent,
            context=sub_agent_context,
        )
        
        # Record the spawned agent
        spawned_record = SpawnedAgent(
            spawn_id=spawn_request.spawn_id,
            agent=sub_agent,
            parent_agent_id=parent_agent.agent_id,
        )
        
        self.spawned_agents[spawn_request.spawn_id] = spawned_record
        
        # Update parent agent's state
        parent_agent.state.add_sub_agent(sub_agent.agent_id)
        
        # Delegate mandate (track in delegation protocol)
        await self.delegation_protocol.delegate_mandate(
            source_agent_id=parent_agent.agent_id,
            source_mandate_id=parent_agent.mandate_id,
            target_agent_id=sub_agent.agent_id,
            target_mandate_id=sub_agent_mandate_id,
            metadata={
                "spawn_id": spawn_request.spawn_id,
                "task_description": task_description,
            },
        )
        
        # Emit message from parent
        parent_agent.emit_message(
            MessageType.ACTION,
            f"Spawned {sub_agent_role.value} sub-agent {sub_agent.agent_id[:8]} "
            f"for task: {task_description}"
        )
        
        logger.info(
            f"Spawned sub-agent {sub_agent.agent_id[:8]} "
            f"(role: {sub_agent_role.value}, mandate: {sub_agent_mandate_id[:8]})"
        )
        
        return sub_agent
    
    async def execute_sub_agent(
        self,
        spawn_id: str,
        task: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Execute a spawned sub-agent's task.
        
        Args:
            spawn_id: ID of the spawn request
            task: Task description for the sub-agent
            **kwargs: Additional parameters for the sub-agent
        
        Returns:
            Result from the sub-agent's execution
        
        Raises:
            ValueError: If spawn_id is not found
        """
        spawned_record = self.spawned_agents.get(spawn_id)
        if not spawned_record:
            raise ValueError(f"No spawned agent found for spawn_id: {spawn_id}")
        
        # Update status
        spawned_record.status = "running"
        
        logger.info(
            f"Executing sub-agent {spawned_record.agent.agent_id[:8]} "
            f"(spawn_id: {spawn_id[:8]})"
        )
        
        started_at = datetime.utcnow()
        
        try:
            # Execute the sub-agent
            result = await spawned_record.agent.execute(task, **kwargs)
            
            # Update status
            spawned_record.status = "completed"
            spawned_record.completed_at = datetime.utcnow()
            
            # Record delegation result
            self.delegation_protocol.record_delegation_result(
                request_id=spawn_id,
                agent_id=spawned_record.agent.agent_id,
                agent_role=spawned_record.agent.role,
                status="success",
                result=result,
                started_at=started_at,
                completed_at=spawned_record.completed_at,
            )
            
            logger.info(
                f"Sub-agent {spawned_record.agent.agent_id[:8]} completed successfully"
            )
            
            return result
        
        except Exception as e:
            # Update status
            spawned_record.status = "error"
            spawned_record.completed_at = datetime.utcnow()
            
            # Record delegation result
            self.delegation_protocol.record_delegation_result(
                request_id=spawn_id,
                agent_id=spawned_record.agent.agent_id,
                agent_role=spawned_record.agent.role,
                status="error",
                error=str(e),
                started_at=started_at,
                completed_at=spawned_record.completed_at,
            )
            
            logger.error(
                f"Sub-agent {spawned_record.agent.agent_id[:8]} failed: {e}",
                exc_info=True
            )
            
            raise
    
    async def spawn_and_execute(
        self,
        parent_agent: BaseAgent,
        sub_agent_role: AgentRole,
        task_description: str,
        sub_agent_mandate_id: str,
        context: Optional[Dict[str, Any]] = None,
        scenario: Optional[Any] = None,
        priority: int = 3,
        **execute_kwargs
    ) -> Dict[str, Any]:
        """
        Spawn a sub-agent and immediately execute its task.
        
        This is a convenience method that combines spawning and execution.
        
        Args:
            parent_agent: The parent agent spawning the sub-agent
            sub_agent_role: Role for the sub-agent
            task_description: Description of the task for the sub-agent
            sub_agent_mandate_id: Mandate ID for the sub-agent (delegated)
            context: Optional context to pass to the sub-agent
            scenario: Optional scenario context
            priority: Priority level (1=highest, 5=lowest)
            **execute_kwargs: Additional parameters for execution
        
        Returns:
            Result from the sub-agent's execution
        """
        # Spawn the sub-agent
        sub_agent = await self.spawn_sub_agent(
            parent_agent=parent_agent,
            sub_agent_role=sub_agent_role,
            task_description=task_description,
            sub_agent_mandate_id=sub_agent_mandate_id,
            context=context,
            scenario=scenario,
            priority=priority,
        )
        
        # Find the spawn_id for this agent
        spawn_id = None
        for sid, record in self.spawned_agents.items():
            if record.agent.agent_id == sub_agent.agent_id:
                spawn_id = sid
                break
        
        if not spawn_id:
            raise ValueError(f"Could not find spawn_id for agent {sub_agent.agent_id}")
        
        # Execute the sub-agent
        result = await self.execute_sub_agent(
            spawn_id=spawn_id,
            task=task_description,
            scenario=scenario,
            **execute_kwargs
        )
        
        return result
    
    def get_agent_hierarchy(
        self,
        root_agent_id: str
    ) -> Dict[str, Any]:
        """
        Get the complete agent hierarchy starting from a root agent.
        
        Args:
            root_agent_id: ID of the root agent
        
        Returns:
            Dictionary representing the agent hierarchy
        """
        hierarchy = {
            "agent_id": root_agent_id,
            "children": [],
        }
        
        # Find all direct children
        for spawn_id, record in self.spawned_agents.items():
            if record.parent_agent_id == root_agent_id:
                child_hierarchy = self.get_agent_hierarchy(record.agent.agent_id)
                child_hierarchy["spawn_id"] = spawn_id
                child_hierarchy["role"] = record.agent.role.value
                child_hierarchy["status"] = record.status
                hierarchy["children"].append(child_hierarchy)
        
        return hierarchy
    
    def get_spawned_agents_by_parent(
        self,
        parent_agent_id: str
    ) -> List[SpawnedAgent]:
        """
        Get all sub-agents spawned by a specific parent agent.
        
        Args:
            parent_agent_id: ID of the parent agent
        
        Returns:
            List of SpawnedAgent records
        """
        return [
            record for record in self.spawned_agents.values()
            if record.parent_agent_id == parent_agent_id
        ]
    
    def get_spawned_agent(self, spawn_id: str) -> Optional[SpawnedAgent]:
        """
        Get a spawned agent record by spawn ID.
        
        Args:
            spawn_id: ID of the spawn request
        
        Returns:
            SpawnedAgent record if found, None otherwise
        """
        return self.spawned_agents.get(spawn_id)
    
    def get_spawn_request(self, spawn_id: str) -> Optional[SpawnRequest]:
        """
        Get a spawn request by ID.
        
        Args:
            spawn_id: ID of the spawn request
        
        Returns:
            SpawnRequest if found, None otherwise
        """
        return self.spawn_requests.get(spawn_id)
    
    def get_statistics(self) -> Dict[str, Any]:
        """
        Get statistics about spawned agents.
        
        Returns:
            Dictionary with spawning statistics
        """
        stats = {
            "total_spawn_requests": len(self.spawn_requests),
            "total_spawned_agents": len(self.spawned_agents),
            "by_status": {},
            "by_role": {},
            "registered_roles": list(self.agent_registry.keys()),
        }
        
        for record in self.spawned_agents.values():
            # Count by status
            status = record.status
            stats["by_status"][status] = stats["by_status"].get(status, 0) + 1
            
            # Count by role
            role = record.agent.role.value
            stats["by_role"][role] = stats["by_role"].get(role, 0) + 1
        
        return stats
    
    def clear(self) -> None:
        """Clear all spawning records."""
        self.spawn_requests.clear()
        self.spawned_agents.clear()
        logger.debug("Cleared nested agent spawner records")
    
    def __repr__(self) -> str:
        """String representation of the spawner."""
        stats = self.get_statistics()
        return (
            f"<NestedAgentSpawner "
            f"spawned={stats['total_spawned_agents']} "
            f"roles={len(stats['registered_roles'])}>"
        )


# Global spawner instance
_global_spawner: Optional[NestedAgentSpawner] = None


def get_nested_spawner(caracal_client: Any) -> NestedAgentSpawner:
    """
    Get the global nested agent spawner instance.
    
    Args:
        caracal_client: Caracal client for mandate operations
    
    Returns:
        The global NestedAgentSpawner instance
    """
    global _global_spawner
    if _global_spawner is None:
        _global_spawner = NestedAgentSpawner(caracal_client)
    return _global_spawner


def reset_nested_spawner() -> None:
    """Reset the global nested spawner (useful for testing)."""
    global _global_spawner
    if _global_spawner is not None:
        _global_spawner.clear()
    _global_spawner = None
