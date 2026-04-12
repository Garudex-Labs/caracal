"""
Agent state management system.

This module provides centralized state management for all agents in the system,
allowing tracking of agent lifecycle, message history, and inter-agent relationships.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional
from threading import Lock

from examples.langchain_demo.agents.base import AgentState, AgentMessage, AgentRole


@dataclass
class StateSnapshot:
    """
    Snapshot of the entire agent system state at a point in time.
    
    Attributes:
        timestamp: When the snapshot was taken
        agents: Dictionary of agent_id -> AgentState
        total_agents: Total number of agents
        active_agents: Number of currently active agents
        completed_agents: Number of completed agents
        error_agents: Number of agents in error state
    """
    
    timestamp: datetime
    agents: Dict[str, AgentState]
    total_agents: int
    active_agents: int
    completed_agents: int
    error_agents: int
    
    def to_dict(self) -> Dict:
        """Convert snapshot to dictionary for serialization."""
        return {
            "timestamp": self.timestamp.isoformat(),
            "agents": {
                agent_id: state.to_dict()
                for agent_id, state in self.agents.items()
            },
            "total_agents": self.total_agents,
            "active_agents": self.active_agents,
            "completed_agents": self.completed_agents,
            "error_agents": self.error_agents,
        }


class AgentStateManager:
    """
    Centralized state manager for all agents in the system.
    
    This class provides thread-safe state management, allowing multiple agents
    to register, update their state, and query the state of other agents.
    
    Attributes:
        _states: Dictionary mapping agent_id to AgentState
        _lock: Thread lock for thread-safe operations
        _snapshots: List of historical state snapshots
    """
    
    def __init__(self):
        """Initialize the state manager."""
        self._states: Dict[str, AgentState] = {}
        self._lock = Lock()
        self._snapshots: List[StateSnapshot] = []
    
    def register_agent(self, state: AgentState) -> None:
        """
        Register a new agent with the state manager.
        
        Args:
            state: Initial state of the agent
        """
        with self._lock:
            self._states[state.agent_id] = state
    
    def update_agent_state(self, agent_id: str, state: AgentState) -> None:
        """
        Update the state of an existing agent.
        
        Args:
            agent_id: ID of the agent to update
            state: New state for the agent
        
        Raises:
            KeyError: If agent_id is not registered
        """
        with self._lock:
            if agent_id not in self._states:
                raise KeyError(f"Agent {agent_id} not registered")
            self._states[agent_id] = state
    
    def get_agent_state(self, agent_id: str) -> Optional[AgentState]:
        """
        Get the current state of an agent.
        
        Args:
            agent_id: ID of the agent
        
        Returns:
            AgentState if found, None otherwise
        """
        with self._lock:
            return self._states.get(agent_id)
    
    def get_all_states(self) -> Dict[str, AgentState]:
        """
        Get the current state of all agents.
        
        Returns:
            Dictionary mapping agent_id to AgentState
        """
        with self._lock:
            return dict(self._states)
    
    def get_agents_by_role(self, role: AgentRole) -> List[AgentState]:
        """
        Get all agents with a specific role.
        
        Args:
            role: The agent role to filter by
        
        Returns:
            List of AgentState objects with the specified role
        """
        with self._lock:
            return [
                state for state in self._states.values()
                if state.agent_role == role
            ]
    
    def get_agents_by_status(self, status: str) -> List[AgentState]:
        """
        Get all agents with a specific status.
        
        Args:
            status: The status to filter by (active, completed, error)
        
        Returns:
            List of AgentState objects with the specified status
        """
        with self._lock:
            return [
                state for state in self._states.values()
                if state.status == status
            ]
    
    def get_sub_agents(self, parent_agent_id: str) -> List[AgentState]:
        """
        Get all sub-agents spawned by a parent agent.
        
        Args:
            parent_agent_id: ID of the parent agent
        
        Returns:
            List of AgentState objects that are children of the parent
        """
        with self._lock:
            return [
                state for state in self._states.values()
                if state.parent_agent_id == parent_agent_id
            ]
    
    def get_agent_hierarchy(self, root_agent_id: str) -> Dict[str, List[str]]:
        """
        Get the complete hierarchy of agents starting from a root agent.
        
        Args:
            root_agent_id: ID of the root agent
        
        Returns:
            Dictionary mapping agent_id to list of child agent_ids
        """
        hierarchy = {}
        
        def build_hierarchy(agent_id: str):
            children = [
                state.agent_id
                for state in self.get_sub_agents(agent_id)
            ]
            hierarchy[agent_id] = children
            for child_id in children:
                build_hierarchy(child_id)
        
        with self._lock:
            build_hierarchy(root_agent_id)
        
        return hierarchy
    
    def get_all_messages(self) -> List[AgentMessage]:
        """
        Get all messages from all agents, sorted by timestamp.
        
        Returns:
            List of all AgentMessage objects, sorted chronologically
        """
        with self._lock:
            all_messages = []
            for state in self._states.values():
                all_messages.extend(state.messages)
            
            # Sort by timestamp
            all_messages.sort(key=lambda msg: msg.timestamp)
            return all_messages
    
    def get_messages_by_agent(self, agent_id: str) -> List[AgentMessage]:
        """
        Get all messages from a specific agent.
        
        Args:
            agent_id: ID of the agent
        
        Returns:
            List of AgentMessage objects from the specified agent
        """
        state = self.get_agent_state(agent_id)
        return state.messages if state else []
    
    def get_messages_by_role(self, role: AgentRole) -> List[AgentMessage]:
        """
        Get all messages from agents with a specific role.
        
        Args:
            role: The agent role to filter by
        
        Returns:
            List of AgentMessage objects from agents with the specified role
        """
        with self._lock:
            messages = []
            for state in self._states.values():
                if state.agent_role == role:
                    messages.extend(state.messages)
            
            # Sort by timestamp
            messages.sort(key=lambda msg: msg.timestamp)
            return messages
    
    def create_snapshot(self) -> StateSnapshot:
        """
        Create a snapshot of the current state of all agents.
        
        Returns:
            StateSnapshot containing the current state
        """
        with self._lock:
            agents_copy = dict(self._states)
            
            # Calculate statistics
            total = len(agents_copy)
            active = sum(1 for s in agents_copy.values() if s.status == "active")
            completed = sum(1 for s in agents_copy.values() if s.status == "completed")
            error = sum(1 for s in agents_copy.values() if s.status == "error")
            
            snapshot = StateSnapshot(
                timestamp=datetime.utcnow(),
                agents=agents_copy,
                total_agents=total,
                active_agents=active,
                completed_agents=completed,
                error_agents=error,
            )
            
            self._snapshots.append(snapshot)
            return snapshot
    
    def get_snapshots(self) -> List[StateSnapshot]:
        """
        Get all historical state snapshots.
        
        Returns:
            List of StateSnapshot objects
        """
        with self._lock:
            return list(self._snapshots)
    
    def get_statistics(self) -> Dict[str, int]:
        """
        Get current statistics about agents in the system.
        
        Returns:
            Dictionary with agent statistics
        """
        with self._lock:
            stats = {
                "total_agents": len(self._states),
                "active_agents": 0,
                "completed_agents": 0,
                "error_agents": 0,
                "total_messages": 0,
                "total_tool_calls": 0,
            }
            
            for state in self._states.values():
                if state.status == "active":
                    stats["active_agents"] += 1
                elif state.status == "completed":
                    stats["completed_agents"] += 1
                elif state.status == "error":
                    stats["error_agents"] += 1
                
                stats["total_messages"] += len(state.messages)
                stats["total_tool_calls"] += len(state.tool_calls)
            
            return stats
    
    def clear(self) -> None:
        """Clear all agent states and snapshots."""
        with self._lock:
            self._states.clear()
            self._snapshots.clear()
    
    def __len__(self) -> int:
        """Return the number of registered agents."""
        with self._lock:
            return len(self._states)
    
    def __repr__(self) -> str:
        """String representation of the state manager."""
        stats = self.get_statistics()
        return (
            f"<AgentStateManager "
            f"agents={stats['total_agents']} "
            f"active={stats['active_agents']} "
            f"completed={stats['completed_agents']}>"
        )


# Global state manager instance
_global_state_manager: Optional[AgentStateManager] = None


def get_state_manager() -> AgentStateManager:
    """
    Get the global agent state manager instance.
    
    Returns:
        The global AgentStateManager instance
    """
    global _global_state_manager
    if _global_state_manager is None:
        _global_state_manager = AgentStateManager()
    return _global_state_manager


def reset_state_manager() -> None:
    """Reset the global state manager (useful for testing)."""
    global _global_state_manager
    if _global_state_manager is not None:
        _global_state_manager.clear()
    _global_state_manager = None
