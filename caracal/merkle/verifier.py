"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Merkle verifier for cryptographic ledger integrity verification.

This module implements verification of Merkle tree batches, including:
- Batch verification: Recompute Merkle root and compare with stored root
- Time range verification: Verify all batches in a time range
- Event inclusion verification: Verify an event is included in the ledger
"""

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from caracal.db.models import LedgerEvent, MerkleRoot
from caracal.logging_config import get_logger
from caracal.merkle.tree import MerkleTree

logger = get_logger(__name__)


@dataclass
class VerificationResult:
    """
    Result of verifying a single Merkle batch.
    
    Attributes:
        batch_id: Batch identifier
        verified: True if verification passed
        stored_root: Merkle root stored in database
        computed_root: Merkle root recomputed from events
        signature_valid: True if signature is valid
        is_migration_batch: True if batch is from v0.2 backfill
        error_message: Error message if verification failed
    """
    batch_id: UUID
    verified: bool
    stored_root: bytes
    computed_root: bytes
    signature_valid: bool
    is_migration_batch: bool = False
    error_message: Optional[str] = None


@dataclass
class VerificationSummary:
    """
    Summary of verifying multiple batches.
    
    Attributes:
        total_batches: Total number of batches verified
        verified_batches: Number of batches that passed verification
        failed_batches: Number of batches that failed verification
        verification_errors: List of failed verification results
    """
    total_batches: int
    verified_batches: int
    failed_batches: int
    verification_errors: List[VerificationResult]


class MerkleVerifier:
    """
    Verify ledger integrity using Merkle trees.
    
    The verifier recomputes Merkle roots from ledger events and compares
    them with stored signed roots to detect tampering.
    
    Example:
        >>> from caracal.merkle.verifier import MerkleVerifier
        >>> from caracal.merkle.signer import SoftwareSigner
        >>> 
        >>> signer = SoftwareSigner("/path/to/key.pem")
        >>> verifier = MerkleVerifier(db_session, signer)
        >>> 
        >>> # Verify a single batch
        >>> result = await verifier.verify_batch(batch_id)
        >>> assert result.verified
        >>> 
        >>> # Verify all batches in a time range
        >>> summary = await verifier.verify_time_range(start_time, end_time)
        >>> print(f"Verified {summary.verified_batches}/{summary.total_batches} batches")
    """
    
    def __init__(self, db_session: AsyncSession, merkle_signer):
        """
        Initialize verifier with database session and signer.
        
        Args:
            db_session: SQLAlchemy async session
            merkle_signer: MerkleSigner instance for signature verification
        """
        self.db_session = db_session
        self.merkle_signer = merkle_signer
        logger.info("Initialized MerkleVerifier")
    
    async def verify_batch(self, batch_id: UUID) -> VerificationResult:
        """
        Verify a single Merkle batch.
        
        Steps:
        1. Load Merkle root record from database
        2. Load all events in the batch from ledger_events
        3. Recompute Merkle tree from events
        4. Compare recomputed root with stored root
        5. Verify signature on stored root
        6. Handle migration batches (source='migration') with relaxed timestamp checks
        
        Args:
            batch_id: Batch identifier to verify
        
        Returns:
            VerificationResult with verification status
        
        """
        logger.info(f"Verifying batch {batch_id}")
        
        try:
            # Load Merkle root record
            stmt = select(MerkleRoot).where(MerkleRoot.batch_id == batch_id)
            result = await self.db_session.execute(stmt)
            merkle_root_record = result.scalar_one_or_none()
            
            if not merkle_root_record:
                error_msg = f"Merkle root not found for batch {batch_id}"
                logger.error(error_msg)
                return VerificationResult(
                    batch_id=batch_id,
                    verified=False,
                    stored_root=b"",
                    computed_root=b"",
                    signature_valid=False,
                    is_migration_batch=False,
                    error_message=error_msg,
                )
            
            # Check if this is a migration batch
            is_migration_batch = merkle_root_record.source == "migration"
            
            if is_migration_batch:
                logger.info(f"Batch {batch_id} is a migration batch (v0.2 backfill)")
            
            # Decode stored root and signature from hex
            stored_root = bytes.fromhex(merkle_root_record.merkle_root)
            signature = bytes.fromhex(merkle_root_record.signature)
            
            # Load events in the batch
            stmt = select(LedgerEvent).where(
                LedgerEvent.event_id >= merkle_root_record.first_event_id,
                LedgerEvent.event_id <= merkle_root_record.last_event_id,
            ).order_by(LedgerEvent.event_id)
            
            result = await self.db_session.execute(stmt)
            events = result.scalars().all()
            
            if not events:
                error_msg = f"No events found for batch {batch_id}"
                logger.error(error_msg)
                return VerificationResult(
                    batch_id=batch_id,
                    verified=False,
                    stored_root=stored_root,
                    computed_root=b"",
                    signature_valid=False,
                    is_migration_batch=is_migration_batch,
                    error_message=error_msg,
                )
            
            # Check event count matches
            if len(events) != merkle_root_record.event_count:
                error_msg = (
                    f"Event count mismatch for batch {batch_id}: "
                    f"expected {merkle_root_record.event_count}, found {len(events)}"
                )
                logger.error(error_msg)
                return VerificationResult(
                    batch_id=batch_id,
                    verified=False,
                    stored_root=stored_root,
                    computed_root=b"",
                    signature_valid=False,
                    is_migration_batch=is_migration_batch,
                    error_message=error_msg,
                )
            
            # For migration batches, verify timestamp relationship
            # Migration batches have signature timestamp > event timestamps (retroactive signing)
            if is_migration_batch:
                # Check that signature timestamp is after all event timestamps
                latest_event_timestamp = max(event.timestamp for event in events)
                if merkle_root_record.created_at < latest_event_timestamp:
                    logger.warning(
                        f"Migration batch {batch_id} has signature timestamp "
                        f"({merkle_root_record.created_at}) before latest event timestamp "
                        f"({latest_event_timestamp}). This indicates a potential issue."
                    )
            
            # Compute event hashes
            event_hashes = []
            for event in events:
                # Hash event data (same as batcher does)
                event_data = (
                    f"{event.event_id}|{event.agent_id}|{event.timestamp.isoformat()}|"
                    f"{event.resource_type}|{event.quantity}"
                ).encode()
                event_hash = hashlib.sha256(event_data).digest()
                event_hashes.append(event_hash)
            
            # Recompute Merkle tree
            merkle_tree = MerkleTree(event_hashes)
            computed_root = merkle_tree.get_root()
            
            # Compare roots
            roots_match = stored_root == computed_root
            
            # Verify signature
            signature_valid = await self.merkle_signer.verify_signature(stored_root, signature)
            
            # Overall verification passes if both roots match and signature is valid
            verified = roots_match and signature_valid
            
            if verified:
                if is_migration_batch:
                    logger.info(
                        f"Migration batch {batch_id} verified successfully "
                        f"(Note: Reduced integrity guarantees for pre-v0.3 events)"
                    )
                else:
                    logger.info(f"Batch {batch_id} verified successfully")
            else:
                error_parts = []
                if not roots_match:
                    error_parts.append(
                        f"root mismatch (stored: {stored_root.hex()[:16]}..., "
                        f"computed: {computed_root.hex()[:16]}...)"
                    )
                if not signature_valid:
                    error_parts.append("invalid signature")
                error_msg = f"Verification failed: {', '.join(error_parts)}"
                logger.warning(f"Batch {batch_id} verification failed: {error_msg}")
            
            return VerificationResult(
                batch_id=batch_id,
                verified=verified,
                stored_root=stored_root,
                computed_root=computed_root,
                signature_valid=signature_valid,
                is_migration_batch=is_migration_batch,
                error_message=None if verified else error_msg,
            )
        
        except Exception as e:
            error_msg = f"Exception during verification: {str(e)}"
            logger.error(f"Failed to verify batch {batch_id}: {error_msg}", exc_info=True)
            return VerificationResult(
                batch_id=batch_id,
                verified=False,
                stored_root=b"",
                computed_root=b"",
                signature_valid=False,
                is_migration_batch=False,
                error_message=error_msg,
            )
    
    async def verify_time_range(
        self,
        start_time: datetime,
        end_time: datetime,
    ) -> VerificationSummary:
        """
        Verify all batches in a time range.
        
        Steps:
        1. Query all Merkle root records in the time range
        2. Verify each batch
        3. Aggregate results into a summary
        
        Args:
            start_time: Start of time range (inclusive)
            end_time: End of time range (inclusive)
        
        Returns:
            VerificationSummary with aggregated results
        
        """
        logger.info(f"Verifying batches from {start_time} to {end_time}")
        
        try:
            # Query all batches in time range
            stmt = select(MerkleRoot).where(
                MerkleRoot.created_at >= start_time,
                MerkleRoot.created_at <= end_time,
            ).order_by(MerkleRoot.created_at)
            
            result = await self.db_session.execute(stmt)
            merkle_roots = result.scalars().all()
            
            if not merkle_roots:
                logger.info(f"No batches found in time range {start_time} to {end_time}")
                return VerificationSummary(
                    total_batches=0,
                    verified_batches=0,
                    failed_batches=0,
                    verification_errors=[],
                )
            
            logger.info(f"Found {len(merkle_roots)} batches to verify")
            
            # Verify each batch
            verification_results = []
            verified_count = 0
            failed_count = 0
            
            for merkle_root in merkle_roots:
                result = await self.verify_batch(merkle_root.batch_id)
                verification_results.append(result)
                
                if result.verified:
                    verified_count += 1
                else:
                    failed_count += 1
            
            # Collect failed verifications
            verification_errors = [r for r in verification_results if not r.verified]
            
            summary = VerificationSummary(
                total_batches=len(merkle_roots),
                verified_batches=verified_count,
                failed_batches=failed_count,
                verification_errors=verification_errors,
            )
            
            logger.info(
                f"Time range verification complete: {verified_count}/{len(merkle_roots)} batches verified, "
                f"{failed_count} failed"
            )
            
            return summary
        
        except Exception as e:
            logger.error(f"Failed to verify time range: {e}", exc_info=True)
            raise
    
    async def verify_event_inclusion(self, event_id: int) -> bool:
        """
        Verify that an event is included in the ledger.
        
        Steps:
        1. Find the batch containing the event
        2. Generate Merkle proof for the event
        3. Verify proof against signed root
        
        Args:
            event_id: Ledger event ID to verify
        
        Returns:
            True if event is included and proof is valid, False otherwise
        
        """
        logger.info(f"Verifying inclusion of event {event_id}")
        
        try:
            # Find batch containing the event
            stmt = select(MerkleRoot).where(
                MerkleRoot.first_event_id <= event_id,
                MerkleRoot.last_event_id >= event_id,
            )
            
            result = await self.db_session.execute(stmt)
            merkle_root_record = result.scalar_one_or_none()
            
            if not merkle_root_record:
                logger.warning(f"No batch found containing event {event_id}")
                return False
            
            logger.debug(f"Event {event_id} found in batch {merkle_root_record.batch_id}")
            
            # Load all events in the batch
            stmt = select(LedgerEvent).where(
                LedgerEvent.event_id >= merkle_root_record.first_event_id,
                LedgerEvent.event_id <= merkle_root_record.last_event_id,
            ).order_by(LedgerEvent.event_id)
            
            result = await self.db_session.execute(stmt)
            events = result.scalars().all()
            
            # Find the event's index in the batch
            event_index = None
            event_hashes = []
            
            for i, event in enumerate(events):
                # Compute event hash
                event_data = (
                    f"{event.event_id}|{event.agent_id}|{event.timestamp.isoformat()}|"
                    f"{event.resource_type}|{event.quantity}"
                ).encode()
                event_hash = hashlib.sha256(event_data).digest()
                event_hashes.append(event_hash)
                
                if event.event_id == event_id:
                    event_index = i
            
            if event_index is None:
                logger.error(f"Event {event_id} not found in batch events")
                return False
            
            # Build Merkle tree
            merkle_tree = MerkleTree(event_hashes)
            
            # Generate proof for the event
            proof = merkle_tree.generate_proof(event_index)
            
            # Get stored root
            stored_root = bytes.fromhex(merkle_root_record.merkle_root)
            
            # Verify proof
            # Note: We need to pass the original event data, not the hash
            event_data = (
                f"{events[event_index].event_id}|{events[event_index].agent_id}|"
                f"{events[event_index].timestamp.isoformat()}|"
                f"{events[event_index].resource_type}|{events[event_index].quantity}"
            ).encode()
            
            is_valid = MerkleTree.verify_proof(event_data, proof, stored_root)
            
            if is_valid:
                logger.info(f"Event {event_id} inclusion verified successfully")
            else:
                logger.warning(f"Event {event_id} inclusion verification failed")
            
            return is_valid
        
        except Exception as e:
            logger.error(f"Failed to verify event inclusion for event {event_id}: {e}", exc_info=True)
            return False

    async def verify_backfill(self) -> VerificationSummary:
        """
        Verify integrity of all migration batches (v0.2 backfill).
        
        This method specifically verifies batches created during the v0.2 to v0.3
        migration process. Migration batches have reduced integrity guarantees
        because they were signed retroactively.
        
        Steps:
        1. Query all Merkle root records with source='migration'
        2. Verify each migration batch
        3. Aggregate results into a summary
        4. Document reduced integrity guarantees
        
        Returns:
            VerificationSummary with aggregated results for migration batches
        
        """
        logger.info("Verifying all migration batches (v0.2 backfill)")
        
        try:
            # Query all migration batches
            stmt = select(MerkleRoot).where(
                MerkleRoot.source == "migration"
            ).order_by(MerkleRoot.created_at)
            
            result = await self.db_session.execute(stmt)
            merkle_roots = result.scalars().all()
            
            if not merkle_roots:
                logger.info("No migration batches found")
                return VerificationSummary(
                    total_batches=0,
                    verified_batches=0,
                    failed_batches=0,
                    verification_errors=[],
                )
            
            logger.info(f"Found {len(merkle_roots)} migration batches to verify")
            logger.warning(
                "Note: Migration batches have reduced integrity guarantees. "
                "Signatures were created retroactively during v0.2 to v0.3 migration. "
                "This means the signature timestamp is after the event timestamps, "
                "which is expected for migration batches."
            )
            
            # Verify each batch
            verification_results = []
            verified_count = 0
            failed_count = 0
            
            for merkle_root in merkle_roots:
                result = await self.verify_batch(merkle_root.batch_id)
                verification_results.append(result)
                
                if result.verified:
                    verified_count += 1
                else:
                    failed_count += 1
            
            # Collect failed verifications
            verification_errors = [r for r in verification_results if not r.verified]
            
            summary = VerificationSummary(
                total_batches=len(merkle_roots),
                verified_batches=verified_count,
                failed_batches=failed_count,
                verification_errors=verification_errors,
            )
            
            logger.info(
                f"Migration batch verification complete: {verified_count}/{len(merkle_roots)} batches verified, "
                f"{failed_count} failed"
            )
            
            return summary
        
        except Exception as e:
            logger.error(f"Failed to verify migration batches: {e}", exc_info=True)
            raise
