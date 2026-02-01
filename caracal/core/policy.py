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
    BudgetExceededError,
    FileReadError,
    FileWriteError,
    InvalidPolicyError,
    PolicyEvaluationError,
)
from caracal.logging_config import get_logger
from caracal.core.retry import retry_on_transient_failure

logger = get_logger(__name__)


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
            logger.info(f"Loaded {len(self._policies)} policies from {self.policy_path}")
        else:
            logger.info(f"Initialized new policy store at {self.policy_path}")

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
            logger.warning(f"Attempted to create policy with non-positive limit: {limit_amount}")
            raise InvalidPolicyError(
                f"Limit amount must be positive, got {limit_amount}"
            )
        
        # Validate agent existence if registry is available
        if self.agent_registry is not None:
            agent = self.agent_registry.get_agent(agent_id)
            if agent is None:
                logger.warning(f"Attempted to create policy for non-existent agent: {agent_id}")
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
        
        logger.info(
            f"Created policy: id={policy_id}, agent_id={agent_id}, "
            f"limit={limit_amount} {currency}, window={time_window}"
        )
        
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
        
        logger.debug(f"Retrieved {len(policies)} active policies for agent {agent_id}")
        
        return policies

    def list_all_policies(self) -> List[BudgetPolicy]:
        """
        List all policies in the system.
        
        Returns:
            List of all BudgetPolicy objects
        """
        return list(self._policies.values())

    @retry_on_transient_failure(max_retries=3, base_delay=0.1, backoff_factor=2.0)
    def _persist(self) -> None:
        """
        Persist policies to disk using atomic write strategy.
        
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
            FileWriteError: If write operation fails after all retries
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
            
            logger.debug(f"Persisted {len(self._policies)} policies to {self.policy_path}")
            
        except Exception as e:
            logger.error(f"Failed to persist policy store to {self.policy_path}: {e}", exc_info=True)
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
            
            logger.debug(f"Created backup of policy store at {backup_path}")
            
        except Exception as e:
            # Log warning but don't fail the operation
            # Backup failure shouldn't prevent writes
            logger.warning(f"Failed to create backup of policy store: {e}")

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
            
            logger.debug(f"Loaded {len(self._policies)} policies from {self.policy_path}")
                
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse policy store JSON from {self.policy_path}: {e}", exc_info=True)
            raise FileReadError(
                f"Failed to parse policy store JSON from {self.policy_path}: {e}"
            ) from e
        except Exception as e:
            logger.error(f"Failed to load policy store from {self.policy_path}: {e}", exc_info=True)
            raise FileReadError(
                f"Failed to load policy store from {self.policy_path}: {e}"
            ) from e


@dataclass
class PolicyDecision:
    """
    Represents the result of a policy evaluation.
    
    Attributes:
        allowed: Whether the action is allowed
        reason: Human-readable explanation for the decision
        remaining_budget: Remaining budget if allowed, None otherwise
    """
    allowed: bool
    reason: str
    remaining_budget: Optional[Decimal] = None


class PolicyEvaluator:
    """
    Stateless decision engine for budget enforcement.
    
    Evaluates whether an agent is within budget by:
    1. Loading policies from PolicyStore
    2. Querying current spending from LedgerQuery
    3. Comparing spending against policy limits
    4. Implementing fail-closed semantics (deny on error or missing policy)
    """

    def __init__(self, policy_store: PolicyStore, ledger_query):
        """
        Initialize PolicyEvaluator.
        
        Args:
            policy_store: PolicyStore instance for loading policies
            ledger_query: LedgerQuery instance for querying spending
        """
        self.policy_store = policy_store
        self.ledger_query = ledger_query
        logger.info("PolicyEvaluator initialized")

    def check_budget(self, agent_id: str, current_time: Optional[datetime] = None) -> PolicyDecision:
        """
        Check if agent is within budget.
        
        Implements fail-closed semantics:
        - Denies if no policy exists for agent
        - Denies if policy evaluation fails
        - Denies if spending exceeds limit
        
        Args:
            agent_id: Agent identifier
            current_time: Current time for time window calculation (defaults to UTC now)
            
        Returns:
            PolicyDecision with allow/deny and reason
            
        Raises:
            PolicyEvaluationError: If evaluation fails critically (fail-closed)
        """
        try:
            # Use current UTC time if not provided
            if current_time is None:
                current_time = datetime.utcnow()
            
            # 1. Get policies for agent (fail closed if none)
            policies = self.policy_store.get_policies(agent_id)
            if not policies:
                logger.info(f"Budget check denied for agent {agent_id}: No active policy found")
                return PolicyDecision(
                    allowed=False,
                    reason=f"No active policy found for agent '{agent_id}'"
                )
            
            # 2. Use the first active policy (v0.1 supports single policy per agent)
            policy = policies[0]
            
            # 3. Calculate time window bounds based on policy time_window
            if policy.time_window == "daily":
                # Start of current day (00:00:00)
                window_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
                window_end = current_time
            else:
                # Should not happen due to validation in create_policy, but fail closed
                raise PolicyEvaluationError(
                    f"Unsupported time window '{policy.time_window}' in policy {policy.policy_id}"
                )
            
            # 4. Query ledger for spending in window
            try:
                spending = self.ledger_query.sum_spending(agent_id, window_start, window_end)
                logger.debug(
                    f"Current spending for agent {agent_id}: {spending} {policy.currency} "
                    f"(window: {window_start} to {window_end})"
                )
            except Exception as e:
                # Fail closed on ledger query error
                logger.error(
                    f"Failed to query spending for agent {agent_id}: {e}",
                    exc_info=True
                )
                raise PolicyEvaluationError(
                    f"Failed to query spending for agent '{agent_id}': {e}"
                ) from e
            
            # 5. Get policy limit as Decimal
            limit = policy.get_limit_decimal()
            
            # 6. Check against limit
            if spending >= limit:
                logger.info(
                    f"Budget check denied for agent {agent_id}: "
                    f"Budget exceeded ({spending} >= {limit} {policy.currency})"
                )
                return PolicyDecision(
                    allowed=False,
                    reason=f"Budget exceeded: {spending} {policy.currency} >= {limit} {policy.currency}",
                    remaining_budget=Decimal('0')
                )
            
            # 7. Allow with remaining budget
            remaining = limit - spending
            logger.info(
                f"Budget check allowed for agent {agent_id}: "
                f"Within budget (spent={spending}, limit={limit}, remaining={remaining} {policy.currency})"
            )
            return PolicyDecision(
                allowed=True,
                reason="Within budget",
                remaining_budget=remaining
            )
            
        except PolicyEvaluationError:
            # Re-raise PolicyEvaluationError (already logged)
            raise
        except Exception as e:
            # Fail closed on any unexpected error
            logger.error(
                f"Critical error during policy evaluation for agent {agent_id}: {e}",
                exc_info=True
            )
            raise PolicyEvaluationError(
                f"Critical error during policy evaluation for agent '{agent_id}': {e}"
            ) from e
