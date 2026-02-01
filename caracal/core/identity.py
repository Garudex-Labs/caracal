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
from caracal.logging_config import get_logger
from caracal.core.retry import retry_on_transient_failure

logger = get_logger(__name__)


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
        parent_agent_id: Optional parent agent ID for hierarchical relationships
    """
    agent_id: str
    name: str
    owner: str
    created_at: str  # ISO 8601 format
    metadata: Dict[str, Any]
    parent_agent_id: Optional[str] = None

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
            logger.info(f"Loaded {len(self._agents)} agents from {self.registry_path}")
        else:
            logger.info(f"Initialized new agent registry at {self.registry_path}")

    def register_agent(
        self, 
        name: str, 
        owner: str, 
        metadata: Optional[Dict[str, Any]] = None,
        parent_agent_id: Optional[str] = None
    ) -> AgentIdentity:
        """
        Register a new agent with unique identity.
        
        Args:
            name: Human-readable agent name (must be unique)
            owner: Owner identifier
            metadata: Optional extensible metadata
            parent_agent_id: Optional parent agent ID for hierarchical relationships
            
        Returns:
            AgentIdentity: The newly created agent identity
            
        Raises:
            DuplicateAgentNameError: If agent name already exists
            AgentNotFoundError: If parent_agent_id is provided but parent doesn't exist
        """
        # Validate unique name
        if name in self._names:
            logger.warning(f"Attempted to register duplicate agent name: {name}")
            raise DuplicateAgentNameError(
                f"Agent with name '{name}' already exists"
            )
        
        # Validate parent existence if provided
        if parent_agent_id is not None:
            parent = self.get_agent(parent_agent_id)
            if parent is None:
                logger.warning(f"Attempted to register agent with non-existent parent: {parent_agent_id}")
                raise AgentNotFoundError(
                    f"Parent agent with ID '{parent_agent_id}' does not exist"
                )
        
        # Generate UUID v4 for agent ID
        agent_id = str(uuid.uuid4())
        
        # Create agent identity
        agent = AgentIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata=metadata or {},
            parent_agent_id=parent_agent_id
        )
        
        # Add to registry
        self._agents[agent_id] = agent
        self._names[name] = agent_id
        
        # Persist to disk
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist agent registry to {self.registry_path}: {e}", exc_info=True)
            raise FileWriteError(
                f"Failed to persist agent registry to {self.registry_path}: {e}"
            ) from e
        
        logger.info(f"Registered agent: id={agent_id}, name={name}, owner={owner}, parent_id={parent_agent_id}")
        
        return agent

    def get_agent(self, agent_id: str) -> Optional[AgentIdentity]:
        """
        Retrieve agent by ID.
        
        Args:
            agent_id: The agent's unique identifier
            
        Returns:
            AgentIdentity if found, None otherwise
        """
        agent = self._agents.get(agent_id)
        if agent:
            logger.debug(f"Retrieved agent: id={agent_id}, name={agent.name}")
        else:
            logger.debug(f"Agent not found: id={agent_id}")
        return agent

    def list_agents(self) -> List[AgentIdentity]:
        """
        List all registered agents.
        
        Returns:
            List of all AgentIdentity objects
        """
        return list(self._agents.values())

    def get_children(self, agent_id: str) -> List[AgentIdentity]:
        """
        Get all direct children of an agent.
        
        Args:
            agent_id: The parent agent's unique identifier
            
        Returns:
            List of AgentIdentity objects that are direct children of the agent
        """
        children = [
            agent for agent in self._agents.values()
            if agent.parent_agent_id == agent_id
        ]
        logger.debug(f"Found {len(children)} direct children for agent {agent_id}")
        return children

    def get_descendants(self, agent_id: str) -> List[AgentIdentity]:
        """
        Get all descendants (children, grandchildren, etc.) recursively.
        
        Args:
            agent_id: The ancestor agent's unique identifier
            
        Returns:
            List of all AgentIdentity objects in the descendant tree
        """
        descendants = []
        
        # Get direct children
        children = self.get_children(agent_id)
        
        # Add children to descendants
        descendants.extend(children)
        
        # Recursively get descendants of each child
        for child in children:
            descendants.extend(self.get_descendants(child.agent_id))
        
        logger.debug(f"Found {len(descendants)} total descendants for agent {agent_id}")
        return descendants

    @retry_on_transient_failure(max_retries=3, base_delay=0.1, backoff_factor=2.0)
    def _persist(self) -> None:
        """
        Persist registry to disk using atomic write strategy.
        
        Steps:
        1. Create backup of existing file
        2. Write to temporary file (.tmp)
        3. Flush to disk (fsync)
        4. Atomically rename to target file
        
        Implements retry logic with exponential backoff:
        - Retries up to 3 times on transient failures (OSError, IOError)
        - Uses exponential backoff: 0.1s, 0.2s, 0.4s
        - Fails permanently after max retries
        
        Raises:
            OSError: If write operation fails after all retries
        """
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
        
        logger.debug(f"Persisted {len(self._agents)} agents to {self.registry_path}")

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
            
            logger.debug(f"Created backup of agent registry at {backup_path}")
            
        except Exception as e:
            # Log warning but don't fail the operation
            # Backup failure shouldn't prevent writes
            logger.warning(f"Failed to create backup of agent registry: {e}")

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
            
            logger.debug(f"Loaded {len(self._agents)} agents from {self.registry_path}")
                
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse agent registry JSON from {self.registry_path}: {e}", exc_info=True)
            raise FileReadError(
                f"Failed to parse agent registry JSON from {self.registry_path}: {e}"
            ) from e
        except Exception as e:
            logger.error(f"Failed to load agent registry from {self.registry_path}: {e}", exc_info=True)
            raise FileReadError(
                f"Failed to load agent registry from {self.registry_path}: {e}"
            ) from e
