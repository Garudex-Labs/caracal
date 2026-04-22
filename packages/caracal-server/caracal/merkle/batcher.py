"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Merkle batcher for accumulating events and triggering batch signing.

This module implements event batching with configurable thresholds:
- Batch size limit: Maximum number of events per batch
- Batch timeout: Maximum time before batch closes

Batches close when EITHER threshold is reached (whichever comes first).
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional
from uuid import UUID, uuid4

from caracal.logging_config import get_logger
from caracal.merkle.tree import MerkleTree

logger = get_logger(__name__)


@dataclass
class MerkleBatch:
    """
    Metadata for a completed Merkle batch.
    
    Attributes:
        batch_id: Unique identifier for the batch
        event_ids: List of ledger event IDs in the batch
        event_count: Number of events in the batch
        merkle_root: Computed Merkle root hash
        created_at: Timestamp when batch was created
    """
    batch_id: UUID
    event_ids: List[int]
    event_count: int
    merkle_root: bytes
    created_at: datetime


class MerkleBatcher:
    """
    Accumulates events into batches and triggers Merkle tree computation.
    
    The batcher maintains a buffer of events and closes batches based on
    configurable thresholds:
    - batch_size_limit: Max events per batch (default 1000)
    - batch_timeout_seconds: Max time before batch closes (default 300 seconds / 5 minutes)
    
    Batch closes when EITHER threshold is reached (whichever comes first).
    
    Example:
        >>> from caracal.merkle.batcher import MerkleBatcher
        >>> from caracal.merkle.signer import SoftwareSigner
        >>> 
        >>> signer = SoftwareSigner("/path/to/key.pem")
        >>> batcher = MerkleBatcher(
        ...     batch_size_limit=1000,
        ...     batch_timeout_seconds=300,
        ...     merkle_signer=signer
        ... )
        >>> 
        >>> # Add events to batch
        >>> await batcher.add_event(event1)
        >>> await batcher.add_event(event2)
        >>> 
        >>> # Batch automatically closes when threshold reached
    """
    
    def __init__(
        self,
        merkle_signer,  # Type hint omitted to avoid circular import
        batch_size_limit: int = 1000,
        batch_timeout_seconds: int = 300,
    ):
        """
        Initialize batcher with configurable thresholds.
        
        Args:
            merkle_signer: MerkleSigner instance for signing roots
            batch_size_limit: Max events per batch (default 1000)
            batch_timeout_seconds: Max time before batch closes (default 300 seconds / 5 minutes)
        
        Raises:
            ValueError: If thresholds are invalid
        """
        if batch_size_limit < 1:
            raise ValueError(f"batch_size_limit must be at least 1, got {batch_size_limit}")
        if batch_timeout_seconds < 1:
            raise ValueError(f"batch_timeout_seconds must be at least 1, got {batch_timeout_seconds}")
        
        self.merkle_signer = merkle_signer
        self.batch_size_limit = batch_size_limit
        self.batch_timeout_seconds = batch_timeout_seconds
        
        # Current batch buffer
        self._current_batch: List[tuple] = []  # List of (event_id, event_hash) tuples
        self._batch_start_time: Optional[datetime] = None
        self._timeout_task: Optional[asyncio.Task] = None
        
        # Lock for thread-safe batch operations
        self._lock = asyncio.Lock()
        
        logger.info(
            f"Initialized MerkleBatcher with batch_size_limit={batch_size_limit}, "
            f"batch_timeout_seconds={batch_timeout_seconds}"
        )
    
    async def add_event(self, event_id: int, event_hash: bytes) -> Optional[MerkleBatch]:
        """
        Add event to current batch.
        
        If batch size threshold is reached, closes the batch automatically.
        If this is the first event in a new batch, starts the timeout timer.
        
        Args:
            event_id: Ledger event ID
            event_hash: SHA-256 hash of the event data
        
        Returns:
            MerkleBatch if batch was closed, None otherwise
        
        Raises:
            ValueError: If event_id or event_hash is invalid
        """
        if event_id < 0:
            raise ValueError(f"event_id must be non-negative, got {event_id}")
        if not event_hash or len(event_hash) != 32:
            raise ValueError(f"event_hash must be 32 bytes (SHA-256), got {len(event_hash) if event_hash else 0} bytes")
        
        async with self._lock:
            # If this is the first event in a new batch, start timeout timer
            if not self._current_batch:
                self._batch_start_time = datetime.utcnow()
                self._start_timeout_timer()
                logger.debug(f"Started new batch at {self._batch_start_time}")
            
            # Add event to batch
            self._current_batch.append((event_id, event_hash))
            logger.debug(f"Added event {event_id} to batch (size: {len(self._current_batch)}/{self.batch_size_limit})")
            
            # Check if batch size threshold reached
            if len(self._current_batch) >= self.batch_size_limit:
                logger.info(f"Batch size threshold reached ({self.batch_size_limit} events), closing batch")
                return await self._close_batch_internal()
            
            return None
    
    async def close_batch(self) -> Optional[MerkleBatch]:
        """
        Manually close the current batch.
        
        This is useful for forcing a batch close before thresholds are reached,
        such as during shutdown or testing.
        
        Returns:
            MerkleBatch if batch had events, None if batch was empty
        """
        async with self._lock:
            return await self._close_batch_internal()
    
    async def _close_batch_internal(self) -> Optional[MerkleBatch]:
        """
        Internal method to close batch (must be called with lock held).
        
        Returns:
            MerkleBatch if batch had events, None if batch was empty
        """
        # Cancel timeout timer if running
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()
            try:
                await self._timeout_task
            except asyncio.CancelledError:
                pass
            self._timeout_task = None
        
        # If batch is empty, nothing to do
        if not self._current_batch:
            logger.debug("Attempted to close empty batch, skipping")
            return None
        
        # Extract event IDs and hashes
        event_ids = [event_id for event_id, _ in self._current_batch]
        event_hashes = [event_hash for _, event_hash in self._current_batch]
        event_count = len(event_ids)
        
        logger.info(f"Closing batch with {event_count} events (IDs: {event_ids[0]} to {event_ids[-1]})")
        
        # Compute Merkle tree
        try:
            merkle_tree = MerkleTree(event_hashes)
            merkle_root = merkle_tree.get_root()
            logger.debug(f"Computed Merkle root: {merkle_root.hex()}")
        except Exception as e:
            logger.error(f"Failed to compute Merkle tree: {e}", exc_info=True)
            raise
        
        # Create batch metadata
        batch = MerkleBatch(
            batch_id=uuid4(),
            event_ids=event_ids,
            event_count=event_count,
            merkle_root=merkle_root,
            created_at=datetime.utcnow(),
        )
        
        # Send to Merkle signer
        try:
            await self.merkle_signer.sign_root(merkle_root, batch)
            logger.info(f"Batch {batch.batch_id} signed successfully")
        except Exception as e:
            logger.error(f"Failed to sign Merkle root for batch {batch.batch_id}: {e}", exc_info=True)
            raise
        
        # Clear batch buffer
        self._current_batch = []
        self._batch_start_time = None
        
        return batch
    
    def _start_timeout_timer(self):
        """Start timeout timer for current batch."""
        if self._timeout_task and not self._timeout_task.done():
            # Timer already running
            return
        
        self._timeout_task = asyncio.create_task(self._timeout_handler())
        logger.debug(f"Started batch timeout timer ({self.batch_timeout_seconds} seconds)")
    
    async def _timeout_handler(self):
        """
        Handle batch timeout.
        
        Waits for the configured timeout duration, then closes the batch.
        """
        try:
            await asyncio.sleep(self.batch_timeout_seconds)
            
            # Timeout reached, close batch
            logger.info(f"Batch timeout reached ({self.batch_timeout_seconds} seconds), closing batch")
            async with self._lock:
                await self._close_batch_internal()
        except asyncio.CancelledError:
            # Timer was cancelled (batch closed by size threshold)
            logger.debug("Batch timeout timer cancelled")
            pass
    
    async def shutdown(self):
        """
        Shutdown batcher and close any pending batch.
        
        This should be called during application shutdown to ensure
        all events are batched and signed.
        """
        logger.info("Shutting down MerkleBatcher")
        
        async with self._lock:
            # Close any pending batch
            if self._current_batch:
                logger.info(f"Closing pending batch with {len(self._current_batch)} events during shutdown")
                await self._close_batch_internal()
            
            # Cancel timeout timer if running
            if self._timeout_task and not self._timeout_task.done():
                self._timeout_task.cancel()
                try:
                    await self._timeout_task
                except asyncio.CancelledError:
                    pass
        
        logger.info("MerkleBatcher shutdown complete")
    
    def get_current_batch_size(self) -> int:
        """
        Get the current batch size.
        
        Returns:
            Number of events in the current batch
        """
        return len(self._current_batch)
    
    def get_batch_age(self) -> Optional[timedelta]:
        """
        Get the age of the current batch.
        
        Returns:
            Time since batch started, or None if no batch is active
        """
        if self._batch_start_time:
            return datetime.utcnow() - self._batch_start_time
        return None
