"""
Agent identity management for Caracal Core.

This module provides the AgentRegistry for managing agent identities,
including registration, retrieval, and persistence.
"""

import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from caracal.exceptions import (
    AgentNotFoundError,
    DuplicateAgentNameError,
    FileReadError,
    FileWriteError,
)


@dataclass
class AgentIdentity:
    """
    Represents an agent's economic identity.
    
    Attributes:
        agent_id: Globally unique identifier (UUID v4)
        name: Human-readable agent name
        owner: Owner identifier (email or username)
        created_at: Timestamp when agent was registered
        metadata: Extensible metadata dictionary
    """
    agent_id: str
    name: str
    owner: str
    created_at: str  # ISO 8601 format
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AgentIdentity":
        """Create AgentIdentity from dictionary."""
        return cls(**data)


class AgentRegistry:
    """
    Manages agent identity lifecycle with JSON persistence.
    
    Provides methods to register, retrieve, and list agents.
    Implements atomic write operations and rolling backups.
    """

    def __init__(self, registry_path: str, backup_count: int = 3):
        """
        Initialize AgentRegistry.
        
        Args:
            registry_path: Path to the agent registry JSON file
            backup_count: Number of rolling backups to maintain (default: 3)
        """
        self.registry_path = Path(registry_path)
        self.backup_count = backup_count
        self._agents: Dict[str, AgentIdentity] = {}
        self._names: Dict[str, str] = {}  # name -> agent_id mapping for uniqueness
        
        # Ensure parent directory exists
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Load existing registry if it exists
        if self.registry_path.exists():
            self._load()

    def register_agent(
        self, 
        name: str, 
        owner: str, 
        metadata: Optional[Dict[str, Any]] = None
    ) -> AgentIdentity:
        """
        Register a new agent with unique identity.
        
        Args:
            name: Human-readable agent name (must be unique)
            owner: Owner identifier
            metadata: Optional extensible metadata
            
        Returns:
            AgentIdentity: The newly created agent identity
            
        Raises:
            DuplicateAgentNameError: If agent name already exists
        """
        # Validate unique name
        if name in self._names:
            raise DuplicateAgentNameError(
                f"Agent with name '{name}' already exists"
            )
        
        # Generate UUID v4 for agent ID
        agent_id = str(uuid.uuid4())
        
        # Create agent identity
        agent = AgentIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata=metadata or {}
        )
        
        # Add to registry
        self._agents[agent_id] = agent
        self._names[name] = agent_id
        
        # Persist to disk
        self._persist()
        
        return agent

    def get_agent(self, agent_id: str) -> Optional[AgentIdentity]:
        """
        Retrieve agent by ID.
        
        Args:
            agent_id: The agent's unique identifier
            
        Returns:
            AgentIdentity if found, None otherwise
        """
        return self._agents.get(agent_id)

    def list_agents(self) -> List[AgentIdentity]:
        """
        List all registered agents.
        
        Returns:
            List of all AgentIdentity objects
        """
        return list(self._agents.values())

    def _persist(self) -> None:
        """
        Persist registry to disk using atomic write strategy.
        
        Steps:
        1. Create backup of existing file
        2. Write to temporary file (.tmp)
        3. Flush to disk (fsync)
        4. Atomically rename to target file
        
        Raises:
            FileWriteError: If write operation fails
        """
        try:
            # Create backup before writing
            self._create_backup()
            
            # Prepare data for serialization
            data = [agent.to_dict() for agent in self._agents.values()]
            
            # Write to temporary file
            tmp_path = self.registry_path.with_suffix('.tmp')
            with open(tmp_path, 'w') as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())  # Force write to disk
            
            # Atomic rename (POSIX guarantees atomicity)
            # On Windows, may need to remove target first
            if os.name == 'nt' and self.registry_path.exists():
                self.registry_path.unlink()
            tmp_path.rename(self.registry_path)
            
        except Exception as e:
            raise FileWriteError(
                f"Failed to persist agent registry to {self.registry_path}: {e}"
            ) from e

    def _create_backup(self) -> None:
        """
        Create rolling backup of registry file.
        
        Rotates backups:
        - agents.json.bak.3 -> deleted
        - agents.json.bak.2 -> agents.json.bak.3
        - agents.json.bak.1 -> agents.json.bak.2
        - agents.json -> agents.json.bak.1
        """
        if not self.registry_path.exists():
            return
        
        try:
            # Delete oldest backup if it exists
            oldest_backup = Path(f"{self.registry_path}.bak.{self.backup_count}")
            if oldest_backup.exists():
                oldest_backup.unlink()
            
            # Rotate existing backups (from newest to oldest)
            for i in range(self.backup_count - 1, 0, -1):
                old_backup = Path(f"{self.registry_path}.bak.{i}")
                new_backup = Path(f"{self.registry_path}.bak.{i + 1}")
                
                if old_backup.exists():
                    old_backup.rename(new_backup)
            
            # Create new backup
            backup_path = Path(f"{self.registry_path}.bak.1")
            shutil.copy2(self.registry_path, backup_path)
            
        except Exception as e:
            # Log warning but don't fail the operation
            # Backup failure shouldn't prevent writes
            import logging
            logging.warning(f"Failed to create backup of agent registry: {e}")

    def _load(self) -> None:
        """
        Load registry from disk.
        
        Raises:
            FileReadError: If read operation fails
        """
        try:
            with open(self.registry_path, 'r') as f:
                data = json.load(f)
            
            # Reconstruct agents dictionary
            self._agents = {}
            self._names = {}
            
            for agent_data in data:
                agent = AgentIdentity.from_dict(agent_data)
                self._agents[agent.agent_id] = agent
                self._names[agent.name] = agent.agent_id
                
        except json.JSONDecodeError as e:
            raise FileReadError(
                f"Failed to parse agent registry JSON from {self.registry_path}: {e}"
            ) from e
        except Exception as e:
            raise FileReadError(
                f"Failed to load agent registry from {self.registry_path}: {e}"
            ) from e
