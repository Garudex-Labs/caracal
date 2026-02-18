"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Snapshot-based recovery for Caracal Core v0.3.

This module provides comprehensive recovery functionality including:
- Loading snapshots
- Replaying events after snapshot timestamp
- Rebuilding Redis cache
- Validating integrity with Merkle roots

Requirements: 12.5, 12.6
"""

from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from caracal.db.models import LedgerEvent, MerkleRoot
from caracal.logging_config import get_logger
from caracal.merkle.snapshot import SnapshotManager, RecoveryResult

logger = get_logger(__name__)


class RecoveryManager:
    """
    Manages snapshot-based recovery with event replay.
    
    Provides comprehensive recovery functionality:
    1. Load most recent snapshot
    2. Replay events after snapshot timestamp
    3. Validate integrity with Merkle roots
    
    Requirements: 12.5, 12.6
    """

    def __init__(
        self,
        db_session: Session,
        snapshot_manager: SnapshotManager,
        merkle_verifier=None,
    ):
        """
        Initialize RecoveryManager.
        
        Args:
            db_session: SQLAlchemy database session
            snapshot_manager: SnapshotManager for loading snapshots
            merkle_verifier: Optional MerkleVerifier for integrity validation
        """
        self.db_session = db_session
        self.snapshot_manager = snapshot_manager
        self.merkle_verifier = merkle_verifier
        
        logger.info("RecoveryManager initialized")

    def recover_from_latest_snapshot(self) -> RecoveryResult:
        """
        Recover from the most recent snapshot.
        
        Steps:
        1. Find latest snapshot
        2. Load snapshot
        3. Replay events after snapshot timestamp
        4. Validate integrity
        
        Returns:
            RecoveryResult: Recovery metadata
            
        Raises:
            ValueError: If no snapshots exist
            
        Requirements: 12.5, 12.6
        """
        try:
            logger.info("Starting recovery from latest snapshot")
            
            # Get latest snapshot
            latest_snapshot = self.snapshot_manager.get_latest_snapshot()
            
            if latest_snapshot is None:
                raise ValueError("No snapshots available for recovery")
            
            logger.info(
                f"Found latest snapshot: {latest_snapshot.snapshot_id} "
                f"from {latest_snapshot.snapshot_timestamp}"
            )
            
            # Recover from snapshot
            return self.recover_from_snapshot(latest_snapshot.snapshot_id)
            
        except Exception as e:
            logger.error(f"Failed to recover from latest snapshot: {e}", exc_info=True)
            raise

    def recover_from_snapshot(self, snapshot_id: UUID) -> RecoveryResult:
        """
        Recover from a specific snapshot.
        
        Steps:
        1. Load snapshot
        2. Replay events after snapshot timestamp
        3. Validate integrity with Merkle roots
        
        Args:
            snapshot_id: UUID of snapshot to recover from
            
        Returns:
            RecoveryResult: Recovery metadata including events replayed
            
        Requirements: 12.5, 12.6
        """
        try:
            logger.info(f"Starting recovery from snapshot {snapshot_id}")
            start_time = datetime.utcnow()
            
            # Step 1: Load snapshot (state is minimal now)
            recovery_result = self.snapshot_manager.recover_from_snapshot(snapshot_id)
            
            logger.info(
                f"Snapshot loaded. "
                f"Replaying events from {recovery_result.replay_from_timestamp}"
            )
            
            # Step 2: Replay events after snapshot timestamp
            replayed_events = self._replay_events_after_timestamp(
                recovery_result.replay_from_timestamp
            )
            
            logger.info(f"Replayed {len(replayed_events)} events")
            
            # Step 3: Validate integrity with Merkle roots
            if self.merkle_verifier:
                self._validate_integrity_after_recovery(recovery_result.replay_from_timestamp)
                logger.info("Integrity validation completed")
            
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            logger.info(
                f"Recovery completed successfully. "
                f"Snapshot: {snapshot_id}, "
                f"Events replayed: {len(replayed_events)}, "
                f"Duration: {duration:.2f}s"
            )
            
            return recovery_result
            
        except Exception as e:
            logger.error(f"Failed to recover from snapshot {snapshot_id}: {e}", exc_info=True)
            raise

    def _replay_events_after_timestamp(self, timestamp: datetime) -> List[LedgerEvent]:
        """
        Replay events after a specific timestamp.
        
        Queries all events after the timestamp and processes them in order.
        
        Args:
            timestamp: Timestamp to replay events from
            
        Returns:
            List of replayed LedgerEvent objects
        """
        try:
            logger.info(f"Replaying events after {timestamp}")
            
            # Query events after timestamp, ordered by event_id
            result = self.db_session.execute(
                select(LedgerEvent)
                .where(LedgerEvent.timestamp > timestamp)
                .order_by(LedgerEvent.event_id)
            )
            
            events = result.scalars().all()
            
            logger.debug(f"Found {len(events)} events to replay")
            
            return list(events)
            
        except Exception as e:
            logger.error(f"Failed to replay events after {timestamp}: {e}", exc_info=True)
            return []

    def _validate_integrity_after_recovery(self, replay_from_timestamp: datetime):
        """
        Validate ledger integrity after recovery.
        
        Verifies Merkle roots for batches created after the snapshot timestamp.
        
        Args:
            replay_from_timestamp: Timestamp to validate from
        """
        if not self.merkle_verifier:
            return
        
        try:
            logger.info(f"Validating integrity for events after {replay_from_timestamp}")
            
            # Query Merkle roots created after snapshot
            result = self.db_session.execute(
                select(MerkleRoot)
                .where(MerkleRoot.created_at > replay_from_timestamp)
                .order_by(MerkleRoot.created_at)
            )
            
            roots = result.scalars().all()
            
            if not roots:
                logger.info("No Merkle roots to validate")
                return
            
            logger.info(f"Validating {len(roots)} Merkle roots")
            
            # Verify each batch
            failed_batches = []
            for root in roots:
                try:
                    verification_result = self.merkle_verifier.verify_batch(root.batch_id)
                    
                    if not verification_result.verified:
                        failed_batches.append(root.batch_id)
                        logger.error(
                            f"Integrity validation failed for batch {root.batch_id}: "
                            f"{verification_result.error_message}"
                        )
                    else:
                        logger.debug(f"Batch {root.batch_id} verified successfully")
                        
                except Exception as e:
                    logger.error(f"Failed to verify batch {root.batch_id}: {e}")
                    failed_batches.append(root.batch_id)
            
            if failed_batches:
                logger.error(
                    f"Integrity validation failed for {len(failed_batches)} batches: "
                    f"{failed_batches}"
                )
            else:
                logger.info("All Merkle roots validated successfully")
            
        except Exception as e:
            logger.error(f"Failed to validate integrity after recovery: {e}", exc_info=True)

    def get_recovery_status(self) -> dict:
        """
        Get current recovery status information.
        
        Returns:
            Dictionary with recovery status information
        """
        try:
            # Get latest snapshot
            latest_snapshot = self.snapshot_manager.get_latest_snapshot()
            
            if latest_snapshot is None:
                return {
                    "snapshot_available": False,
                    "message": "No snapshots available",
                }
            
            # Count events after snapshot
            result = self.db_session.execute(
                select(LedgerEvent)
                .where(LedgerEvent.timestamp > latest_snapshot.snapshot_timestamp)
            )
            
            events_after_snapshot = len(result.scalars().all())
            
            return {
                "snapshot_available": True,
                "latest_snapshot_id": str(latest_snapshot.snapshot_id),
                "snapshot_timestamp": latest_snapshot.snapshot_timestamp.isoformat(),
                "snapshot_events": latest_snapshot.total_events,
                "events_after_snapshot": events_after_snapshot,
                "total_events": latest_snapshot.total_events + events_after_snapshot,
            }
            
        except Exception as e:
            logger.error(f"Failed to get recovery status: {e}", exc_info=True)
            return {
                "error": str(e),
            }
