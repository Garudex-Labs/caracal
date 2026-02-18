"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Partition management for Caracal Core v0.3.

This module provides functionality to manage PostgreSQL table partitions
for the ledger_events table. Supports automatic partition creation for
upcoming months and partition archival for old data.

Requirements: 20.5, 20.6, 20.7
"""

import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

from caracal.exceptions import DatabaseError

logger = logging.getLogger(__name__)


class PartitionManager:
    """
    Manager for PostgreSQL table partitions.
    
    Provides methods to create, list, and manage partitions for the
    ledger_events table. Partitions are created by month to optimize
    query performance and enable efficient archival.
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize partition manager.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
    
    def create_partition(
        self, 
        year: int, 
        month: int,
        if_not_exists: bool = True
    ) -> str:
        """
        Create a partition for the specified year and month.
        
        Args:
            year: Year for the partition (e.g., 2026)
            month: Month for the partition (1-12)
            if_not_exists: If True, skip if partition already exists
        
        Returns:
            Name of the created partition
        
        Raises:
            DatabaseError: If partition creation fails
            ValueError: If month is not in range 1-12
        """
        if not 1 <= month <= 12:
            raise ValueError(f"Month must be between 1 and 12, got {month}")
        
        try:
            # Calculate partition bounds
            start_date = datetime(year, month, 1)
            if month == 12:
                end_date = datetime(year + 1, 1, 1)
            else:
                end_date = datetime(year, month + 1, 1)
            
            partition_name = f"ledger_events_y{year}m{month:02d}"
            
            # Check if partition already exists
            if if_not_exists:
                check_sql = text("""
                    SELECT EXISTS (
                        SELECT 1 FROM pg_tables 
                        WHERE tablename = :partition_name
                    )
                """)
                result = self.db_session.execute(
                    check_sql, 
                    {"partition_name": partition_name}
                ).scalar()
                
                if result:
                    logger.info(f"Partition {partition_name} already exists, skipping")
                    return partition_name
            
            # Create partition
            create_sql = f"""
                CREATE TABLE {partition_name} PARTITION OF ledger_events
                FOR VALUES FROM ('{start_date.isoformat()}') TO ('{end_date.isoformat()}');
            """
            
            logger.info(f"Creating partition {partition_name} for {start_date.date()} to {end_date.date()}")
            self.db_session.execute(text(create_sql))
            self.db_session.commit()
            
            logger.info(f"Successfully created partition {partition_name}")
            return partition_name
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Failed to create partition for {year}-{month:02d}: {e}")
            raise DatabaseError(f"Partition creation failed: {e}") from e
    
    def create_upcoming_partitions(self, months_ahead: int = 3) -> List[str]:
        """
        Create partitions for upcoming months.
        
        This method should be run periodically (e.g., monthly) to ensure
        partitions exist for future data.
        
        Args:
            months_ahead: Number of months ahead to create partitions for
        
        Returns:
            List of created partition names
        
        Raises:
            DatabaseError: If partition creation fails
        """
        created_partitions = []
        current_date = datetime.utcnow()
        
        logger.info(f"Creating partitions for next {months_ahead} months")
        
        for i in range(months_ahead + 1):  # +1 to include current month
            # Calculate target month
            target_date = current_date + timedelta(days=30 * i)
            year = target_date.year
            month = target_date.month
            
            try:
                partition_name = self.create_partition(year, month, if_not_exists=True)
                created_partitions.append(partition_name)
            except Exception as e:
                logger.error(f"Failed to create partition for {year}-{month:02d}: {e}")
                # Continue creating other partitions even if one fails
        
        logger.info(f"Created {len(created_partitions)} partitions: {created_partitions}")
        return created_partitions
    
    def list_partitions(self) -> List[Tuple[str, datetime, datetime]]:
        """
        List all existing partitions for ledger_events table.
        
        Returns:
            List of tuples (partition_name, start_date, end_date)
        """
        try:
            sql = text("""
                SELECT 
                    c.relname as partition_name,
                    pg_get_expr(c.relpartbound, c.oid) as partition_bounds
                FROM pg_class c
                JOIN pg_inherits i ON c.oid = i.inhrelid
                JOIN pg_class p ON i.inhparent = p.oid
                WHERE p.relname = 'ledger_events'
                ORDER BY c.relname;
            """)
            
            result = self.db_session.execute(sql).fetchall()
            
            partitions = []
            for row in result:
                partition_name = row[0]
                # Parse partition bounds (format: "FOR VALUES FROM ('...') TO ('...')")
                bounds = row[1]
                
                # Extract dates from bounds string
                # This is a simplified parser - production code should be more robust
                try:
                    import re
                    dates = re.findall(r"'([^']+)'", bounds)
                    if len(dates) >= 2:
                        start_date = datetime.fromisoformat(dates[0])
                        end_date = datetime.fromisoformat(dates[1])
                        partitions.append((partition_name, start_date, end_date))
                except Exception as e:
                    logger.warning(f"Failed to parse bounds for {partition_name}: {e}")
            
            return partitions
            
        except Exception as e:
            logger.error(f"Failed to list partitions: {e}")
            return []
    
    def get_partition_size(self, partition_name: str) -> Optional[int]:
        """
        Get the size of a partition in bytes.
        
        Args:
            partition_name: Name of the partition
        
        Returns:
            Size in bytes, or None if partition doesn't exist
        """
        try:
            sql = text("""
                SELECT pg_total_relation_size(:partition_name)
            """)
            result = self.db_session.execute(
                sql, 
                {"partition_name": partition_name}
            ).scalar()
            
            return result
            
        except Exception as e:
            logger.warning(f"Failed to get size for {partition_name}: {e}")
            return None
    
    def get_partition_row_count(self, partition_name: str) -> Optional[int]:
        """
        Get the number of rows in a partition.
        
        Args:
            partition_name: Name of the partition
        
        Returns:
            Number of rows, or None if partition doesn't exist
        """
        try:
            sql = text(f"SELECT COUNT(*) FROM {partition_name}")
            result = self.db_session.execute(sql).scalar()
            return result
            
        except Exception as e:
            logger.warning(f"Failed to get row count for {partition_name}: {e}")
            return None
    
    def detach_partition(self, partition_name: str) -> None:
        """
        Detach a partition from the parent table.
        
        This is the first step in archiving old partitions. After detaching,
        the partition becomes a standalone table that can be backed up and
        dropped independently.
        
        Args:
            partition_name: Name of the partition to detach
        
        Raises:
            DatabaseError: If detach fails
        """
        try:
            sql = f"ALTER TABLE ledger_events DETACH PARTITION {partition_name};"
            
            logger.info(f"Detaching partition {partition_name}")
            self.db_session.execute(text(sql))
            self.db_session.commit()
            
            logger.info(f"Successfully detached partition {partition_name}")
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Failed to detach partition {partition_name}: {e}")
            raise DatabaseError(f"Partition detach failed: {e}") from e
    
    def archive_old_partitions(
        self, 
        months_to_keep: int = 12,
        dry_run: bool = False
    ) -> List[str]:
        """
        Archive partitions older than specified months.
        
        This method detaches old partitions from the parent table. The detached
        partitions should be backed up to cold storage before being dropped.
        
        Args:
            months_to_keep: Number of months of data to keep online (default: 12)
            dry_run: If True, only list partitions that would be archived
        
        Returns:
            List of partition names that were (or would be) archived
        
        Raises:
            DatabaseError: If archival fails
        """
        try:
            cutoff_date = datetime.utcnow() - timedelta(days=30 * months_to_keep)
            partitions = self.list_partitions()
            
            archived_partitions = []
            
            for partition_name, start_date, end_date in partitions:
                # Archive if partition end date is before cutoff
                if end_date < cutoff_date:
                    if dry_run:
                        logger.info(f"Would archive partition {partition_name} (ends {end_date.date()})")
                    else:
                        logger.info(f"Archiving partition {partition_name} (ends {end_date.date()})")
                        self.detach_partition(partition_name)
                    
                    archived_partitions.append(partition_name)
            
            if dry_run:
                logger.info(f"Dry run: {len(archived_partitions)} partitions would be archived")
            else:
                logger.info(f"Archived {len(archived_partitions)} partitions")
            
            return archived_partitions
            
        except Exception as e:
            logger.error(f"Failed to archive old partitions: {e}")
            raise DatabaseError(f"Partition archival failed: {e}") from e


def create_partition_maintenance_job(
    db_session: Session,
    check_interval_hours: int = 24,
    months_ahead: int = 3,
    months_to_keep: int = 12
):
    """
    Create a background job to maintain partitions automatically.
    
    This function should be run in a background thread or process.
    It periodically creates upcoming partitions and archives old ones.
    
    Args:
        db_session: SQLAlchemy database session
        check_interval_hours: Hours between maintenance checks (default: 24)
        months_ahead: Number of months ahead to create partitions (default: 3)
        months_to_keep: Number of months to keep online (default: 12)
    
    Example:
        >>> from caracal.db.connection import get_session
        >>> from caracal.db.partition_manager import create_partition_maintenance_job
        >>> import threading
        >>> 
        >>> session = get_session()
        >>> job = threading.Thread(
        ...     target=create_partition_maintenance_job,
        ...     args=(session, 24, 3, 12),
        ...     daemon=True
        ... )
        >>> job.start()
    """
    import time
    
    manager = PartitionManager(db_session)
    interval_seconds = check_interval_hours * 3600
    
    logger.info(f"Starting partition maintenance job (interval={check_interval_hours}h)")
    
    while True:
        try:
            # Create upcoming partitions
            logger.info("Running partition maintenance: creating upcoming partitions")
            manager.create_upcoming_partitions(months_ahead=months_ahead)
            
            # Archive old partitions (dry run first to log what would be archived)
            logger.info("Running partition maintenance: checking for old partitions")
            old_partitions = manager.archive_old_partitions(
                months_to_keep=months_to_keep,
                dry_run=True
            )
            
            if old_partitions:
                logger.warning(
                    f"Found {len(old_partitions)} old partitions ready for archival. "
                    f"Run 'caracal ledger archive-partitions' to archive them."
                )
            
            logger.info(f"Next partition maintenance in {check_interval_hours}h")
            time.sleep(interval_seconds)
            
        except KeyboardInterrupt:
            logger.info("Partition maintenance job stopped by user")
            break
            
        except Exception as e:
            logger.error(f"Error in partition maintenance job: {e}")
            # Continue running even if maintenance fails
            time.sleep(interval_seconds)
