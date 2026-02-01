"""
Policy management for Caracal Core.

This module provides the PolicyStore for managing budget policies,
including creation, retrieval, and persistence.
"""

import json
import os
import shutil
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

from caracal.exceptions import (
    AgentNotFoundError,
    FileReadError,
    FileWriteError,
    InvalidPolicyError,
)


@dataclass
class BudgetPolicy:
    """
    Represents a budget policy for an agent.
    
    Attributes:
        policy_id: Globally unique identifier (UUID v4)
        agent_id: Agent this policy applies to
        limit_amount: Maximum spend (as string to preserve precision)
        time_window: Time window for budget ("daily" in v0.1)
        currency: Currency code (e.g., "USD")
        created_at: Timestamp when policy was created
        active: Whether policy is currently active
    """
    policy_id: str
    agent_id: str
    limit_amount: str  # Store as string to preserve Decimal precision
    time_window: str
    currency: str
    created_at: str  # ISO 8601 format
    active: bool

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "BudgetPolicy":
        """Create BudgetPolicy from dictionary."""
        return cls(**data)
    
    def get_limit_decimal(self) -> Decimal:
        """Get limit amount as Decimal for calculations."""
        return Decimal(self.limit_amount)


class PolicyStore:
    """
    Manages budget policy lifecycle with JSON persistence.
    
    Provides methods to create, retrieve, and list policies.
    Implements atomic write operations and rolling backups.
    """

    def __init__(
        self, 
        policy_path: str, 
        agent_registry=None,
        backup_count: int = 3
    ):
        """
        Initialize PolicyStore.
        
        Args:
            policy_path: Path to the policy store JSON file
            agent_registry: Optional AgentRegistry for validating agent existence
            backup_count: Number of rolling backups to maintain (default: 3)
        """
        self.policy_path = Path(policy_path)
        self.agent_registry = agent_registry
        self.backup_count = backup_count
        self._policies: Dict[str, BudgetPolicy] = {}
        self._agent_policies: Dict[str, List[str]] = {}  # agent_id -> [policy_ids]
        
        # Ensure parent directory exists
        self.policy_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Load existing policies if file exists
        if self.policy_path.exists():
            self._load()

    def create_policy(
        self,
        agent_id: str,
        limit_amount: Decimal,
        time_window: str = "daily",
        currency: str = "USD"
    ) -> BudgetPolicy:
        """
        Create a new budget policy.
        
        Args:
            agent_id: Agent this policy applies to
            limit_amount: Maximum spend as Decimal
            time_window: Time window for budget (default: "daily")
            currency: Currency code (default: "USD")
            
        Returns:
            BudgetPolicy: The newly created policy
            
        Raises:
            InvalidPolicyError: If limit amount is not positive
            AgentNotFoundError: If agent does not exist (when registry provided)
        """
        # Validate positive limit amount
        if limit_amount <= 0:
            raise InvalidPolicyError(
                f"Limit amount must be positive, got {limit_amount}"
            )
        
        # Validate agent existence if registry is available
        if self.agent_registry is not None:
            agent = self.agent_registry.get_agent(agent_id)
            if agent is None:
                raise AgentNotFoundError(
                    f"Agent with ID '{agent_id}' does not exist"
                )
        
        # Validate time window (v0.1 only supports daily)
        if time_window != "daily":
            raise InvalidPolicyError(
                f"Only 'daily' time window is supported in v0.1, got '{time_window}'"
            )
        
        # Generate UUID v4 for policy ID
        policy_id = str(uuid.uuid4())
        
        # Create policy
        policy = BudgetPolicy(
            policy_id=policy_id,
            agent_id=agent_id,
            limit_amount=str(limit_amount),  # Store as string to preserve precision
            time_window=time_window,
            currency=currency,
            created_at=datetime.utcnow().isoformat() + "Z",
            active=True
        )
        
        # Add to store
        self._policies[policy_id] = policy
        
        # Update agent -> policies mapping
        if agent_id not in self._agent_policies:
            self._agent_policies[agent_id] = []
        self._agent_policies[agent_id].append(policy_id)
        
        # Persist to disk
        self._persist()
        
        return policy

    def get_policies(self, agent_id: str) -> List[BudgetPolicy]:
        """
        Get all active policies for an agent.
        
        Args:
            agent_id: The agent's unique identifier
            
        Returns:
            List of active BudgetPolicy objects for the agent
        """
        policy_ids = self._agent_policies.get(agent_id, [])
        policies = []
        
        for policy_id in policy_ids:
            policy = self._policies.get(policy_id)
            if policy and policy.active:
                policies.append(policy)
        
        return policies

    def list_all_policies(self) -> List[BudgetPolicy]:
        """
        List all policies in the system.
        
        Returns:
            List of all BudgetPolicy objects
        """
        return list(self._policies.values())

    def _persist(self) -> None:
        """
        Persist policies to disk using atomic write strategy.
        
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
            data = [policy.to_dict() for policy in self._policies.values()]
            
            # Write to temporary file
            tmp_path = self.policy_path.with_suffix('.tmp')
            with open(tmp_path, 'w') as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())  # Force write to disk
            
            # Atomic rename (POSIX guarantees atomicity)
            # On Windows, may need to remove target first
            if os.name == 'nt' and self.policy_path.exists():
                self.policy_path.unlink()
            tmp_path.rename(self.policy_path)
            
        except Exception as e:
            raise FileWriteError(
                f"Failed to persist policy store to {self.policy_path}: {e}"
            ) from e

    def _create_backup(self) -> None:
        """
        Create rolling backup of policy file.
        
        Rotates backups:
        - policies.json.bak.3 -> deleted
        - policies.json.bak.2 -> policies.json.bak.3
        - policies.json.bak.1 -> policies.json.bak.2
        - policies.json -> policies.json.bak.1
        """
        if not self.policy_path.exists():
            return
        
        try:
            # Delete oldest backup if it exists
            oldest_backup = Path(f"{self.policy_path}.bak.{self.backup_count}")
            if oldest_backup.exists():
                oldest_backup.unlink()
            
            # Rotate existing backups (from newest to oldest)
            for i in range(self.backup_count - 1, 0, -1):
                old_backup = Path(f"{self.policy_path}.bak.{i}")
                new_backup = Path(f"{self.policy_path}.bak.{i + 1}")
                
                if old_backup.exists():
                    old_backup.rename(new_backup)
            
            # Create new backup
            backup_path = Path(f"{self.policy_path}.bak.1")
            shutil.copy2(self.policy_path, backup_path)
            
        except Exception as e:
            # Log warning but don't fail the operation
            # Backup failure shouldn't prevent writes
            import logging
            logging.warning(f"Failed to create backup of policy store: {e}")

    def _load(self) -> None:
        """
        Load policies from disk.
        
        Raises:
            FileReadError: If read operation fails
        """
        try:
            with open(self.policy_path, 'r') as f:
                data = json.load(f)
            
            # Reconstruct policies dictionary
            self._policies = {}
            self._agent_policies = {}
            
            for policy_data in data:
                policy = BudgetPolicy.from_dict(policy_data)
                self._policies[policy.policy_id] = policy
                
                # Update agent -> policies mapping
                if policy.agent_id not in self._agent_policies:
                    self._agent_policies[policy.agent_id] = []
                self._agent_policies[policy.agent_id].append(policy.policy_id)
                
        except json.JSONDecodeError as e:
            raise FileReadError(
                f"Failed to parse policy store JSON from {self.policy_path}: {e}"
            ) from e
        except Exception as e:
            raise FileReadError(
                f"Failed to load policy store from {self.policy_path}: {e}"
            ) from e
