"""
Agent registry system.

This module provides a centralized registry for agent types and instances,
allowing dynamic agent creation and lookup.
"""

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Type
from threading import Lock

from examples.langchain_demo.agents.base import BaseAgent, AgentRole


@dataclass
class AgentFactory:
    """
    Factory for creating agent instances.
    
    Attributes:
        role: The agent role this factory creates
        agent_class: The agent class to instantiate
        description: Human-readable description of the agent
        supports_sub_agents: Whether this agent can spawn sub-agents
        default_config: Default configuration for the agent
    """
    
    role: AgentRole
    agent_class: Type[BaseAgent]
    description: str
    supports_sub_agents: bool = False
    default_config: Dict[str, Any] = None
    
    def create(
        self,
        mandate_id: str,
        parent_agent: Optional[BaseAgent] = None,
        config: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> BaseAgent:
        """
        Create an instance of the agent.
        
        Args:
            mandate_id: Caracal mandate ID for the agent
            parent_agent: Parent agent if this is a sub-agent
            config: Configuration overrides
            **kwargs: Additional arguments to pass to agent constructor
        
        Returns:
            New agent instance
        """
        # Merge default config with provided config
        final_config = dict(self.default_config or {})
        if config:
            final_config.update(config)
        
        # Create agent instance
        return self.agent_class(
            role=self.role,
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            context=final_config,
            **kwargs
        )


@dataclass
class AgentRegistration:
    """
    Registration record for an agent instance.
    
    Attributes:
        agent_id: Unique identifier for the agent
        agent: The agent instance
        role: The agent's role
        mandate_id: Caracal mandate ID
        parent_agent_id: ID of parent agent (if sub-agent)
        created_at: When the agent was registered
        metadata: Additional metadata about the agent
    """
    
    agent_id: str
    agent: BaseAgent
    role: AgentRole
    mandate_id: str
    parent_agent_id: Optional[str]
    created_at: float
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert registration to dictionary."""
        return {
            "agent_id": self.agent_id,
            "role": self.role.value,
            "mandate_id": self.mandate_id,
            "parent_agent_id": self.parent_agent_id,
            "created_at": self.created_at,
            "metadata": self.metadata,
        }


class AgentRegistry:
    """
    Centralized registry for agent types and instances.
    
    This class maintains:
    1. Agent factories for creating new agents
    2. Active agent instances
    3. Agent lifecycle management
    
    Attributes:
        _factories: Dictionary mapping AgentRole to AgentFactory
        _instances: Dictionary mapping agent_id to AgentRegistration
        _lock: Thread lock for thread-safe operations
    """
    
    def __init__(self):
        """Initialize the agent registry."""
        self._factories: Dict[AgentRole, AgentFactory] = {}
        self._instances: Dict[str, AgentRegistration] = {}
        self._lock = Lock()
    
    def register_factory(self, factory: AgentFactory) -> None:
        """
        Register an agent factory.
        
        Args:
            factory: The agent factory to register
        
        Raises:
            ValueError: If a factory for this role is already registered
        """
        with self._lock:
            if factory.role in self._factories:
                raise ValueError(
                    f"Factory for role {factory.role.value} already registered"
                )
            self._factories[factory.role] = factory
    
    def unregister_factory(self, role: AgentRole) -> None:
        """
        Unregister an agent factory.
        
        Args:
            role: The agent role to unregister
        """
        with self._lock:
            self._factories.pop(role, None)
    
    def get_factory(self, role: AgentRole) -> Optional[AgentFactory]:
        """
        Get the factory for a specific agent role.
        
        Args:
            role: The agent role
        
        Returns:
            AgentFactory if found, None otherwise
        """
        with self._lock:
            return self._factories.get(role)
    
    def list_factories(self) -> List[AgentFactory]:
        """
        List all registered agent factories.
        
        Returns:
            List of all AgentFactory objects
        """
        with self._lock:
            return list(self._factories.values())
    
    def create_agent(
        self,
        role: AgentRole,
        mandate_id: str,
        parent_agent: Optional[BaseAgent] = None,
        config: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> BaseAgent:
        """
        Create and register a new agent instance.
        
        Args:
            role: The role for the new agent
            mandate_id: Caracal mandate ID
            parent_agent: Parent agent if this is a sub-agent
            config: Configuration for the agent
            metadata: Additional metadata to store
            **kwargs: Additional arguments for agent constructor
        
        Returns:
            The created agent instance
        
        Raises:
            ValueError: If no factory registered for the role
        """
        factory = self.get_factory(role)
        if not factory:
            raise ValueError(f"No factory registered for role {role.value}")
        
        # Create agent
        agent = factory.create(
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            config=config,
            **kwargs
        )
        
        # Register instance
        import time
        registration = AgentRegistration(
            agent_id=agent.agent_id,
            agent=agent,
            role=role,
            mandate_id=mandate_id,
            parent_agent_id=parent_agent.agent_id if parent_agent else None,
            created_at=time.time(),
            metadata=metadata or {},
        )
        
        with self._lock:
            self._instances[agent.agent_id] = registration
        
        return agent
    
    def register_instance(
        self,
        agent: BaseAgent,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Register an existing agent instance.
        
        Args:
            agent: The agent to register
            metadata: Additional metadata to store
        """
        import time
        registration = AgentRegistration(
            agent_id=agent.agent_id,
            agent=agent,
            role=agent.role,
            mandate_id=agent.mandate_id,
            parent_agent_id=agent.parent_agent.agent_id if agent.parent_agent else None,
            created_at=time.time(),
            metadata=metadata or {},
        )
        
        with self._lock:
            self._instances[agent.agent_id] = registration
    
    def unregister_instance(self, agent_id: str) -> None:
        """
        Unregister an agent instance.
        
        Args:
            agent_id: ID of the agent to unregister
        """
        with self._lock:
            self._instances.pop(agent_id, None)
    
    def get_instance(self, agent_id: str) -> Optional[BaseAgent]:
        """
        Get an agent instance by ID.
        
        Args:
            agent_id: ID of the agent
        
        Returns:
            BaseAgent if found, None otherwise
        """
        with self._lock:
            registration = self._instances.get(agent_id)
            return registration.agent if registration else None
    
    def get_registration(self, agent_id: str) -> Optional[AgentRegistration]:
        """
        Get the full registration record for an agent.
        
        Args:
            agent_id: ID of the agent
        
        Returns:
            AgentRegistration if found, None otherwise
        """
        with self._lock:
            return self._instances.get(agent_id)
    
    def list_instances(
        self,
        role: Optional[AgentRole] = None,
        parent_agent_id: Optional[str] = None,
    ) -> List[BaseAgent]:
        """
        List agent instances, optionally filtered.
        
        Args:
            role: Filter by agent role
            parent_agent_id: Filter by parent agent ID
        
        Returns:
            List of matching agent instances
        """
        with self._lock:
            instances = list(self._instances.values())
        
        if role:
            instances = [r for r in instances if r.role == role]
        
        if parent_agent_id is not None:
            instances = [r for r in instances if r.parent_agent_id == parent_agent_id]
        
        return [r.agent for r in instances]
    
    def list_registrations(
        self,
        role: Optional[AgentRole] = None,
        parent_agent_id: Optional[str] = None,
    ) -> List[AgentRegistration]:
        """
        List agent registrations, optionally filtered.
        
        Args:
            role: Filter by agent role
            parent_agent_id: Filter by parent agent ID
        
        Returns:
            List of matching agent registrations
        """
        with self._lock:
            registrations = list(self._instances.values())
        
        if role:
            registrations = [r for r in registrations if r.role == role]
        
        if parent_agent_id is not None:
            registrations = [
                r for r in registrations
                if r.parent_agent_id == parent_agent_id
            ]
        
        return registrations
    
    def get_agent_hierarchy(self, root_agent_id: str) -> Dict[str, List[str]]:
        """
        Get the hierarchy of agents starting from a root agent.
        
        Args:
            root_agent_id: ID of the root agent
        
        Returns:
            Dictionary mapping agent_id to list of child agent_ids
        """
        hierarchy = {}
        
        def build_hierarchy(agent_id: str):
            children = [
                r.agent_id
                for r in self.list_registrations(parent_agent_id=agent_id)
            ]
            hierarchy[agent_id] = children
            for child_id in children:
                build_hierarchy(child_id)
        
        build_hierarchy(root_agent_id)
        return hierarchy
    
    def supports_sub_agents(self, role: AgentRole) -> bool:
        """
        Check if an agent role supports spawning sub-agents.
        
        Args:
            role: The agent role to check
        
        Returns:
            True if the role supports sub-agents, False otherwise
        """
        factory = self.get_factory(role)
        return factory.supports_sub_agents if factory else False
    
    def get_statistics(self) -> Dict[str, Any]:
        """
        Get statistics about registered agents.
        
        Returns:
            Dictionary with agent statistics
        """
        with self._lock:
            stats = {
                "total_factories": len(self._factories),
                "total_instances": len(self._instances),
                "instances_by_role": {},
            }
            
            for registration in self._instances.values():
                role_name = registration.role.value
                if role_name not in stats["instances_by_role"]:
                    stats["instances_by_role"][role_name] = 0
                stats["instances_by_role"][role_name] += 1
            
            return stats
    
    def clear(self) -> None:
        """Clear all factories and instances."""
        with self._lock:
            self._factories.clear()
            self._instances.clear()
    
    def __len__(self) -> int:
        """Return the number of registered agent instances."""
        with self._lock:
            return len(self._instances)
    
    def __repr__(self) -> str:
        """String representation of the registry."""
        stats = self.get_statistics()
        return (
            f"<AgentRegistry "
            f"factories={stats['total_factories']} "
            f"instances={stats['total_instances']}>"
        )


# Global agent registry instance
_global_agent_registry: Optional[AgentRegistry] = None


def get_agent_registry() -> AgentRegistry:
    """
    Get the global agent registry instance.
    
    Returns:
        The global AgentRegistry instance
    """
    global _global_agent_registry
    if _global_agent_registry is None:
        _global_agent_registry = AgentRegistry()
    return _global_agent_registry


def reset_agent_registry() -> None:
    """Reset the global agent registry (useful for testing)."""
    global _global_agent_registry
    if _global_agent_registry is not None:
        _global_agent_registry.clear()
    _global_agent_registry = None
