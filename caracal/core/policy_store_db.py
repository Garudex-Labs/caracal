"""
Database-backed policy store for Caracal Core v0.3.

This module provides a PostgreSQL-backed PolicyStore that integrates
with PolicyVersionManager for complete audit trails.

Requirements: 4.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 9.1, 9.3
"""

import asyncio
from decimal import Decimal
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import select, and_
from sqlalchemy.orm import Session

from caracal.db.models import BudgetPolicy, AgentIdentity
from caracal.core.policy_versions import PolicyVersionManager
from caracal.logging_config import get_logger
from caracal.exceptions import (
    AgentNotFoundError,
    InvalidPolicyError,
    PolicyNotFoundError
)

logger = get_logger(__name__)


class PolicyStoreDB:
    """
    Database-backed policy store with versioning support.
    
    Manages budget policies in PostgreSQL with:
    - CRUD operations for policies
    - Integration with PolicyVersionManager for audit trails
    - Validation of agent existence
    - Support for delegation tracking
    
    Requirements: 4.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 9.1, 9.3
    """
    
    def __init__(
        self,
        db_session: Session,
        policy_version_manager: Optional[PolicyVersionManager] = None
    ):
        """
        Initialize PolicyStoreDB.
        
        Args:
            db_session: SQLAlchemy database session
            policy_version_manager: Optional PolicyVersionManager for versioning
        """
        self.db_session = db_session
        self.policy_version_manager = policy_version_manager
        logger.info("PolicyStoreDB initialized")
    
    def create_policy(
        self,
        agent_id: UUID,
        limit_amount: Decimal,
        time_window: str = "daily",
        window_type: str = "calendar",
        currency: str = "USD",
        delegated_from_agent_id: Optional[UUID] = None,
        changed_by: str = "system",
        change_reason: str = "Policy created"
    ) -> BudgetPolicy:
        """
        Create a new budget policy with versioning.
        
        Creates a policy and records the creation in policy version history.
        
        Args:
            agent_id: Agent this policy applies to
            limit_amount: Maximum spend as Decimal
            time_window: Time window for budget (default: "daily")
            window_type: Window type ('rolling' or 'calendar', default: 'calendar')
            currency: Currency code (default: "USD")
            delegated_from_agent_id: Optional parent agent ID for delegation tracking
            changed_by: User/system identifier creating the policy
            change_reason: Reason for creating the policy
            
        Returns:
            BudgetPolicy: The newly created policy
            
        Raises:
            InvalidPolicyError: If limit amount is not positive or validation fails
            AgentNotFoundError: If agent or delegating agent does not exist
            
        Requirements: 5.3, 6.1
        """
        # Validate positive limit amount
        if limit_amount <= 0:
            logger.warning(f"Attempted to create policy with non-positive limit: {limit_amount}")
            raise InvalidPolicyError(
                f"Limit amount must be positive, got {limit_amount}"
            )
        
        # Validate agent existence
        stmt = select(AgentIdentity).where(AgentIdentity.agent_id == agent_id)
        result = self.db_session.execute(stmt)
        agent = result.scalar_one_or_none()
        
        if agent is None:
            logger.warning(f"Attempted to create policy for non-existent agent: {agent_id}")
            raise AgentNotFoundError(
                f"Agent with ID '{agent_id}' does not exist"
            )
        
        # Validate delegating agent existence if provided
        if delegated_from_agent_id is not None:
            stmt = select(AgentIdentity).where(AgentIdentity.agent_id == delegated_from_agent_id)
            result = self.db_session.execute(stmt)
            delegating_agent = result.scalar_one_or_none()
            
            if delegating_agent is None:
                logger.warning(
                    f"Attempted to create policy with non-existent delegating agent: {delegated_from_agent_id}"
                )
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
        
        # Validate time window
        valid_time_windows = ['hourly', 'daily', 'weekly', 'monthly']
        if time_window not in valid_time_windows:
            raise InvalidPolicyError(
                f"Invalid time window '{time_window}'. Must be one of: {valid_time_windows}"
            )
        
        # Validate window type
        valid_window_types = ['rolling', 'calendar']
        if window_type not in valid_window_types:
            raise InvalidPolicyError(
                f"Invalid window type '{window_type}'. Must be one of: {valid_window_types}"
            )
        
        # Create policy
        policy = BudgetPolicy(
            policy_id=uuid4(),
            agent_id=agent_id,
            limit_amount=limit_amount,
            time_window=time_window,
            currency=currency,
            delegated_from_agent_id=delegated_from_agent_id,
            active=True
        )
        
        # Add window_type attribute (v0.3)
        policy.window_type = window_type
        
        # Add to session and commit
        self.db_session.add(policy)
        self.db_session.commit()
        
        logger.info(
            f"Created policy: id={policy.policy_id}, agent_id={agent_id}, "
            f"limit={limit_amount} {currency}, window={time_window}, "
            f"window_type={window_type}, delegated_from={delegated_from_agent_id}"
        )
        
        # Create version record if version manager available
        if self.policy_version_manager:
            try:
                # Run async method in event loop
                asyncio.create_task(
                    self.policy_version_manager.create_policy_version(
                        policy=policy,
                        changed_by=changed_by,
                        change_reason=change_reason,
                        change_type='created'
                    )
                )
            except Exception as e:
                # Log error but don't fail the operation
                logger.error(
                    f"Failed to create policy version for policy {policy.policy_id}: {e}",
                    exc_info=True
                )
        
        return policy
    
    def update_policy(
        self,
        policy_id: UUID,
        limit_amount: Optional[Decimal] = None,
        time_window: Optional[str] = None,
        window_type: Optional[str] = None,
        active: Optional[bool] = None,
        changed_by: str = "system",
        change_reason: str = "Policy updated"
    ) -> BudgetPolicy:
        """
        Update an existing policy with versioning.
        
        Updates policy fields and records the modification in version history.
        
        Args:
            policy_id: Policy identifier
            limit_amount: Optional new limit amount
            time_window: Optional new time window
            window_type: Optional new window type
            active: Optional new active status
            changed_by: User/system identifier making the change
            change_reason: Reason for the change (required)
            
        Returns:
            BudgetPolicy: The updated policy
            
        Raises:
            PolicyNotFoundError: If policy does not exist
            InvalidPolicyError: If validation fails
            
        Requirements: 5.3, 5.4, 6.2
        """
        # Load policy
        stmt = select(BudgetPolicy).where(BudgetPolicy.policy_id == policy_id)
        result = self.db_session.execute(stmt)
        policy = result.scalar_one_or_none()
        
        if policy is None:
            raise PolicyNotFoundError(f"Policy with ID '{policy_id}' does not exist")
        
        # Update fields if provided
        if limit_amount is not None:
            if limit_amount <= 0:
                raise InvalidPolicyError(
                    f"Limit amount must be positive, got {limit_amount}"
                )
            policy.limit_amount = limit_amount
        
        if time_window is not None:
            valid_time_windows = ['hourly', 'daily', 'weekly', 'monthly']
            if time_window not in valid_time_windows:
                raise InvalidPolicyError(
                    f"Invalid time window '{time_window}'. Must be one of: {valid_time_windows}"
                )
            policy.time_window = time_window
        
        if window_type is not None:
            valid_window_types = ['rolling', 'calendar']
            if window_type not in valid_window_types:
                raise InvalidPolicyError(
                    f"Invalid window type '{window_type}'. Must be one of: {valid_window_types}"
                )
            policy.window_type = window_type
        
        if active is not None:
            policy.active = active
        
        # Commit changes
        self.db_session.commit()
        
        logger.info(
            f"Updated policy: id={policy_id}, changed_by={changed_by}, "
            f"reason={change_reason}"
        )
        
        # Create version record if version manager available
        if self.policy_version_manager:
            try:
                # Run async method in event loop
                asyncio.create_task(
                    self.policy_version_manager.create_policy_version(
                        policy=policy,
                        changed_by=changed_by,
                        change_reason=change_reason,
                        change_type='modified'
                    )
                )
            except Exception as e:
                # Log error but don't fail the operation
                logger.error(
                    f"Failed to create policy version for policy {policy_id}: {e}",
                    exc_info=True
                )
        
        return policy
    
    def deactivate_policy(
        self,
        policy_id: UUID,
        changed_by: str = "system",
        change_reason: str = "Policy deactivated"
    ) -> BudgetPolicy:
        """
        Deactivate a policy with versioning.
        
        Sets policy active status to False and records the deactivation in version history.
        
        Args:
            policy_id: Policy identifier
            changed_by: User/system identifier making the change
            change_reason: Reason for deactivation (required)
            
        Returns:
            BudgetPolicy: The deactivated policy
            
        Raises:
            PolicyNotFoundError: If policy does not exist
            
        Requirements: 5.3, 6.3
        """
        # Load policy
        stmt = select(BudgetPolicy).where(BudgetPolicy.policy_id == policy_id)
        result = self.db_session.execute(stmt)
        policy = result.scalar_one_or_none()
        
        if policy is None:
            raise PolicyNotFoundError(f"Policy with ID '{policy_id}' does not exist")
        
        # Deactivate policy
        policy.active = False
        self.db_session.commit()
        
        logger.info(
            f"Deactivated policy: id={policy_id}, changed_by={changed_by}, "
            f"reason={change_reason}"
        )
        
        # Create version record if version manager available
        if self.policy_version_manager:
            try:
                # Run async method in event loop
                asyncio.create_task(
                    self.policy_version_manager.create_policy_version(
                        policy=policy,
                        changed_by=changed_by,
                        change_reason=change_reason,
                        change_type='deactivated'
                    )
                )
            except Exception as e:
                # Log error but don't fail the operation
                logger.error(
                    f"Failed to create policy version for policy {policy_id}: {e}",
                    exc_info=True
                )
        
        return policy
    
    def get_policy(self, policy_id: UUID) -> Optional[BudgetPolicy]:
        """
        Get a policy by ID.
        
        Args:
            policy_id: Policy identifier
            
        Returns:
            BudgetPolicy if found, None otherwise
        """
        stmt = select(BudgetPolicy).where(BudgetPolicy.policy_id == policy_id)
        result = self.db_session.execute(stmt)
        policy = result.scalar_one_or_none()
        
        if policy:
            logger.debug(f"Retrieved policy {policy_id}")
        else:
            logger.debug(f"Policy {policy_id} not found")
        
        return policy
    
    def get_policies(self, agent_id: UUID, active_only: bool = True) -> List[BudgetPolicy]:
        """
        Get all policies for an agent.
        
        Args:
            agent_id: Agent identifier
            active_only: If True, return only active policies (default: True)
            
        Returns:
            List of BudgetPolicy objects
        """
        if active_only:
            stmt = select(BudgetPolicy).where(
                and_(
                    BudgetPolicy.agent_id == agent_id,
                    BudgetPolicy.active == True
                )
            )
        else:
            stmt = select(BudgetPolicy).where(BudgetPolicy.agent_id == agent_id)
        
        result = self.db_session.execute(stmt)
        policies = result.scalars().all()
        
        logger.debug(
            f"Retrieved {len(policies)} {'active ' if active_only else ''}policies for agent {agent_id}"
        )
        
        return list(policies)
    
    def list_all_policies(self, active_only: bool = False) -> List[BudgetPolicy]:
        """
        List all policies in the system.
        
        Args:
            active_only: If True, return only active policies (default: False)
            
        Returns:
            List of all BudgetPolicy objects
        """
        if active_only:
            stmt = select(BudgetPolicy).where(BudgetPolicy.active == True)
        else:
            stmt = select(BudgetPolicy)
        
        result = self.db_session.execute(stmt)
        policies = result.scalars().all()
        
        logger.debug(f"Retrieved {len(policies)} {'active ' if active_only else ''}policies")
        
        return list(policies)
    
    def get_delegated_policies(
        self,
        delegating_agent_id: UUID,
        active_only: bool = True
    ) -> List[BudgetPolicy]:
        """
        Get all policies delegated from a specific agent.
        
        Args:
            delegating_agent_id: The agent ID that delegated the policies
            active_only: If True, return only active policies (default: True)
            
        Returns:
            List of BudgetPolicy objects delegated from the specified agent
        """
        if active_only:
            stmt = select(BudgetPolicy).where(
                and_(
                    BudgetPolicy.delegated_from_agent_id == delegating_agent_id,
                    BudgetPolicy.active == True
                )
            )
        else:
            stmt = select(BudgetPolicy).where(
                BudgetPolicy.delegated_from_agent_id == delegating_agent_id
            )
        
        result = self.db_session.execute(stmt)
        policies = result.scalars().all()
        
        logger.debug(
            f"Found {len(policies)} {'active ' if active_only else ''}delegated policies "
            f"from agent {delegating_agent_id}"
        )
        
        return list(policies)
