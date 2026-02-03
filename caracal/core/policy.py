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
    """

    def __init__(
        self, 
        policy_path: str, 
        agent_registry=None,
        backup_count: int = 3,
        policy_version_manager=None
    ):
        """
        Initialize PolicyStore.
        
        Args:
            policy_path: Path to the policy store JSON file
            agent_registry: Optional AgentRegistry for validating agent existence
            backup_count: Number of rolling backups to maintain (default: 3)
            policy_version_manager: Optional PolicyVersionManager for v0.3 versioning
        """
        self.policy_path = Path(policy_path)
        self.agent_registry = agent_registry
        self.backup_count = backup_count
        self.policy_version_manager = policy_version_manager
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
        currency: str = "USD",
        delegated_from_agent_id: Optional[str] = None
    ) -> BudgetPolicy:
        """
        Create a new budget policy.
        
        Args:
            agent_id: Agent this policy applies to
            limit_amount: Maximum spend as Decimal
            time_window: Time window for budget (default: "daily")
            currency: Currency code (default: "USD")
            delegated_from_agent_id: Optional parent agent ID for delegation tracking
            
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
class PolicyDecision:
    """
    Represents the result of a policy evaluation.
    
    Attributes:
        allowed: Whether the action is allowed
        reason: Human-readable explanation for the decision
        remaining_budget: Remaining budget if allowed, None otherwise
        provisional_charge_id: UUID of created provisional charge if allowed, None otherwise
    """
    allowed: bool
    reason: str
    remaining_budget: Optional[Decimal] = None
    provisional_charge_id: Optional[str] = None  # UUID as string for v0.2 compatibility


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
        provisional_charge_manager=None, 
        delegation_token_manager=None,
        time_window_calculator: Optional[TimeWindowCalculator] = None
    ):
        """
        Initialize PolicyEvaluator.
        
        Args:
            policy_store: PolicyStore instance for loading policies
            ledger_query: LedgerQuery instance for querying spending
            provisional_charge_manager: Optional ProvisionalChargeManager for v0.2 provisional charges
            delegation_token_manager: Optional DelegationTokenManager for delegation token validation
            time_window_calculator: Optional TimeWindowCalculator for v0.3 extended time windows
        """
        self.policy_store = policy_store
        self.ledger_query = ledger_query
        self.provisional_charge_manager = provisional_charge_manager
        self.delegation_token_manager = delegation_token_manager
        self.time_window_calculator = time_window_calculator or TimeWindowCalculator()
        logger.info("PolicyEvaluator initialized with TimeWindowCalculator")

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
        
        Args:
            agent_id: Agent identifier
            estimated_cost: Estimated cost for provisional charge (v0.2 only)
            current_time: Current time for time window calculation (defaults to UTC now)
            
        Returns:
            PolicyDecision with allow/deny, reason, and provisional_charge_id (v0.2)
            
        Raises:
            PolicyEvaluationError: If evaluation fails critically (fail-closed)
            
        Requirements: 9.7
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
            
            # 3. Get window_type from policy (default to 'calendar' for v0.2 compatibility)
            window_type = getattr(policy, 'window_type', 'calendar')
            
            # 4. Calculate time window bounds using TimeWindowCalculator
            try:
                window_start, window_end = self.time_window_calculator.calculate_window_bounds(
                    time_window=policy.time_window,
                    window_type=window_type,
                    reference_time=current_time
                )
                logger.debug(
                    f"Calculated {window_type} {policy.time_window} window for agent {agent_id}: "
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
            
            # 5. Query ledger for spending in window
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
            
            # 6. Query active provisional charges (v0.2 only)
            reserved_budget = Decimal('0')
            if self.provisional_charge_manager is not None:
                try:
                    # Import here to avoid circular dependency
                    from uuid import UUID
                    
                    # Convert agent_id string to UUID for v0.2
                    agent_uuid = UUID(agent_id)
                    
                    # Call synchronous method
                    reserved_budget = self.provisional_charge_manager.calculate_reserved_budget(agent_uuid)
                    
                    logger.debug(
                        f"Reserved budget for agent {agent_id}: {reserved_budget} {policy.currency}"
                    )
                except Exception as e:
                    # Fail closed on provisional charge query error
                    logger.error(
                        f"Failed to query reserved budget for agent {agent_id}: {e}",
                        exc_info=True
                    )
                    raise PolicyEvaluationError(
                        f"Failed to query reserved budget for agent '{agent_id}': {e}"
                    ) from e
            
            # 7. Get policy limit as Decimal
            limit = policy.get_limit_decimal()
            
            # 8. Calculate available budget (limit - spending - reserved)
            available = limit - spending - reserved_budget
            
            # 9. Check if estimated cost fits (if provided)
            if estimated_cost is not None and estimated_cost > available:
                logger.info(
                    f"Budget check denied for agent {agent_id}: "
                    f"Insufficient budget (need {estimated_cost}, available {available} {policy.currency})"
                )
                return PolicyDecision(
                    allowed=False,
                    reason=f"Insufficient budget: need {estimated_cost}, available {available} {policy.currency}",
                    remaining_budget=Decimal('0')
                )
            
            # 10. Check if already exceeded (even without estimated cost)
            if available <= 0:
                logger.info(
                    f"Budget check denied for agent {agent_id}: "
                    f"Budget exceeded (spent={spending}, reserved={reserved_budget}, limit={limit} {policy.currency})"
                )
                return PolicyDecision(
                    allowed=False,
                    reason=f"Budget exceeded: spent {spending} + reserved {reserved_budget} >= {limit} {policy.currency}",
                    remaining_budget=Decimal('0')
                )
            
            # 11. Create provisional charge if manager available and estimated cost provided
            provisional_charge_id = None
            if self.provisional_charge_manager is not None and estimated_cost is not None:
                try:
                    from uuid import UUID
                    
                    agent_uuid = UUID(agent_id)
                    
                    # Call synchronous method
                    provisional_charge = self.provisional_charge_manager.create_provisional_charge(
                        agent_uuid, estimated_cost
                    )
                    
                    provisional_charge_id = str(provisional_charge.charge_id)
                    logger.debug(
                        f"Created provisional charge {provisional_charge_id} for agent {agent_id}, "
                        f"amount={estimated_cost}"
                    )
                except Exception as e:
                    # Fail closed on provisional charge creation error
                    logger.error(
                        f"Failed to create provisional charge for agent {agent_id}: {e}",
                        exc_info=True
                    )
                    raise PolicyEvaluationError(
                        f"Failed to create provisional charge for agent '{agent_id}': {e}"
                    ) from e
            
            # 12. Allow with remaining budget
            remaining = available - (estimated_cost if estimated_cost is not None else Decimal('0'))
            logger.info(
                f"Budget check allowed for agent {agent_id}: "
                f"Within budget (spent={spending}, reserved={reserved_budget}, limit={limit}, "
                f"remaining={remaining} {policy.currency}, provisional_charge_id={provisional_charge_id})"
            )
            return PolicyDecision(
                allowed=True,
                reason="Within budget",
                remaining_budget=remaining,
                provisional_charge_id=provisional_charge_id
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
