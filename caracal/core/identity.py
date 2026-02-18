"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Principal identity management for Caracal Core.

This module provides the AgentRegistry (to be renamed to PrincipalRegistry) 
for managing principal identities, including registration and persistence.
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
    Represents a principal's authority identity.
    
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
    Manages principal identity lifecycle with JSON persistence.
    
    Provides methods to register, retrieve, and list agents.
    Implements atomic write operations and rolling backups.
    """

    def __init__(self, registry_path: str, backup_count: int = 3, delegation_token_manager=None):
        """
        Initialize AgentRegistry.
        
        Args:
            registry_path: Path to the agent registry JSON file
            backup_count: Number of rolling backups to maintain (default: 3)
            delegation_token_manager: Optional DelegationTokenManager for generating delegation tokens
        """
        self.registry_path = Path(registry_path)
        self.backup_count = backup_count
        self.delegation_token_manager = delegation_token_manager
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
        parent_agent_id: Optional[str] = None,
        generate_keys: bool = True
    ) -> AgentIdentity:
        """
        Register a new agent with unique identity.
        
        Args:
            name: Human-readable agent name (must be unique)
            owner: Owner identifier
            metadata: Optional extensible metadata
            parent_agent_id: Optional parent agent ID for hierarchical relationships
            generate_keys: Whether to generate ECDSA key pair for delegation tokens (default: True)
            
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
        
        # Initialize metadata
        if metadata is None:
            metadata = {}
        
        # Generate ECDSA key pair if requested and delegation_token_manager available
        if generate_keys and self.delegation_token_manager is not None:
            try:
                private_key_pem, public_key_pem = self.delegation_token_manager.generate_key_pair()
                metadata["private_key_pem"] = private_key_pem.decode('utf-8')
                metadata["public_key_pem"] = public_key_pem.decode('utf-8')
                logger.debug(f"Generated ECDSA key pair for agent {agent_id}")
            except Exception as e:
                logger.warning(f"Failed to generate key pair for agent {agent_id}: {e}")
                # Continue without keys - not critical for agent registration
        
        # Create agent identity
        agent = AgentIdentity(
            agent_id=agent_id,
            name=name,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata=metadata,
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

    def create_agent(self, *args, **kwargs) -> AgentIdentity:
        """Alias for register_agent for backward compatibility."""
        return self.register_agent(*args, **kwargs)

    def update_agent(
        self,
        agent_id: str,
        parent_agent_id: Optional[str] = None,
    ) -> AgentIdentity:
        """
        Update an existing agent.
        
        Args:
            agent_id: ID of agent to update
            parent_agent_id: New parent agent ID (optional)
            
        Returns:
            Updated AgentIdentity
            
        Raises:
            AgentNotFoundError: If agent doesn't exist
            ValueError: If invalid parent assignment (self-parenting, cycles)
        """
        agent = self.get_agent(agent_id)
        if not agent:
             raise AgentNotFoundError(f"Agent {agent_id} not found")
             
        if parent_agent_id:
            if parent_agent_id == agent_id:
                raise ValueError("Agent cannot be its own parent")
            
            parent = self.get_agent(parent_agent_id)
            if not parent:
                raise AgentNotFoundError(f"Parent agent {parent_agent_id} not found")
                
            # Cycle detection
            curr = parent
            seen = {agent_id}
            while curr and curr.parent_agent_id:
                if curr.parent_agent_id in seen:
                    raise ValueError("Detected cycle in parent-child relationship")
                seen.add(curr.agent_id)
                curr = self.get_agent(curr.parent_agent_id)
        
        # Update fields
        agent.parent_agent_id = parent_agent_id
        
        # Persist
        self._persist()
        
        logger.info(f"Updated agent {agent_id}: parent_id={parent_agent_id}")
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

    def generate_delegation_token(
        self,
        parent_agent_id: str,
        child_agent_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None
    ) -> Optional[str]:
        """
        Generate a delegation token for a child agent.
        
        Args:
            parent_agent_id: Parent agent ID (issuer)
            child_agent_id: Child agent ID (subject)
            expiration_seconds: Token validity duration (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            
        Returns:
            JWT token string, or None if delegation_token_manager not available
            
        Raises:
            AgentNotFoundError: If parent or child agent does not exist
        """
        if self.delegation_token_manager is None:
            logger.warning("Cannot generate delegation token: DelegationTokenManager not available")
            return None
        
        # Validate agents exist
        parent = self.get_agent(parent_agent_id)
        if parent is None:
            raise AgentNotFoundError(f"Parent agent with ID '{parent_agent_id}' does not exist")
        
        child = self.get_agent(child_agent_id)
        if child is None:
            raise AgentNotFoundError(f"Child agent with ID '{child_agent_id}' does not exist")
        
        # Validate parent-child relationship
        if child.parent_agent_id != parent_agent_id:
            logger.warning(
                f"Agent {child_agent_id} is not a child of {parent_agent_id} "
                f"(parent is {child.parent_agent_id})"
            )
        
        # Generate token
        from uuid import UUID
        
        token = self.delegation_token_manager.generate_token(
            parent_agent_id=UUID(parent_agent_id),
            child_agent_id=UUID(child_agent_id),
            expiration_seconds=expiration_seconds,
            allowed_operations=allowed_operations
        )
        
        # Store token metadata in child agent
        if "delegation_tokens" not in child.metadata:
            child.metadata["delegation_tokens"] = []
        
        child.metadata["delegation_tokens"].append({
            "token_id": token[:20] + "...",  # Store truncated token for reference
            "parent_agent_id": parent_agent_id,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "expires_in_seconds": expiration_seconds
        })
        
        # Persist updated metadata
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist delegation token metadata: {e}", exc_info=True)
            # Don't fail - token is still valid even if metadata not persisted
        
        logger.info(
            f"Generated delegation token: parent={parent_agent_id}, child={child_agent_id}"
        )
        
        return token

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
