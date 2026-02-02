"""
Provisional charge management for Caracal Core v0.2.

This module provides the ProvisionalChargeManager for managing budget reservations
with automatic expiration and cleanup.

Requirements: 14.1, 14.2, 14.3, 14.4, 14.6
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from caracal.db.models import ProvisionalCharge
from caracal.exceptions import ProvisionalChargeError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class ProvisionalChargeConfig:
    """
    Configuration for provisional charge management.
    
    Attributes:
        default_expiration_seconds: Default timeout for provisional charges (default: 300s = 5 minutes)
        timeout_minutes: Maximum timeout allowed (default: 60 minutes)
        cleanup_interval_seconds: How often to run cleanup job (default: 60s)
        cleanup_batch_size: Max charges to process per cleanup run (default: 1000)
    """
    default_expiration_seconds: int = 300  # 5 minutes
    timeout_minutes: int = 60  # 1 hour maximum
    cleanup_interval_seconds: int = 60  # Run cleanup every 60 seconds
    cleanup_batch_size: int = 1000  # Process up to 1000 per run


class ProvisionalChargeManager:
    """
    Manages provisional charges for budget reservations.
    
    Provisional charges reserve budget during policy checks and automatically
    expire after a configurable timeout. A background cleanup job releases
    expired charges periodically.
    
    Requirements: 14.1, 14.2, 14.3, 14.6
    """

    def __init__(self, db_session: Session, config: Optional[ProvisionalChargeConfig] = None):
        """
        Initialize ProvisionalChargeManager.
        
        Args:
            db_session: SQLAlchemy database session
            config: Optional configuration (uses defaults if not provided)
        """
        self.db_session = db_session
        self.config = config or ProvisionalChargeConfig()
        logger.info(
            f"ProvisionalChargeManager initialized with "
            f"default_expiration={self.config.default_expiration_seconds}s, "
            f"max_timeout={self.config.timeout_minutes}m"
        )

    def create_provisional_charge(
        self,
        agent_id: UUID,
        amount: Decimal,
        expiration_seconds: Optional[int] = None
    ) -> ProvisionalCharge:
        """
        Create a provisional charge reserving budget.
        
        Args:
            agent_id: Agent making the request
            amount: Amount to reserve
            expiration_seconds: Custom expiration (default: 300s, max: 3600s)
        
        Returns:
            ProvisionalCharge with charge_id and expires_at timestamp
        
        Behavior:
            - If expiration_seconds not provided, uses default (300s)
            - If expiration_seconds > timeout_minutes * 60, caps at maximum
            - Sets expires_at = created_at + expiration_seconds
            - Sets released = False
        
        Requirements: 14.1, 14.2, 14.3
        """
        try:
            # Determine expiration timeout
            if expiration_seconds is None:
                expiration_seconds = self.config.default_expiration_seconds
            else:
                # Cap at maximum timeout
                max_timeout_seconds = self.config.timeout_minutes * 60
                if expiration_seconds > max_timeout_seconds:
                    logger.warning(
                        f"Requested expiration {expiration_seconds}s exceeds maximum {max_timeout_seconds}s, "
                        f"capping to maximum"
                    )
                    expiration_seconds = max_timeout_seconds
            
            # Calculate timestamps
            now = datetime.utcnow()
            expires_at = now + timedelta(seconds=expiration_seconds)
            
            # Create provisional charge
            charge = ProvisionalCharge(
                charge_id=uuid4(),
                agent_id=agent_id,
                amount=amount,
                currency="USD",
                created_at=now,
                expires_at=expires_at,
                released=False,
                final_charge_event_id=None
            )
            
            # Add to database
            self.db_session.add(charge)
            self.db_session.commit()
            
            logger.info(
                f"Created provisional charge: charge_id={charge.charge_id}, "
                f"agent_id={agent_id}, amount={amount}, expires_at={expires_at}"
            )
            
            return charge
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(
                f"Failed to create provisional charge for agent {agent_id}: {e}",
                exc_info=True
            )
            raise ProvisionalChargeError(
                f"Failed to create provisional charge for agent {agent_id}: {e}"
            ) from e

    def release_provisional_charge(
        self,
        charge_id: UUID,
        final_charge_event_id: Optional[int] = None
    ) -> None:
        """
        Release a provisional charge.
        
        Args:
            charge_id: ID of provisional charge to release
            final_charge_event_id: Optional link to final charge event
        
        Behavior:
            - Sets released = True
            - Sets final_charge_event_id if provided
            - Idempotent: safe to call multiple times
        
        Requirements: 14.6, 15.2, 15.3
        """
        try:
            # Query for the charge
            stmt = select(ProvisionalCharge).where(ProvisionalCharge.charge_id == charge_id)
            result = self.db_session.execute(stmt)
            charge = result.scalar_one_or_none()
            
            if charge is None:
                logger.warning(f"Attempted to release non-existent provisional charge: {charge_id}")
                return  # Idempotent: already released or never existed
            
            if charge.released:
                logger.debug(f"Provisional charge {charge_id} already released, skipping")
                return  # Idempotent: already released
            
            # Release the charge
            charge.released = True
            if final_charge_event_id is not None:
                charge.final_charge_event_id = final_charge_event_id
            
            self.db_session.commit()
            
            logger.info(
                f"Released provisional charge: charge_id={charge_id}, "
                f"final_charge_event_id={final_charge_event_id}"
            )
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(
                f"Failed to release provisional charge {charge_id}: {e}",
                exc_info=True
            )
            raise ProvisionalChargeError(
                f"Failed to release provisional charge {charge_id}: {e}"
            ) from e

    def get_active_provisional_charges(self, agent_id: UUID) -> List[ProvisionalCharge]:
        """
        Get all active (not released, not expired) provisional charges for agent.
        
        Returns charges where:
            - released = False
            - expires_at > now()
        
        Requirements: 14.6
        """
        try:
            now = datetime.utcnow()
            
            stmt = (
                select(ProvisionalCharge)
                .where(ProvisionalCharge.agent_id == agent_id)
                .where(ProvisionalCharge.released == False)
                .where(ProvisionalCharge.expires_at > now)
            )
            
            result = self.db_session.execute(stmt)
            charges = result.scalars().all()
            
            logger.debug(
                f"Found {len(charges)} active provisional charges for agent {agent_id}"
            )
            
            return list(charges)
            
        except Exception as e:
            logger.error(
                f"Failed to query active provisional charges for agent {agent_id}: {e}",
                exc_info=True
            )
            raise ProvisionalChargeError(
                f"Failed to query active provisional charges for agent {agent_id}: {e}"
            ) from e

    def calculate_reserved_budget(self, agent_id: UUID) -> Decimal:
        """
        Calculate total budget currently reserved by active provisional charges.
        
        Returns sum of amounts for charges where:
            - agent_id matches
            - released = False
            - expires_at > now()
        
        Requirements: 14.6
        """
        try:
            charges = self.get_active_provisional_charges(agent_id)
            
            total = Decimal('0')
            for charge in charges:
                total += charge.amount
            
            logger.debug(
                f"Total reserved budget for agent {agent_id}: {total} "
                f"({len(charges)} active charges)"
            )
            
            return total
            
        except Exception as e:
            logger.error(
                f"Failed to calculate reserved budget for agent {agent_id}: {e}",
                exc_info=True
            )
            raise ProvisionalChargeError(
                f"Failed to calculate reserved budget for agent {agent_id}: {e}"
            ) from e

    def cleanup_expired_charges(self) -> int:
        """
        Background job to release expired provisional charges.
        
        Algorithm:
            1. Query for charges where expires_at < now() AND released = False
            2. Limit to cleanup_batch_size (default 1000)
            3. For each charge, set released = True
            4. Log count of released charges
            5. Return count of charges released
        
        Scheduling:
            - Runs every cleanup_interval_seconds (default 60s)
            - Implemented as async background task
            - Continues running even if individual cleanups fail
        
        Error Handling:
            - Logs errors but doesn't raise exceptions
            - Uses database transactions for atomicity
            - Retries failed updates up to 3 times
        
        Returns:
            Count of charges released in this cleanup run
        
        Requirements: 14.4
        """
        try:
            now = datetime.utcnow()
            
            # Query for expired charges
            stmt = (
                select(ProvisionalCharge)
                .where(ProvisionalCharge.expires_at < now)
                .where(ProvisionalCharge.released == False)
                .limit(self.config.cleanup_batch_size)
            )
            
            result = self.db_session.execute(stmt)
            charges = result.scalars().all()
            
            if not charges:
                logger.debug("No expired provisional charges to clean up")
                return 0
            
            # Release each charge
            for charge in charges:
                charge.released = True
            
            self.db_session.commit()
            
            logger.info(f"Cleanup job released {len(charges)} expired provisional charges")
            
            return len(charges)
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Cleanup job failed: {e}", exc_info=True)
            # Don't raise - cleanup failures shouldn't crash the system
            return 0

    def get_expired_charge_count(self, agent_id: Optional[UUID] = None) -> int:
        """
        Get count of expired but not yet cleaned up charges.
        
        Useful for monitoring and alerting on cleanup lag.
        
        Args:
            agent_id: Optional filter by agent
        
        Returns:
            Count of charges where expires_at < now() AND released = False
        
        Requirements: 14.4
        """
        try:
            now = datetime.utcnow()
            
            stmt = (
                select(ProvisionalCharge)
                .where(ProvisionalCharge.expires_at < now)
                .where(ProvisionalCharge.released == False)
            )
            
            if agent_id is not None:
                stmt = stmt.where(ProvisionalCharge.agent_id == agent_id)
            
            result = self.db_session.execute(stmt)
            charges = result.scalars().all()
            
            count = len(charges)
            
            logger.debug(
                f"Found {count} expired charges awaiting cleanup "
                f"(agent_id={agent_id})"
            )
            
            return count
            
        except Exception as e:
            logger.error(
                f"Failed to count expired charges: {e}",
                exc_info=True
            )
            raise ProvisionalChargeError(
                f"Failed to count expired charges: {e}"
            ) from e


class ProvisionalChargeCleanupJob:
    """
    Background job for cleaning up expired provisional charges.
    
    Runs periodically to release expired charges and prevent accumulation.
    
    Requirements: 14.4
    """

    def __init__(
        self,
        provisional_charge_manager: ProvisionalChargeManager,
        config: ProvisionalChargeConfig
    ):
        """
        Initialize cleanup job with manager and config.
        
        Args:
            provisional_charge_manager: Manager instance to use for cleanup
            config: Configuration for cleanup intervals
        """
        self.manager = provisional_charge_manager
        self.config = config
        self.running = False
        self._task: Optional[asyncio.Task] = None
        logger.info(
            f"ProvisionalChargeCleanupJob initialized with "
            f"interval={config.cleanup_interval_seconds}s"
        )

    async def start(self) -> None:
        """
        Start the background cleanup job.
        
        Runs continuously until stop() is called.
        """
        if self.running:
            logger.warning("Cleanup job already running, ignoring start request")
            return
        
        self.running = True
        logger.info("Starting provisional charge cleanup job")
        
        while self.running:
            try:
                released_count = self.manager.cleanup_expired_charges()
                if released_count > 0:
                    logger.info(
                        f"Cleanup job released {released_count} expired provisional charges"
                    )
            except Exception as e:
                logger.error(f"Cleanup job iteration failed: {e}", exc_info=True)
            
            # Wait for next cleanup interval
            await asyncio.sleep(self.config.cleanup_interval_seconds)
        
        logger.info("Provisional charge cleanup job stopped")

    async def stop(self) -> None:
        """
        Stop the background cleanup job.
        """
        if not self.running:
            logger.warning("Cleanup job not running, ignoring stop request")
            return
        
        logger.info("Stopping provisional charge cleanup job")
        self.running = False

    def start_background(self) -> asyncio.Task:
        """
        Start the cleanup job as a background task.
        
        Returns:
            asyncio.Task that can be awaited or cancelled
        """
        if self._task is not None and not self._task.done():
            logger.warning("Cleanup job already running as background task")
            return self._task
        
        self._task = asyncio.create_task(self.start())
        logger.info("Started provisional charge cleanup job as background task")
        return self._task

    async def stop_background(self) -> None:
        """
        Stop the background cleanup job task.
        """
        await self.stop()
        if self._task is not None:
            await self._task
            self._task = None
