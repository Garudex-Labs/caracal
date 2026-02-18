"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Scheduled snapshot creation for Caracal Core v0.3.

This module provides a scheduler for creating ledger snapshots at regular intervals
(e.g., daily at midnight UTC).

Requirements: 12.1
"""

import asyncio
import signal
import sys
from datetime import datetime, time, timedelta
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from caracal.logging_config import get_logger
from caracal.merkle.snapshot import SnapshotManager

logger = get_logger(__name__)


class SnapshotScheduler:
    """
    Scheduler for automatic snapshot creation.
    
    Creates snapshots at configured intervals (default: daily at midnight UTC).
    Logs all snapshot creation operations.
    
    Requirements: 12.1
    """

    def __init__(
        self,
        snapshot_manager: SnapshotManager,
        schedule: str = "0 0 * * *",  # Daily at midnight UTC (cron format)
        retention_days: int = 90,
        cleanup_enabled: bool = True,
    ):
        """
        Initialize SnapshotScheduler.
        
        Args:
            snapshot_manager: SnapshotManager instance for creating snapshots
            schedule: Cron schedule for snapshot creation (default: "0 0 * * *" = daily at midnight)
            retention_days: Number of days to retain snapshots (default: 90)
            cleanup_enabled: Whether to run cleanup of old snapshots (default: True)
        """
        self.snapshot_manager = snapshot_manager
        self.schedule = schedule
        self.retention_days = retention_days
        self.cleanup_enabled = cleanup_enabled
        
        self.scheduler = AsyncIOScheduler()
        self._running = False
        
        logger.info(
            f"SnapshotScheduler initialized with schedule: {schedule}, "
            f"retention: {retention_days} days, cleanup: {cleanup_enabled}"
        )

    def start(self):
        """
        Start the snapshot scheduler.
        
        Schedules snapshot creation according to the configured cron schedule.
        Also schedules daily cleanup of old snapshots if enabled.
        """
        if self._running:
            logger.warning("SnapshotScheduler is already running")
            return
        
        try:
            # Schedule snapshot creation
            self.scheduler.add_job(
                self._create_snapshot_job,
                trigger=CronTrigger.from_crontab(self.schedule),
                id="snapshot_creation",
                name="Create ledger snapshot",
                replace_existing=True,
            )
            
            logger.info(f"Scheduled snapshot creation with cron: {self.schedule}")
            
            # Schedule cleanup if enabled
            if self.cleanup_enabled:
                # Run cleanup daily at 1 AM UTC (after snapshot creation)
                self.scheduler.add_job(
                    self._cleanup_snapshots_job,
                    trigger=CronTrigger(hour=1, minute=0),
                    id="snapshot_cleanup",
                    name="Cleanup old snapshots",
                    replace_existing=True,
                )
                
                logger.info("Scheduled snapshot cleanup daily at 1 AM UTC")
            
            # Start the scheduler
            self.scheduler.start()
            self._running = True
            
            logger.info("SnapshotScheduler started successfully")
            
        except Exception as e:
            logger.error(f"Failed to start SnapshotScheduler: {e}", exc_info=True)
            raise

    def stop(self):
        """
        Stop the snapshot scheduler.
        
        Gracefully shuts down the scheduler and waits for running jobs to complete.
        """
        if not self._running:
            logger.warning("SnapshotScheduler is not running")
            return
        
        try:
            logger.info("Stopping SnapshotScheduler...")
            
            self.scheduler.shutdown(wait=True)
            self._running = False
            
            logger.info("SnapshotScheduler stopped successfully")
            
        except Exception as e:
            logger.error(f"Error stopping SnapshotScheduler: {e}", exc_info=True)

    async def _create_snapshot_job(self):
        """
        Job function for creating snapshots.
        
        Called by the scheduler according to the configured schedule.
        Logs all operations and errors.
        """
        try:
            logger.info("Starting scheduled snapshot creation")
            start_time = datetime.utcnow()
            
            # Create snapshot
            snapshot = self.snapshot_manager.create_snapshot()
            
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            logger.info(
                f"Scheduled snapshot creation completed successfully. "
                f"Snapshot ID: {snapshot.snapshot_id}, "
                f"Events: {snapshot.total_events}, "
                f"Duration: {duration:.2f}s"
            )
            
        except Exception as e:
            logger.error(f"Scheduled snapshot creation failed: {e}", exc_info=True)

    async def _cleanup_snapshots_job(self):
        """
        Job function for cleaning up old snapshots.
        
        Called by the scheduler daily to remove snapshots older than retention period.
        Logs all operations and errors.
        """
        try:
            logger.info(f"Starting scheduled snapshot cleanup (retention: {self.retention_days} days)")
            start_time = datetime.utcnow()
            
            # Cleanup old snapshots
            deleted_count = self.snapshot_manager.cleanup_old_snapshots(self.retention_days)
            
            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()
            
            logger.info(
                f"Scheduled snapshot cleanup completed. "
                f"Deleted: {deleted_count} snapshots, "
                f"Duration: {duration:.2f}s"
            )
            
        except Exception as e:
            logger.error(f"Scheduled snapshot cleanup failed: {e}", exc_info=True)

    def create_snapshot_now(self):
        """
        Trigger an immediate snapshot creation (outside of schedule).
        
        Useful for manual snapshot creation via CLI or API.
        
        Returns:
            LedgerSnapshot: Created snapshot
        """
        try:
            logger.info("Creating snapshot on demand")
            snapshot = self.snapshot_manager.create_snapshot()
            logger.info(f"On-demand snapshot created: {snapshot.snapshot_id}")
            return snapshot
        except Exception as e:
            logger.error(f"On-demand snapshot creation failed: {e}", exc_info=True)
            raise

    def get_next_run_time(self) -> Optional[datetime]:
        """
        Get the next scheduled snapshot creation time.
        
        Returns:
            Next run time as datetime, or None if scheduler not running
        """
        if not self._running:
            return None
        
        job = self.scheduler.get_job("snapshot_creation")
        if job and job.next_run_time:
            return job.next_run_time
        
        return None

    def is_running(self) -> bool:
        """
        Check if the scheduler is running.
        
        Returns:
            True if scheduler is running, False otherwise
        """
        return self._running


def run_snapshot_scheduler(
    snapshot_manager: SnapshotManager,
    schedule: str = "0 0 * * *",
    retention_days: int = 90,
):
    """
    Run the snapshot scheduler as a standalone service.
    
    This function sets up signal handlers for graceful shutdown and runs
    the scheduler until interrupted.
    
    Args:
        snapshot_manager: SnapshotManager instance
        schedule: Cron schedule for snapshot creation
        retention_days: Number of days to retain snapshots
    """
    scheduler = SnapshotScheduler(
        snapshot_manager=snapshot_manager,
        schedule=schedule,
        retention_days=retention_days,
    )
    
    # Setup signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, shutting down...")
        scheduler.stop()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start scheduler
    scheduler.start()
    
    logger.info("Snapshot scheduler is running. Press Ctrl+C to stop.")
    
    # Keep the main thread alive
    try:
        while scheduler.is_running():
            asyncio.sleep(1)
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received, shutting down...")
        scheduler.stop()
