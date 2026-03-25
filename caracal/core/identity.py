"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Principal identity management for Caracal Core.

This module provides the PrincipalRegistry (to be renamed to PrincipalRegistry) 
for managing principal identities, including registration and persistence.
"""

import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from caracal.exceptions import (
    PrincipalNotFoundError,
    DuplicatePrincipalNameError,
    FileReadError,
    FileWriteError,
)
from caracal.logging_config import get_logger
from caracal.core.retry import retry_on_transient_failure

logger = get_logger(__name__)


class VerificationStatus(Enum):
    """
    Agent verification status.
    
    Enhancements over ASE:
    - Provides graduated trust levels for agents
    - Enables trust-based access control
    """
    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    TRUSTED = "trusted"


@dataclass
class PrincipalIdentity:
    """
    Enhanced agent identity with verification and trust management.
    
    Improvements over ASE:
    - Verification status tracking (unverified, verified, trusted)
    - Trust level scoring (0-100) for graduated authorization
    - Capability declarations for fine-grained permission checks
    - Temporal tracking (created_at, last_verified_at) for audit and compliance
    - Extensible metadata for additional attributes
    
    Attributes:
        principal_id: Globally unique identifier (UUID v4)
        name: Human-readable agent name
        owner: Owner identifier (email or username)
        created_at: Timestamp when agent was registered (ISO 8601 format)
        metadata: Extensible metadata dictionary
        public_key: Optional public key for signature verification
        org_id: Optional organization identifier
        role: Optional role identifier for role-based access
        verification_status: Verification status (unverified, verified, trusted)
        trust_level: Trust score from 0-100
        capabilities: List of declared capabilities
        last_verified_at: Optional timestamp of last verification
    """
    principal_id: str
    name: str
    owner: str
    created_at: str  # ISO 8601 format
    metadata: Dict[str, Any]
    principal_type: str = "agent"
    public_key: Optional[str] = None
    org_id: Optional[str] = None
    role: Optional[str] = None
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    trust_level: int = 0
    capabilities: List[str] = field(default_factory=list)
    last_verified_at: Optional[str] = None  # ISO 8601 format

    def __post_init__(self):
        """Validate fields after initialization."""
        if not self.principal_id or not isinstance(self.principal_id, str):
            raise ValueError("principal_id must be non-empty string")
        
        if not 0 <= self.trust_level <= 100:
            raise ValueError("trust_level must be between 0 and 100")
        
        # Convert string verification_status to enum if needed
        if isinstance(self.verification_status, str):
            self.verification_status = VerificationStatus(self.verification_status)

    def has_capability(self, capability: str) -> bool:
        """
        Check if agent has declared capability.
        
        Args:
            capability: Capability to check for
            
        Returns:
            True if agent has the capability
        """
        return capability in self.capabilities

    def is_verified(self) -> bool:
        """
        Check if agent is verified or trusted.
        
        Returns:
            True if verification_status is VERIFIED or TRUSTED
        """
        return self.verification_status in [VerificationStatus.VERIFIED, VerificationStatus.TRUSTED]

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for JSON serialization.
        
        Returns:
            Dictionary representation with all fields
        """
        return {
            "principal_id": self.principal_id,
            "principal_type": self.principal_type,
            "name": self.name,
            "owner": self.owner,
            "created_at": self.created_at,
            "metadata": self.metadata,
            "public_key": self.public_key,
            "org_id": self.org_id,
            "role": self.role,
            "verification_status": self.verification_status.value,
            "trust_level": self.trust_level,
            "capabilities": self.capabilities,
            "last_verified_at": self.last_verified_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PrincipalIdentity":
        """
        Create PrincipalIdentity from dictionary.
        
        Args:
            data: Dictionary containing identity data
            
        Returns:
            PrincipalIdentity instance
        """
        # Handle verification_status conversion
        verification_status = data.get("verification_status", "unverified")
        if isinstance(verification_status, str):
            verification_status = VerificationStatus(verification_status)
        
        return cls(
            principal_id=data["principal_id"],
            principal_type=data.get("principal_type", "agent"),
            name=data["name"],
            owner=data["owner"],
            created_at=data["created_at"],
            metadata=data["metadata"],
            public_key=data.get("public_key"),
            org_id=data.get("org_id"),
            role=data.get("role"),
            verification_status=verification_status,
            trust_level=data.get("trust_level", 0),
            capabilities=data.get("capabilities", []),
            last_verified_at=data.get("last_verified_at")
        )


class PrincipalRegistry:
    """
    Manages principal identity lifecycle with JSON persistence.
    
    Provides methods to register, retrieve, and list agents.
    Implements atomic write operations and rolling backups.
    """

    def __init__(self, registry_path: str, backup_count: int = 3, delegation_token_manager=None):
        """
        Initialize PrincipalRegistry.
        
        Args:
            registry_path: Path to the agent registry JSON file
            backup_count: Number of rolling backups to maintain (default: 3)
            delegation_token_manager: Optional DelegationTokenManager for generating delegation tokens
        """
        self.registry_path = Path(registry_path)
        self.backup_count = backup_count
        self.delegation_token_manager = delegation_token_manager
        self._agents: Dict[str, PrincipalIdentity] = {}
        self._names: Dict[str, str] = {}  # name -> principal_id mapping for uniqueness
        
        # Ensure parent directory exists
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Load existing registry if it exists
        if self.registry_path.exists():
            self._load()
            logger.info(f"Loaded {len(self._agents)} agents from {self.registry_path}")
        else:
            logger.info(f"Initialized new agent registry at {self.registry_path}")

    def register_principal(
        self, 
        name: str,
        owner: str,
        principal_type: str = "agent", 
        metadata: Optional[Dict[str, Any]] = None,
        generate_keys: bool = True
    ) -> PrincipalIdentity:
        """
        Register a new agent with unique identity.
        
        Args:
            name: Human-readable agent name (must be unique)
            owner: Owner identifier
            metadata: Optional extensible metadata
            generate_keys: Whether to generate ECDSA key pair for delegation tokens (default: True)
            
        Returns:
            PrincipalIdentity: The newly created agent identity
            
        Raises:
            DuplicatePrincipalNameError: If agent name already exists
        """
        # Validate unique name
        if name in self._names:
            logger.warning(f"Attempted to register duplicate agent name: {name}")
            raise DuplicatePrincipalNameError(
                f"Agent with name '{name}' already exists"
            )
        
        # Generate UUID v4 for agent ID
        principal_id = str(uuid.uuid4())
        
        # Initialize metadata
        if metadata is None:
            metadata = {}
        
        # Generate ECDSA key pair if requested and delegation_token_manager available
        if generate_keys and self.delegation_token_manager is not None:
            try:
                private_key_pem, public_key_pem = self.delegation_token_manager.generate_key_pair()
                metadata["private_key_pem"] = private_key_pem.decode('utf-8')
                metadata["public_key_pem"] = public_key_pem.decode('utf-8')
                logger.debug(f"Generated ECDSA key pair for agent {principal_id}")
            except Exception as e:
                logger.warning(f"Failed to generate key pair for agent {principal_id}: {e}")
                # Continue without keys - not critical for agent registration
        
        # Create agent identity
        agent = PrincipalIdentity(
            principal_id=principal_id,
            name=name,
            principal_type=principal_type,
            owner=owner,
            created_at=datetime.utcnow().isoformat() + "Z",
            metadata=metadata,
        )
        
        # Add to registry
        self._agents[principal_id] = agent
        self._names[name] = principal_id
        
        # Persist to disk
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist agent registry to {self.registry_path}: {e}", exc_info=True)
            raise FileWriteError(
                f"Failed to persist agent registry to {self.registry_path}: {e}"
            ) from e
        
        logger.info(f"Registered agent: id={principal_id}, name={name}, owner={owner}")
        
        return agent

    def create_principal(self, *args, **kwargs) -> PrincipalIdentity:
        """Alias for register_principal for backward compatibility."""
        return self.register_principal(*args, **kwargs)

    def update_agent(
        self,
        principal_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PrincipalIdentity:
        """
        Update an existing agent's metadata.
        
        Args:
            principal_id: ID of agent to update
            metadata: Metadata fields to merge into existing metadata
            
        Returns:
            Updated PrincipalIdentity
            
        Raises:
            PrincipalNotFoundError: If agent doesn't exist
        """
        agent = self.get_principal(principal_id)
        if not agent:
             raise PrincipalNotFoundError(f"Agent {principal_id} not found")
             
        # Update metadata
        if metadata:
            agent.metadata.update(metadata)
        
        # Persist
        self._persist()
        
        logger.info(f"Updated agent {principal_id}")
        return agent

    def get_principal(self, principal_id: str) -> Optional[PrincipalIdentity]:
        """
        Retrieve agent by ID.
        
        Args:
            principal_id: The agent's unique identifier
            
        Returns:
            PrincipalIdentity if found, None otherwise
        """
        agent = self._agents.get(principal_id)
        if agent:
            logger.debug(f"Retrieved agent: id={principal_id}, name={agent.name}")
        else:
            logger.debug(f"Agent not found: id={principal_id}")
        return agent

    def list_principals(self) -> List[PrincipalIdentity]:
        """
        List all registered agents.
        
        Returns:
            List of all PrincipalIdentity objects
        """
        return list(self._agents.values())

    def generate_delegation_token(
        self,
        source_principal_id: str,
        target_principal_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        delegation_type: str = "hierarchical",
        source_principal_type: str = "agent",
        target_principal_type: str = "agent",
        context_tags: Optional[List[str]] = None,
    ) -> Optional[str]:
        """
        Generate a delegation token from source to target agent.
        
        Args:
            source_principal_id: Source agent ID (issuer/delegator)
            target_principal_id: Target agent ID (subject/delegate)
            expiration_seconds: Token validity duration (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            delegation_type: Type of delegation (hierarchical/peer)
            source_principal_type: Type of delegating principal (user/agent/service)
            target_principal_type: Type of receiving principal (user/agent/service)
            context_tags: Context tags for dynamic authority filtering
            
        Returns:
            JWT token string, or None if delegation_token_manager not available
            
        Raises:
            PrincipalNotFoundError: If source or target agent does not exist
        """
        if self.delegation_token_manager is None:
            logger.warning("Cannot generate delegation token: DelegationTokenManager not available")
            return None
        
        # Validate agents exist
        source = self.get_principal(source_principal_id)
        if source is None:
            raise PrincipalNotFoundError(f"Source agent with ID '{source_principal_id}' does not exist")
        
        target = self.get_principal(target_principal_id)
        if target is None:
            raise PrincipalNotFoundError(f"Target agent with ID '{target_principal_id}' does not exist")
        
        # Generate token
        from uuid import UUID
        
        token = self.delegation_token_manager.generate_token(
            source_principal_id=UUID(source_principal_id),
            target_principal_id=UUID(target_principal_id),
            expiration_seconds=expiration_seconds,
            allowed_operations=allowed_operations,
            delegation_type=delegation_type,
            source_principal_type=source_principal_type,
            target_principal_type=target_principal_type,
            context_tags=context_tags,
        )
        
        # Store token metadata in target agent
        if "delegation_tokens" not in target.metadata:
            target.metadata["delegation_tokens"] = []
        
        target.metadata["delegation_tokens"].append({
            "token_id": token[:20] + "...",  # Store truncated token for reference
            "source_principal_id": source_principal_id,
            "delegation_type": delegation_type,
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
            f"Generated delegation token: source={source_principal_id}, target={target_principal_id}, "
            f"type={delegation_type}"
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
                agent = PrincipalIdentity.from_dict(agent_data)
                self._agents[agent.principal_id] = agent
                self._names[agent.name] = agent.principal_id
            
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
