"""
Policy management for Caracal Core.

This module provides the PolicyStore for managing budget policies,
including creation, retrieval, and persistence.
"""

import json
import os
import shutil
import time
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
from caracal.core.time_windows import TimeWindowCalculator

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
        delegated_from_agent_id: Optional parent agent ID for delegation tracking
    """
    policy_id: str
    agent_id: str
    limit_amount: str  # Store as string to preserve Decimal precision
    time_window: str
    currency: str
    created_at: str  # ISO 8601 format
    active: bool
    delegated_from_agent_id: Optional[str] = None

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
    Integrates with PolicyVersionManager for audit trails (v0.3).
    
    v0.3 optimizations:
    - Policy query caching with TTL
    - Target sub-second evaluation for 100k agents
    """

    def __init__(
        self, 
        policy_path: str, 
        agent_registry=None,
        backup_count: int = 3,
        cache_ttl_seconds: int = 60
    ):
        """
        Initialize PolicyStore.
        
        Args:
            policy_path: Path to the policy store JSON file
            agent_registry: Optional AgentRegistry for validating agent existence
            backup_count: Number of rolling backups to maintain (default: 3)
            cache_ttl_seconds: TTL for policy query cache (default: 60 seconds)
        """
        self.policy_path = Path(policy_path)
        self.agent_registry = agent_registry
        self.backup_count = backup_count
        self.cache_ttl_seconds = cache_ttl_seconds
        self._policies: Dict[str, BudgetPolicy] = {}
        self._agent_policies: Dict[str, List[str]] = {}  # agent_id -> [policy_ids]
        
        # Policy query cache (v0.3 optimization)
        self._policy_cache: Dict[str, tuple[List[BudgetPolicy], float]] = {}  # agent_id -> (policies, timestamp)
        self._cache_hits = 0
        self._cache_misses = 0
        
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
        currency: str = "USD",
        delegated_from_agent_id: Optional[str] = None,
        validate_conflicts: bool = True
    ) -> BudgetPolicy:
        """
        Create a new budget policy.
        
        Args:
            agent_id: Agent this policy applies to
            limit_amount: Maximum spend as Decimal
            time_window: Time window for budget (default: "daily")
            currency: Currency code (default: "USD")
            delegated_from_agent_id: Optional parent agent ID for delegation tracking
            validate_conflicts: Whether to validate policy conflicts (default: True, v0.3)
            
        Returns:
            BudgetPolicy: The newly created policy
            
        Raises:
            InvalidPolicyError: If limit amount is not positive or validation fails
            AgentNotFoundError: If agent or delegating agent does not exist (when registry provided)
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
            
            # Validate delegating agent existence if provided
            if delegated_from_agent_id is not None:
                delegating_agent = self.agent_registry.get_agent(delegated_from_agent_id)
                if delegating_agent is None:
                    logger.warning(f"Attempted to create policy with non-existent delegating agent: {delegated_from_agent_id}")
                    raise AgentNotFoundError(
                        f"Delegating agent with ID '{delegated_from_agent_id}' does not exist"
                    )
                
                # Validate that delegating agent is the parent of the agent
                if agent.parent_agent_id != delegated_from_agent_id:
                    logger.warning(
                        f"Attempted to delegate from non-parent agent: "
                        f"agent={agent_id}, parent={agent.parent_agent_id}, delegating_from={delegated_from_agent_id}"
                    )
                    raise InvalidPolicyError(
                        f"Agent '{delegated_from_agent_id}' is not the parent of agent '{agent_id}'"
                    )
        
        # Validate time window (v0.1 only supports daily)
        if time_window != "daily":
            raise InvalidPolicyError(
                f"Only 'daily' time window is supported in v0.1, got '{time_window}'"
            )
        
        # Validate currency (v0.1 only supports USD)
        if currency != "USD":
            raise InvalidPolicyError(
                f"Only 'USD' currency is supported in v0.1, got '{currency}'"
            )
        
        # Validate policy conflicts if requested (v0.3)
        if validate_conflicts:
            existing_policies = self.get_policies(agent_id)
            conflicts = self._check_policy_conflicts(
                existing_policies=existing_policies,
                new_limit=limit_amount,
                new_time_window=time_window,
                new_currency=currency
            )
            
            if conflicts:
                # Log warnings for conflicts
                for conflict in conflicts:
                    logger.warning(
                        f"Policy conflict detected for agent {agent_id}: {conflict}"
                    )
                
                # For now, just warn - don't block policy creation
                # In production, you might want to make this configurable
                logger.info(
                    f"Creating policy despite {len(conflicts)} potential conflicts "
                    f"(conflicts: {', '.join(conflicts)})"
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
            active=True,
            delegated_from_agent_id=delegated_from_agent_id
        )
        
        # Add to store
        self._policies[policy_id] = policy
        
        # Update agent -> policies mapping
        if agent_id not in self._agent_policies:
            self._agent_policies[agent_id] = []
        self._agent_policies[agent_id].append(policy_id)
        
        # Invalidate policy cache for this agent (v0.3 optimization)
        self.invalidate_policy_cache(agent_id)
        
        # Persist to disk
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist policy store to {self.policy_path}: {e}", exc_info=True)
            raise FileWriteError(
                f"Failed to persist policy store to {self.policy_path}: {e}"
            ) from e
        
        logger.info(
            f"Created policy: id={policy_id}, agent_id={agent_id}, "
            f"limit={limit_amount} {currency}, window={time_window}, delegated_from={delegated_from_agent_id}"
        )
        
        return policy
    
    def _check_policy_conflicts(
        self,
        existing_policies: List[BudgetPolicy],
        new_limit: Decimal,
        new_time_window: str,
        new_currency: str
    ) -> List[str]:
        """
        Check for potential policy conflicts.
        
        Detects conflicts such as:
        - Daily limit > monthly limit (shorter window has higher limit)
        - Policies with different currencies
        
        Args:
            existing_policies: List of existing policies for the agent
            new_limit: Limit amount for the new policy
            new_time_window: Time window for the new policy
            new_currency: Currency for the new policy
            
        Returns:
            List of conflict descriptions (empty if no conflicts)
            
        Requirements: 19.7
        """
        conflicts = []
        
        # Define time window hierarchy (shorter to longer)
        window_hierarchy = {
            'hourly': 1,
            'daily': 24,
            'weekly': 168,  # 24 * 7
            'monthly': 720  # 24 * 30 (approximate)
        }
        
        new_window_hours = window_hierarchy.get(new_time_window, 0)
        
        for existing_policy in existing_policies:
            existing_limit = existing_policy.get_limit_decimal()
            existing_window = existing_policy.time_window
            existing_currency = existing_policy.currency
            existing_window_hours = window_hierarchy.get(existing_window, 0)
            
            # Check currency mismatch
            if existing_currency != new_currency:
                conflicts.append(
                    f"Currency mismatch: existing policy {existing_policy.policy_id} uses {existing_currency}, "
                    f"new policy uses {new_currency}"
                )
            
            # Check for illogical limit relationships
            # Shorter window should have lower or equal limit than longer window
            if new_window_hours > 0 and existing_window_hours > 0:
                if new_window_hours < existing_window_hours:
                    # New policy has shorter window
                    if new_limit > existing_limit:
                        conflicts.append(
                            f"Shorter window has higher limit: new {new_time_window} policy limit {new_limit} > "
                            f"existing {existing_window} policy {existing_policy.policy_id} limit {existing_limit}"
                        )
                elif new_window_hours > existing_window_hours:
                    # New policy has longer window
                    if new_limit < existing_limit:
                        conflicts.append(
                            f"Longer window has lower limit: new {new_time_window} policy limit {new_limit} < "
                            f"existing {existing_window} policy {existing_policy.policy_id} limit {existing_limit}"
                        )
        
        return conflicts

    def get_policies(self, agent_id: str) -> List[BudgetPolicy]:
        """
        Get all active policies for an agent.
        
        Uses caching with TTL for improved performance (v0.3 optimization).
        
        Args:
            agent_id: The agent's unique identifier
            
        Returns:
            List of active BudgetPolicy objects for the agent
            
        Requirements: 23.7
        """
        # Check cache first (v0.3 optimization)
        if agent_id in self._policy_cache:
            cached_policies, cached_time = self._policy_cache[agent_id]
            age_seconds = time.time() - cached_time
            
            if age_seconds < self.cache_ttl_seconds:
                self._cache_hits += 1
                logger.debug(
                    f"Policy cache hit for agent {agent_id}: "
                    f"{len(cached_policies)} policies (age={age_seconds:.1f}s)"
                )
                return cached_policies
            else:
                # Cache expired
                del self._policy_cache[agent_id]
                logger.debug(f"Policy cache expired for agent {agent_id} (age={age_seconds:.1f}s)")
        
        # Cache miss - query policies
        self._cache_misses += 1
        
        policy_ids = self._agent_policies.get(agent_id, [])
        policies = []
        
        for policy_id in policy_ids:
            policy = self._policies.get(policy_id)
            if policy and policy.active:
                policies.append(policy)
        
        # Cache the result (v0.3 optimization)
        self._policy_cache[agent_id] = (policies, time.time())
        
        logger.debug(
            f"Retrieved {len(policies)} active policies for agent {agent_id} "
            f"(cache_hits={self._cache_hits}, cache_misses={self._cache_misses})"
        )
        
        return policies
    
    def invalidate_policy_cache(self, agent_id: str) -> None:
        """
        Invalidate policy cache for an agent.
        
        Should be called when policies are created, modified, or deleted.
        
        Args:
            agent_id: Agent identifier
            
        Requirements: 23.7
        """
        if agent_id in self._policy_cache:
            del self._policy_cache[agent_id]
            logger.debug(f"Invalidated policy cache for agent {agent_id}")

    def list_all_policies(self) -> List[BudgetPolicy]:
        """
        List all policies in the system.
        
        Returns:
            List of all BudgetPolicy objects
        """
        return list(self._policies.values())

    def get_delegated_policies(self, delegating_agent_id: str) -> List[BudgetPolicy]:
        """
        Get all policies delegated from a specific agent.
        
        Args:
            delegating_agent_id: The agent ID that delegated the policies
            
        Returns:
            List of BudgetPolicy objects delegated from the specified agent
        """
        delegated = [
            policy for policy in self._policies.values()
            if policy.delegated_from_agent_id == delegating_agent_id and policy.active
        ]
        logger.debug(f"Found {len(delegated)} delegated policies from agent {delegating_agent_id}")
        return delegated

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
            OSError: If write operation fails after all retries
        """
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
class SinglePolicyDecision:
    """
    Represents the result of evaluating a single policy.
    
    Attributes:
        policy_id: The policy that was evaluated
        allowed: Whether this policy allows the action
        limit_amount: The policy's limit amount
        current_spending: Current spending in the time window
        reserved_budget: Budget reserved by provisional charges
        available_budget: Available budget (limit - spending - reserved)
        time_window: The policy's time window
        window_type: The policy's window type (rolling or calendar)
    """
    policy_id: str
    allowed: bool
    limit_amount: Decimal
    current_spending: Decimal
    reserved_budget: Decimal
    available_budget: Decimal
    time_window: str
    window_type: str


@dataclass
class PolicyDecision:
    """
    Represents the result of a policy evaluation.
    
    Attributes:
        allowed: Whether the action is allowed
        reason: Human-readable explanation for the decision
        remaining_budget: Remaining budget if allowed, None otherwise
        provisional_charge_id: UUID of created provisional charge if allowed, None otherwise
        failed_policy_id: Policy ID that caused denial (v0.3 multi-policy support)
        policy_decisions: Individual decisions for each policy (v0.3 multi-policy support)
    """
    allowed: bool
    reason: str
    remaining_budget: Optional[Decimal] = None
    # provisional_charge_id removed as it was part of legacy logic
    failed_policy_id: Optional[str] = None  # NEW: Which policy failed (v0.3)
    policy_decisions: Optional[List[SinglePolicyDecision]] = None  # NEW: Individual policy decisions (v0.3)


class PolicyEvaluator:
    """
    Stateless decision engine for budget enforcement.
    
    Evaluates whether an agent is within budget by:
    1. Loading policies from PolicyStore
    2. Querying current spending from LedgerQuery
    3. Querying active provisional charges from ProvisionalChargeManager
    4. Comparing spending + reserved budget against policy limits
    5. Creating provisional charge if allowed
    6. Implementing fail-closed semantics (deny on error or missing policy)
    
    v0.3 enhancements:
    - Uses TimeWindowCalculator for flexible time window calculations
    - Supports hourly, daily, weekly, monthly windows
    - Supports rolling and calendar window types
    """

    def __init__(
        self, 
        policy_store: PolicyStore, 
        ledger_query, 
        delegation_token_manager=None,
        time_window_calculator: Optional[TimeWindowCalculator] = None
    ):
        """
        Initialize PolicyEvaluator.
        
        Args:
            policy_store: PolicyStore instance for loading policies
            ledger_query: LedgerQuery instance for querying spending
            delegation_token_manager: Optional DelegationTokenManager for delegation token validation
            time_window_calculator: Optional TimeWindowCalculator for v0.3 extended time windows
        """
        self.policy_store = policy_store
        self.ledger_query = ledger_query
        self.delegation_token_manager = delegation_token_manager
        self.time_window_calculator = time_window_calculator or TimeWindowCalculator()
        logger.info("PolicyEvaluator initialized with TimeWindowCalculator")

    def evaluate_single_policy(
        self, 
        policy: BudgetPolicy, 
        agent_id: str, 
        estimated_cost: Optional[Decimal],
        current_time: datetime
    ) -> SinglePolicyDecision:
        """
        Evaluate a single policy for an agent.
        
        Args:
            policy: The policy to evaluate
            agent_id: Agent identifier
            estimated_cost: Estimated cost for the request
            current_time: Current time for time window calculation
            
        Returns:
            SinglePolicyDecision with evaluation result for this policy
            
        Raises:
            PolicyEvaluationError: If evaluation fails critically
            
        Requirements: 19.1, 19.2, 19.3
        """
        try:
            # Get window_type from policy (default to 'calendar' for v0.2 compatibility)
            window_type = getattr(policy, 'window_type', 'calendar')
            
            # Calculate time window bounds using TimeWindowCalculator
            try:
                window_start, window_end = self.time_window_calculator.calculate_window_bounds(
                    time_window=policy.time_window,
                    window_type=window_type,
                    reference_time=current_time
                )
                logger.debug(
                    f"Calculated {window_type} {policy.time_window} window for policy {policy.policy_id}: "
                    f"{window_start.isoformat()} to {window_end.isoformat()}"
                )
            except InvalidPolicyError as e:
                # Fail closed on invalid time window configuration
                logger.error(
                    f"Invalid time window configuration for policy {policy.policy_id}: {e}",
                    exc_info=True
                )
                raise PolicyEvaluationError(
                    f"Invalid time window configuration: {e}"
                ) from e
            
            # Query ledger for spending in window
            try:
                spending = self.ledger_query.sum_spending(agent_id, window_start, window_end)
                logger.debug(
                    f"Current spending for agent {agent_id} in policy {policy.policy_id}: "
                    f"{spending} {policy.currency} (window: {window_start} to {window_end})"
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
            
            # Query active provisional charges (v0.2 only) - REMOVED
            reserved_budget = Decimal('0')
            
            # Get policy limit as Decimal
            limit = policy.get_limit_decimal()
            
            # Calculate available budget (limit - spending - reserved)
            available = limit - spending - reserved_budget
            
            # Check if estimated cost fits (if provided)
            allowed = True
            if estimated_cost is not None and estimated_cost > available:
                allowed = False
            elif available <= 0:
                allowed = False
            
            return SinglePolicyDecision(
                policy_id=policy.policy_id,
                allowed=allowed,
                limit_amount=limit,
                current_spending=spending,
                reserved_budget=reserved_budget,
                available_budget=available,
                time_window=policy.time_window,
                window_type=window_type
            )
            
        except PolicyEvaluationError:
            # Re-raise PolicyEvaluationError (already logged)
            raise
        except Exception as e:
            # Fail closed on any unexpected error
            logger.error(
                f"Critical error during single policy evaluation for policy {policy.policy_id}: {e}",
                exc_info=True
            )
            raise PolicyEvaluationError(
                f"Critical error during single policy evaluation: {e}"
            ) from e

    def check_budget(self, agent_id: str, estimated_cost: Optional[Decimal] = None, current_time: Optional[datetime] = None) -> PolicyDecision:
        """
        Check if agent is within budget.
        
        Implements fail-closed semantics:
        - Denies if no policy exists for agent
        - Denies if policy evaluation fails
        - Denies if spending + reserved budget exceeds limit
        - Creates provisional charge if allowed (v0.2 with ProvisionalChargeManager)
        
        v0.3 enhancements:
        - Uses TimeWindowCalculator for flexible time window calculations
        - Supports hourly, daily, weekly, monthly windows
        - Supports rolling and calendar window types
        - Supports multiple policies per agent (all must pass)
        - Returns which policy failed in denial message
        
        Args:
            agent_id: Agent identifier
            estimated_cost: Estimated cost for provisional charge (v0.2 only)
            current_time: Current time for time window calculation (defaults to UTC now)
            
        Returns:
            PolicyDecision with allow/deny, reason, and provisional_charge_id (v0.2)
            
        Raises:
            PolicyEvaluationError: If evaluation fails critically (fail-closed)
            
        Requirements: 9.7, 19.1, 19.2, 19.3, 19.4, 19.5
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
            
            # 2. Evaluate each policy independently (v0.3 multi-policy support)
            policy_decisions = []
            failed_policy = None
            
            for policy in policies:
                single_decision = self.evaluate_single_policy(
                    policy=policy,
                    agent_id=agent_id,
                    estimated_cost=estimated_cost,
                    current_time=current_time
                )
                policy_decisions.append(single_decision)
                
                # Track first failed policy
                if not single_decision.allowed and failed_policy is None:
                    failed_policy = single_decision
            
            # 3. If any policy failed, deny with specific policy information (v0.3)
            if failed_policy is not None:
                logger.info(
                    f"Budget check denied for agent {agent_id}: "
                    f"Policy {failed_policy.policy_id} exceeded "
                    f"(limit={failed_policy.limit_amount}, spent={failed_policy.current_spending}, "
                    f"reserved={failed_policy.reserved_budget}, available={failed_policy.available_budget}, "
                    f"window={failed_policy.time_window} {failed_policy.window_type})"
                )
                
                if estimated_cost is not None:
                    reason = (
                        f"Policy {failed_policy.policy_id} exceeded: "
                        f"need {estimated_cost}, available {failed_policy.available_budget} "
                        f"(limit={failed_policy.limit_amount}, spent={failed_policy.current_spending}, "
                        f"reserved={failed_policy.reserved_budget}, "
                        f"window={failed_policy.time_window} {failed_policy.window_type})"
                    )
                else:
                    reason = (
                        f"Policy {failed_policy.policy_id} exceeded: "
                        f"available {failed_policy.available_budget} "
                        f"(limit={failed_policy.limit_amount}, spent={failed_policy.current_spending}, "
                        f"reserved={failed_policy.reserved_budget}, "
                        f"window={failed_policy.time_window} {failed_policy.window_type})"
                    )
                
                return PolicyDecision(
                    allowed=False,
                    reason=reason,
                    remaining_budget=Decimal('0'),
                    failed_policy_id=failed_policy.policy_id,
                    policy_decisions=policy_decisions
                )
            
            # 4. Calculate minimum remaining budget across all policies
            min_remaining = min(
                decision.available_budget - (estimated_cost if estimated_cost is not None else Decimal('0'))
                for decision in policy_decisions
            )
            
            # 5. Allow with remaining budget
            logger.info(
                f"Budget check allowed for agent {agent_id}: "
                f"All {len(policies)} policies passed "
                f"(min_remaining={min_remaining})"
            )
            
            return PolicyDecision(
                allowed=True,
                reason=f"Within budget (all {len(policies)} policies passed)",
                remaining_budget=min_remaining,
                policy_decisions=policy_decisions
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


    def check_budget_with_delegation(
        self,
        agent_id: str,
        delegation_token: str,
        estimated_cost: Optional[Decimal] = None,
        current_time: Optional[datetime] = None
    ) -> PolicyDecision:
        """
        Check budget with delegation token validation.
        
        Validates the delegation token and checks spending limits before
        performing standard budget check.
        
        Implements fail-closed semantics:
        - Denies if delegation_token_manager not available
        - Denies if token validation fails
        - Denies if token has expired
        - Denies if spending exceeds token limit
        - Denies if standard budget check fails
        
        Args:
            agent_id: Agent identifier
            delegation_token: JWT delegation token string
            estimated_cost: Estimated cost for provisional charge
            current_time: Current time for time window calculation (defaults to UTC now)
            
        Returns:
            PolicyDecision with allow/deny, reason, and provisional_charge_id
            
        Raises:
            PolicyEvaluationError: If evaluation fails critically (fail-closed)
            
        Requirements: 13.3, 13.4, 13.6
        """
        try:
            # Use current UTC time if not provided
            if current_time is None:
                current_time = datetime.utcnow()
            
            # 1. Check if delegation token manager is available
            if self.delegation_token_manager is None:
                logger.error("Delegation token validation requested but DelegationTokenManager not available")
                return PolicyDecision(
                    allowed=False,
                    reason="Delegation token validation not available"
                )
            
            # 2. Validate delegation token
            try:
                token_claims = self.delegation_token_manager.validate_token(delegation_token)
                logger.debug(
                    f"Validated delegation token: issuer={token_claims.issuer}, "
                    f"subject={token_claims.subject}, limit={token_claims.spending_limit}"
                )
            except Exception as e:
                logger.warning(f"Delegation token validation failed for agent {agent_id}: {e}")
                return PolicyDecision(
                    allowed=False,
                    reason=f"Invalid delegation token: {e}"
                )
            
            # 3. Verify agent matches token subject
            from uuid import UUID
            try:
                agent_uuid = UUID(agent_id)
            except ValueError:
                logger.error(f"Invalid agent ID format: {agent_id}")
                return PolicyDecision(
                    allowed=False,
                    reason=f"Invalid agent ID format"
                )
            
            if agent_uuid != token_claims.subject:
                logger.warning(
                    f"Agent ID mismatch: token subject={token_claims.subject}, "
                    f"requesting agent={agent_id}"
                )
                return PolicyDecision(
                    allowed=False,
                    reason="Agent ID does not match delegation token subject"
                )
            
            # 4. Check token expiration (already checked in validate_token, but double-check)
            if current_time > token_claims.expiration:
                logger.warning(f"Delegation token expired for agent {agent_id}")
                return PolicyDecision(
                    allowed=False,
                    reason="Delegation token has expired"
                )
            
            # 5. Query current spending for agent
            # Calculate time window bounds using TimeWindowCalculator
            # Use daily calendar window for delegation tokens
            try:
                window_start, window_end = self.time_window_calculator.calculate_window_bounds(
                    time_window='daily',
                    window_type='calendar',
                    reference_time=current_time
                )
            except InvalidPolicyError as e:
                logger.error(f"Failed to calculate time window: {e}", exc_info=True)
                raise PolicyEvaluationError(
                    f"Failed to calculate time window: {e}"
                ) from e
            
            try:
                spending = self.ledger_query.sum_spending(agent_id, window_start, window_end)
                logger.debug(
                    f"Current spending for agent {agent_id}: {spending} {token_claims.currency} "
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
            
            # 6. Check spending against token limit
            if not self.delegation_token_manager.check_spending_limit(
                token_claims, agent_uuid, spending
            ):
                logger.info(
                    f"Budget check denied for agent {agent_id}: "
                    f"Spending {spending} exceeds delegation token limit {token_claims.spending_limit}"
                )
                return PolicyDecision(
                    allowed=False,
                    reason=f"Spending {spending} exceeds delegation token limit {token_claims.spending_limit} {token_claims.currency}"
                )
            
            # 7. Check if estimated cost would exceed token limit
            if estimated_cost is not None:
                projected_spending = spending + estimated_cost
                if projected_spending > token_claims.spending_limit:
                    logger.info(
                        f"Budget check denied for agent {agent_id}: "
                        f"Projected spending {projected_spending} would exceed delegation token limit {token_claims.spending_limit}"
                    )
                    return PolicyDecision(
                        allowed=False,
                        reason=f"Projected spending {projected_spending} would exceed delegation token limit {token_claims.spending_limit} {token_claims.currency}"
                    )
            
            # 8. Perform standard budget check (this will also check policy limits and create provisional charge)
            standard_decision = self.check_budget(agent_id, estimated_cost, current_time)
            
            # 9. If standard check passes, return with delegation token info in reason
            if standard_decision.allowed:
                logger.info(
                    f"Budget check with delegation allowed for agent {agent_id}: "
                    f"Within both policy and delegation token limits"
                )
                return PolicyDecision(
                    allowed=True,
                    reason=f"Within budget (policy and delegation token validated)",
                    remaining_budget=standard_decision.remaining_budget,
                    provisional_charge_id=standard_decision.provisional_charge_id
                )
            else:
                # Standard check failed (policy limit exceeded)
                return standard_decision
            
        except PolicyEvaluationError:
            # Re-raise PolicyEvaluationError (already logged)
            raise
        except Exception as e:
            # Fail closed on any unexpected error
            logger.error(
                f"Critical error during delegation token policy evaluation for agent {agent_id}: {e}",
                exc_info=True
            )
            raise PolicyEvaluationError(
                f"Critical error during delegation token policy evaluation for agent '{agent_id}': {e}"
            ) from e
