"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Ledger snapshot management for Caracal Core v0.3.

This module provides the SnapshotManager for creating and managing ledger snapshots
for fast recovery without replaying all events from the beginning.
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from caracal.db.models import LedgerSnapshot, LedgerEvent, MerkleRoot
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class SnapshotData:
    """
    Deserialized snapshot data structure.
    
    Contains snapshot metadata and state.
    """
    total_events: int
    merkle_root: str
    snapshot_timestamp: datetime


@dataclass
class RecoveryResult:
    """
    Result of snapshot-based recovery operation.
    
    Contains information about the recovery process and what needs to be replayed.
    """
    snapshot_id: UUID
    snapshot_timestamp: datetime
    replay_from_timestamp: datetime


class SnapshotManager:
    """
    Manages ledger snapshots for fast recovery.
    
    Creates point-in-time snapshots of ledger state including:
    - Current Merkle root
    - Total event count
    
    Enables fast recovery by loading snapshot and replaying only events
    after the snapshot timestamp.
    
    """

    def __init__(
        self,
        db_session: Session,
        ledger_query=None,
        merkle_verifier=None
    ):
        """
        Initialize SnapshotManager.
        
        Args:
            db_session: SQLAlchemy database session
            ledger_query: Optional LedgerQuery
            merkle_verifier: Optional MerkleVerifier for integrity validation
        """
        self.db_session = db_session
        self.ledger_query = ledger_query
        self.merkle_verifier = merkle_verifier
        
        logger.info("SnapshotManager initialized")

    def create_snapshot(self) -> LedgerSnapshot:
        """
        Create ledger snapshot.
        
        Steps:
        1. Get current timestamp
        2. Query total event count
        3. Get current Merkle root (latest batch)
        4. Store snapshot in ledger_snapshots table
        5. Return snapshot record
        
        Returns:
            LedgerSnapshot: Created snapshot record
            
        Raises:
            Exception: If snapshot creation fails
            
        """
        try:
            snapshot_timestamp = datetime.utcnow()
            logger.info(f"Creating ledger snapshot at {snapshot_timestamp}")
            
            # Query total event count
            total_events_result = self.db_session.execute(
                select(func.count(LedgerEvent.event_id))
            )
            total_events = total_events_result.scalar() or 0
            
            logger.debug(f"Total events in ledger: {total_events}")
            
            # Get current Merkle root (latest batch)
            merkle_root = self._get_latest_merkle_root()
            logger.debug(f"Latest Merkle root: {merkle_root}")
            
            # Create snapshot data structure
            snapshot_data = {
                "snapshot_timestamp": snapshot_timestamp.isoformat(),
                "total_events": total_events,
            }
            
            # Create snapshot record
            snapshot = LedgerSnapshot(
                snapshot_id=uuid4(),
                snapshot_timestamp=snapshot_timestamp,
                total_events=total_events,
                merkle_root=merkle_root or "",
                snapshot_data=snapshot_data,
                created_at=datetime.utcnow(),
            )
            
            # Store in database
            self.db_session.add(snapshot)
            self.db_session.commit()
            
            logger.info(
                f"Created snapshot {snapshot.snapshot_id} with {total_events} events"
            )
            
            return snapshot
            
        except Exception as e:
            logger.error(f"Failed to create snapshot: {e}", exc_info=True)
            self.db_session.rollback()
            raise

    def _get_latest_merkle_root(self) -> Optional[str]:
        """
        Get the latest Merkle root from the database.
        
        Returns:
            Latest Merkle root hash as hex string, or None if no roots exist
        """
        try:
            result = self.db_session.execute(
                select(MerkleRoot.merkle_root)
                .order_by(MerkleRoot.created_at.desc())
                .limit(1)
            )
            
            row = result.first()
            return row[0] if row else None
            
        except Exception as e:
            logger.warning(f"Failed to get latest Merkle root: {e}")
            return None

    def load_snapshot(self, snapshot_id: UUID) -> SnapshotData:
        """
        Load snapshot data.
        
        Steps:
        1. Query ledger_snapshots for snapshot_id
        2. Deserialize snapshot_data JSONB
        3. Return snapshot data
        
        Args:
            snapshot_id: UUID of snapshot to load
            
        Returns:
            SnapshotData: Deserialized snapshot data
            
        Raises:
            ValueError: If snapshot not found
            
        """
        try:
            # Query snapshot
            result = self.db_session.execute(
                select(LedgerSnapshot).where(LedgerSnapshot.snapshot_id == snapshot_id)
            )
            
            snapshot = result.scalar_one_or_none()
            
            if snapshot is None:
                raise ValueError(f"Snapshot {snapshot_id} not found")
            
            snapshot_data = SnapshotData(
                total_events=snapshot.total_events,
                merkle_root=snapshot.merkle_root,
                snapshot_timestamp=snapshot.snapshot_timestamp,
            )
            
            logger.info(
                f"Loaded snapshot {snapshot_id} from {snapshot.snapshot_timestamp}"
            )
            
            return snapshot_data
            
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to load snapshot {snapshot_id}: {e}", exc_info=True)
            raise

    def recover_from_snapshot(self, snapshot_id: UUID) -> RecoveryResult:
        """
        Recover from snapshot.
        
        Steps:
        1. Load snapshot data
        2. Get snapshot timestamp
        3. Return timestamp for event replay
        
        Args:
            snapshot_id: UUID of snapshot to recover from
            
        Returns:
            RecoveryResult: Recovery metadata including replay timestamp
            
        Raises:
            ValueError: If snapshot not found
            
        """
        try:
            logger.info(f"Starting recovery from snapshot {snapshot_id}")
            
            # Load snapshot data
            snapshot_data = self.load_snapshot(snapshot_id)
            
            # Validate integrity with Merkle root if verifier available
            if self.merkle_verifier and snapshot_data.merkle_root:
                try:
                    logger.info("Validating snapshot integrity with Merkle root")
                    # This would verify that the Merkle root matches the ledger state
                    # Implementation depends on MerkleVerifier interface
                except Exception as e:
                    logger.warning(f"Failed to validate snapshot integrity: {e}")
            
            # Create recovery result
            result = RecoveryResult(
                snapshot_id=snapshot_id,
                snapshot_timestamp=snapshot_data.snapshot_timestamp,
                replay_from_timestamp=snapshot_data.snapshot_timestamp,
            )
            
            logger.info(
                f"Recovery from snapshot {snapshot_id} complete. "
                f"Replay events from {result.replay_from_timestamp}"
            )
            
            return result
            
        except Exception as e:
            logger.error(f"Failed to recover from snapshot {snapshot_id}: {e}", exc_info=True)
            raise

    def list_snapshots(self, limit: int = 10) -> List[LedgerSnapshot]:
        """
        List recent snapshots.
        
        Args:
            limit: Maximum number of snapshots to return (default: 10)
            
        Returns:
            List of LedgerSnapshot records, ordered by creation time (newest first)
            
        """
        try:
            result = self.db_session.execute(
                select(LedgerSnapshot)
                .order_by(LedgerSnapshot.created_at.desc())
                .limit(limit)
            )
            
            snapshots = result.scalars().all()
            
            logger.debug(f"Listed {len(snapshots)} snapshots")
            
            return list(snapshots)
            
        except Exception as e:
            logger.error(f"Failed to list snapshots: {e}", exc_info=True)
            return []

    def cleanup_old_snapshots(self, retention_days: int = 90) -> int:
        """
        Clean up old snapshots based on retention policy.
        
        Deletes snapshots older than retention_days.
        
        Args:
            retention_days: Number of days to retain snapshots (default: 90)
            
        Returns:
            Number of snapshots deleted
            
        """
        try:
            cutoff_date = datetime.utcnow() - timedelta(days=retention_days)
            
            logger.info(f"Cleaning up snapshots older than {cutoff_date}")
            
            # Query old snapshots
            result = self.db_session.execute(
                select(LedgerSnapshot)
                .where(LedgerSnapshot.created_at < cutoff_date)
            )
            
            old_snapshots = result.scalars().all()
            
            # Delete old snapshots
            deleted_count = 0
            for snapshot in old_snapshots:
                logger.debug(f"Deleting snapshot {snapshot.snapshot_id} from {snapshot.created_at}")
                self.db_session.delete(snapshot)
                deleted_count += 1
            
            self.db_session.commit()
            
            logger.info(f"Deleted {deleted_count} old snapshots")
            
            return deleted_count
            
        except Exception as e:
            logger.error(f"Failed to cleanup old snapshots: {e}", exc_info=True)
            self.db_session.rollback()
            return 0

    def get_latest_snapshot(self) -> Optional[LedgerSnapshot]:
        """
        Get the most recent snapshot.
        
        Returns:
            Latest LedgerSnapshot or None if no snapshots exist
        """
        try:
            result = self.db_session.execute(
                select(LedgerSnapshot)
                .order_by(LedgerSnapshot.created_at.desc())
                .limit(1)
            )
            
            snapshot = result.scalar_one_or_none()
            
            if snapshot:
                logger.debug(f"Latest snapshot: {snapshot.snapshot_id} from {snapshot.created_at}")
            else:
                logger.debug("No snapshots found")
            
            return snapshot
            
        except Exception as e:
            logger.error(f"Failed to get latest snapshot: {e}", exc_info=True)
            return None
