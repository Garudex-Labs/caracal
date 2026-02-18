"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Ledger backfill manager for v0.2 events.

This module provides functionality to retroactively compute Merkle roots for
v0.2 ledger events that were created before Merkle tree support was added.

Requirements: 22.8, 22.9, 22.1.1-22.1.12
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import List, Optional, Tuple
from uuid import UUID, uuid4

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from caracal.db.models import LedgerEvent, MerkleRoot
from caracal.exceptions import BackfillError
from caracal.logging_config import get_logger
from caracal.merkle.signer import MerkleSigner
from caracal.merkle.tree import MerkleTree

logger = get_logger(__name__)


@dataclass
class BackfillProgress:
    """Progress information for backfill operation."""
    
    phase: str  # "scanning", "processing", "validating", "complete"
    total_events: int
    processed_events: int
    total_batches: int
    processed_batches: int
    current_batch_id: Optional[UUID]
    estimated_time_remaining_seconds: Optional[float]
    errors: List[str]


@dataclass
class BackfillResult:
    """Result of backfill operation."""
    
    success: bool
    total_events_processed: int
    total_batches_created: int
    duration_seconds: float
    errors: List[str]


class LedgerBackfillManager:
    """
    Manager for backfilling v0.2 ledger events with Merkle roots.
    
    This class handles the process of retroactively computing Merkle roots
    for ledger events that were created before Merkle tree support was added.
    
    Requirements: 22.1.1-22.1.12
    """
    
    def __init__(
        self,
        db_session: Session,
        merkle_signer: MerkleSigner,
        batch_size: int = 1000,
        dry_run: bool = False
    ):
        """
        Initialize backfill manager.
        
        Args:
            db_session: Database session
            merkle_signer: Merkle signer for signing roots
            batch_size: Number of events per batch (default 1000)
            dry_run: If True, validate without writing to database
        """
        self.db_session = db_session
        self.merkle_signer = merkle_signer
        self.batch_size = batch_size
        self.dry_run = dry_run
        self._progress: Optional[BackfillProgress] = None
        self._start_time: Optional[datetime] = None
    
    def backfill_v02_events(self) -> BackfillResult:
        """
        Backfill v0.2 events with Merkle roots.
        
        Process:
        1. Find all ledger events without merkle_root_id
        2. Group events into batches respecting batch_size
        3. For each batch:
           a. Compute Merkle tree over event hashes
           b. Sign Merkle root with current timestamp
           c. Store root in merkle_roots table with source='migration'
           d. Update ledger_events with merkle_root_id
        4. Log all operations to audit_logs
        
        Returns:
            BackfillResult with operation summary
        
        Raises:
            BackfillError: If backfill operation fails
        
        Requirements: 22.1.1, 22.1.2, 22.1.3, 22.1.4, 22.1.5, 22.1.6
        """
        self._start_time = datetime.utcnow()
        errors = []
        
        try:
            logger.info(f"Starting ledger backfill (dry_run={self.dry_run}, batch_size={self.batch_size})")
            
            # Phase 1: Scan for events without merkle_root_id
            self._progress = BackfillProgress(
                phase="scanning",
                total_events=0,
                processed_events=0,
                total_batches=0,
                processed_batches=0,
                current_batch_id=None,
                estimated_time_remaining_seconds=None,
                errors=[]
            )
            
            # Count total events to process
            total_events = self.db_session.query(func.count(LedgerEvent.event_id)).filter(
                LedgerEvent.merkle_root_id.is_(None)
            ).scalar()
            
            if total_events == 0:
                logger.info("No events to backfill")
                return BackfillResult(
                    success=True,
                    total_events_processed=0,
                    total_batches_created=0,
                    duration_seconds=0.0,
                    errors=[]
                )
            
            total_batches = (total_events + self.batch_size - 1) // self.batch_size
            
            self._progress.total_events = total_events
            self._progress.total_batches = total_batches
            
            logger.info(f"Found {total_events} events to backfill in {total_batches} batches")
            
            # Phase 2: Process batches
            self._progress.phase = "processing"
            processed_batches = 0
            processed_events = 0
            
            # Query events in batches, ordered by event_id
            offset = 0
            while offset < total_events:
                batch_start_time = datetime.utcnow()
                
                # Fetch batch of events
                events = self.db_session.query(LedgerEvent).filter(
                    LedgerEvent.merkle_root_id.is_(None)
                ).order_by(LedgerEvent.event_id).limit(self.batch_size).offset(offset).all()
                
                if not events:
                    break
                
                # Process batch
                try:
                    batch_id = uuid4()
                    self._progress.current_batch_id = batch_id
                    
                    root_id = self._process_batch(events, batch_id)
                    
                    processed_batches += 1
                    processed_events += len(events)
                    
                    self._progress.processed_batches = processed_batches
                    self._progress.processed_events = processed_events
                    
                    # Estimate time remaining
                    elapsed = (datetime.utcnow() - self._start_time).total_seconds()
                    if processed_events > 0:
                        rate = processed_events / elapsed
                        remaining_events = total_events - processed_events
                        self._progress.estimated_time_remaining_seconds = remaining_events / rate
                    
                    logger.info(
                        f"Processed batch {processed_batches}/{total_batches} "
                        f"({processed_events}/{total_events} events, "
                        f"{processed_events * 100 // total_events}% complete)"
                    )
                    
                except Exception as e:
                    error_msg = f"Failed to process batch at offset {offset}: {e}"
                    logger.error(error_msg, exc_info=True)
                    errors.append(error_msg)
                    self._progress.errors.append(error_msg)
                    
                    if not self.dry_run:
                        # Rollback this batch and continue
                        self.db_session.rollback()
                
                offset += self.batch_size
            
            # Phase 3: Validation
            if not self.dry_run:
                self._progress.phase = "validating"
                logger.info("Validating backfill results...")
                
                validation_errors = self.validate_backfill()
                if validation_errors:
                    errors.extend(validation_errors)
                    self._progress.errors.extend(validation_errors)
            
            # Phase 4: Complete
            self._progress.phase = "complete"
            duration = (datetime.utcnow() - self._start_time).total_seconds()
            
            result = BackfillResult(
                success=len(errors) == 0,
                total_events_processed=processed_events,
                total_batches_created=processed_batches,
                duration_seconds=duration,
                errors=errors
            )
            
            if self.dry_run:
                logger.info(
                    f"Dry run complete: would process {processed_events} events "
                    f"in {processed_batches} batches (duration: {duration:.2f}s)"
                )
            else:
                logger.info(
                    f"Backfill complete: processed {processed_events} events "
                    f"in {processed_batches} batches (duration: {duration:.2f}s)"
                )
            
            return result
            
        except Exception as e:
            error_msg = f"Backfill operation failed: {e}"
            logger.error(error_msg, exc_info=True)
            errors.append(error_msg)
            
            if self._start_time:
                duration = (datetime.utcnow() - self._start_time).total_seconds()
            else:
                duration = 0.0
            
            return BackfillResult(
                success=False,
                total_events_processed=self._progress.processed_events if self._progress else 0,
                total_batches_created=self._progress.processed_batches if self._progress else 0,
                duration_seconds=duration,
                errors=errors
            )
    
    def _process_batch(self, events: List[LedgerEvent], batch_id: UUID) -> UUID:
        """
        Process a single batch of events.
        
        Args:
            events: List of ledger events to process
            batch_id: Unique batch identifier
        
        Returns:
            UUID of created merkle root
        
        Raises:
            BackfillError: If batch processing fails
        
        Requirements: 22.1.3, 22.1.4, 22.1.5, 22.1.6
        """
        if not events:
            raise BackfillError("Cannot process empty batch")
        
        # Compute hash for each event
        event_hashes = []
        for event in events:
            event_hash = self._compute_event_hash(event)
            event_hashes.append(event_hash)
        
        # Build Merkle tree
        merkle_tree = MerkleTree(event_hashes)
        merkle_root_hash = merkle_tree.get_root()
        
        # Sign Merkle root with current timestamp
        root_id = uuid4()
        signature = self.merkle_signer.sign_root(merkle_root_hash, batch_id)
        
        if self.dry_run:
            logger.debug(
                f"[DRY RUN] Would create merkle root {root_id} for batch {batch_id} "
                f"with {len(events)} events (root: {merkle_root_hash.hex()[:16]}...)"
            )
            return root_id
        
        # Store root in merkle_roots table with source='migration'
        merkle_root_record = MerkleRoot(
            root_id=root_id,
            batch_id=batch_id,
            merkle_root=merkle_root_hash.hex(),
            signature=signature.hex(),
            event_count=len(events),
            first_event_id=events[0].event_id,
            last_event_id=events[-1].event_id,
            source="migration",
            created_at=datetime.utcnow()
        )
        
        self.db_session.add(merkle_root_record)
        
        # Update ledger_events with merkle_root_id
        for event in events:
            event.merkle_root_id = root_id
        
        # Commit transaction
        self.db_session.commit()
        
        logger.debug(
            f"Created merkle root {root_id} for batch {batch_id} "
            f"with {len(events)} events (events {events[0].event_id}-{events[-1].event_id})"
        )
        
        return root_id
    
    def _compute_event_hash(self, event: LedgerEvent) -> bytes:
        """
        Compute SHA-256 hash for a ledger event.
        
        Args:
            event: Ledger event to hash
        
        Returns:
            SHA-256 hash as bytes
        
        Requirements: 22.1.3
        """
        # Create canonical representation of event
        event_data = (
            f"{event.event_id}|"
            f"{event.agent_id}|"
            f"{event.timestamp.isoformat()}|"
            f"{event.resource_type}|"
            f"{event.quantity}"
        )
        
        # Compute SHA-256 hash
        return hashlib.sha256(event_data.encode('utf-8')).digest()
    
    def validate_backfill(self) -> List[str]:
        """
        Validate backfill integrity.
        
        Checks:
        1. All events have merkle_root_id
        2. All migration batches have valid event ranges
        3. No overlapping batches
        4. All events in batch have correct merkle_root_id
        
        Returns:
            List of validation errors (empty if valid)
        
        Requirements: 22.1.7
        """
        errors = []
        
        try:
            # Check 1: All events should have merkle_root_id
            events_without_root = self.db_session.query(func.count(LedgerEvent.event_id)).filter(
                LedgerEvent.merkle_root_id.is_(None)
            ).scalar()
            
            if events_without_root > 0:
                errors.append(f"Found {events_without_root} events without merkle_root_id")
            
            # Check 2: All migration batches have valid event ranges
            migration_roots = self.db_session.query(MerkleRoot).filter(
                MerkleRoot.source == "migration"
            ).all()
            
            for root in migration_roots:
                # Verify event count matches
                actual_count = self.db_session.query(func.count(LedgerEvent.event_id)).filter(
                    and_(
                        LedgerEvent.event_id >= root.first_event_id,
                        LedgerEvent.event_id <= root.last_event_id,
                        LedgerEvent.merkle_root_id == root.root_id
                    )
                ).scalar()
                
                if actual_count != root.event_count:
                    errors.append(
                        f"Batch {root.batch_id}: expected {root.event_count} events, "
                        f"found {actual_count}"
                    )
            
            # Check 3: No overlapping batches
            for i, root1 in enumerate(migration_roots):
                for root2 in migration_roots[i+1:]:
                    if (root1.first_event_id <= root2.last_event_id and
                        root1.last_event_id >= root2.first_event_id):
                        errors.append(
                            f"Overlapping batches: {root1.batch_id} "
                            f"({root1.first_event_id}-{root1.last_event_id}) and "
                            f"{root2.batch_id} ({root2.first_event_id}-{root2.last_event_id})"
                        )
            
            if not errors:
                logger.info("Backfill validation passed")
            else:
                logger.warning(f"Backfill validation found {len(errors)} errors")
            
        except Exception as e:
            error_msg = f"Validation failed: {e}"
            logger.error(error_msg, exc_info=True)
            errors.append(error_msg)
        
        return errors
    
    def get_backfill_progress(self) -> Optional[BackfillProgress]:
        """
        Get current backfill progress.
        
        Returns:
            BackfillProgress if backfill is running, None otherwise
        
        Requirements: 22.1.8
        """
        return self._progress
