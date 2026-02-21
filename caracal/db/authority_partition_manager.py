"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Partition management for authority_ledger_events table.

Provides automatic monthly partitioning for authority ledger events
to improve query performance and enable efficient data archival.

"""

from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthorityLedgerPartitionManager:
    """
    Manages table partitioning for authority_ledger_events.
    
    Implements:
    - Monthly partitioning by timestamp
    - Automatic partition creation
    - Partition maintenance (cleanup old partitions)
    - Partition listing and status
    
    """
    
    # Table name
    TABLE_NAME = "authority_ledger_events"
    
    # Partition retention (months)
    DEFAULT_RETENTION_MONTHS = 12
    
    def __init__(self, db_session: Session):
        """
        Initialize partition manager.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
        logger.info("AuthorityLedgerPartitionManager initialized")
    
    def _get_partition_name(self, year: int, month: int) -> str:
        """
        Get partition name for year and month.
        
        Args:
            year: Year (e.g., 2024)
            month: Month (1-12)
        
        Returns:
            Partition name (e.g., "authority_ledger_events_2024_01")
        """
        return f"{self.TABLE_NAME}_{year:04d}_{month:02d}"
    
    def _get_partition_bounds(self, year: int, month: int) -> tuple[str, str]:
        """
        Get partition bounds for year and month.
        
        Args:
            year: Year (e.g., 2024)
            month: Month (1-12)
        
        Returns:
            Tuple of (start_date, end_date) as ISO format strings
        """
        start_date = datetime(year, month, 1)
        
        # Calculate end date (first day of next month)
        if month == 12:
            end_date = datetime(year + 1, 1, 1)
        else:
            end_date = datetime(year, month + 1, 1)
        
        return (start_date.isoformat(), end_date.isoformat())
    
    def create_partition(self, year: int, month: int) -> bool:
        """
        Create partition for specified year and month.
        
        Creates a range partition on the timestamp column.
        
        Args:
            year: Year (e.g., 2024)
            month: Month (1-12)
        
        Returns:
            True if partition created successfully, False otherwise
        
        """
        partition_name = self._get_partition_name(year, month)
        start_date, end_date = self._get_partition_bounds(year, month)
        
        try:
            # Check if partition already exists
            check_sql = text("""
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = :partition_name
                    AND n.nspname = 'public'
                )
            """)
            
            result = self.db_session.execute(
                check_sql,
                {"partition_name": partition_name}
            )
            exists = result.scalar()
            
            if exists:
                logger.info(f"Partition {partition_name} already exists")
                return True
            
            # Create partition
            create_sql = text(f"""
                CREATE TABLE IF NOT EXISTS {partition_name}
                PARTITION OF {self.TABLE_NAME}
                FOR VALUES FROM ('{start_date}') TO ('{end_date}')
            """)
            
            self.db_session.execute(create_sql)
            self.db_session.commit()
            
            logger.info(
                f"Created partition {partition_name} for range "
                f"[{start_date}, {end_date})"
            )
            return True
        
        except Exception as e:
            logger.error(
                f"Failed to create partition {partition_name}: {e}",
                exc_info=True
            )
            self.db_session.rollback()
            return False
    
    def create_partitions_for_range(
        self,
        start_year: int,
        start_month: int,
        end_year: int,
        end_month: int
    ) -> int:
        """
        Create partitions for a range of months.
        
        Args:
            start_year: Start year
            start_month: Start month (1-12)
            end_year: End year
            end_month: End month (1-12)
        
        Returns:
            Number of partitions created
        
        """
        created_count = 0
        current_date = datetime(start_year, start_month, 1)
        end_date = datetime(end_year, end_month, 1)
        
        while current_date <= end_date:
            if self.create_partition(current_date.year, current_date.month):
                created_count += 1
            
            # Move to next month
            if current_date.month == 12:
                current_date = datetime(current_date.year + 1, 1, 1)
            else:
                current_date = datetime(current_date.year, current_date.month + 1, 1)
        
        logger.info(f"Created {created_count} partitions for range")
        return created_count
    
    def create_future_partitions(self, months_ahead: int = 3) -> int:
        """
        Create partitions for future months.
        
        Ensures partitions exist for upcoming months to avoid
        insert failures when events are created.
        
        Args:
            months_ahead: Number of months to create partitions for
        
        Returns:
            Number of partitions created
        
        """
        current_date = datetime.utcnow()
        created_count = 0
        
        for i in range(months_ahead + 1):  # +1 to include current month
            target_date = current_date + timedelta(days=30 * i)
            if self.create_partition(target_date.year, target_date.month):
                created_count += 1
        
        logger.info(f"Created {created_count} future partitions")
        return created_count
    
    def list_partitions(self) -> List[dict]:
        """
        List all partitions for authority_ledger_events table.
        
        Returns:
            List of dictionaries with partition information:
            - name: Partition name
            - start_date: Partition start date
            - end_date: Partition end date
            - size_bytes: Partition size in bytes
            - row_count: Approximate row count
        
        """
        try:
            list_sql = text("""
                SELECT
                    c.relname AS partition_name,
                    pg_get_expr(c.relpartbound, c.oid) AS partition_bounds,
                    pg_total_relation_size(c.oid) AS size_bytes,
                    c.reltuples::bigint AS row_count
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = :table_name
                ORDER BY c.relname
            """)
            
            result = self.db_session.execute(
                list_sql,
                {"table_name": self.TABLE_NAME}
            )
            
            partitions = []
            for row in result:
                partitions.append({
                    "name": row.partition_name,
                    "bounds": row.partition_bounds,
                    "size_bytes": row.size_bytes,
                    "row_count": row.row_count
                })
            
            logger.debug(f"Found {len(partitions)} partitions")
            return partitions
        
        except Exception as e:
            logger.error(f"Failed to list partitions: {e}", exc_info=True)
            return []
    
    def drop_old_partitions(
        self,
        retention_months: int = DEFAULT_RETENTION_MONTHS
    ) -> int:
        """
        Drop partitions older than retention period.
        
        Useful for data archival and storage management.
        
        Args:
            retention_months: Number of months to retain
        
        Returns:
            Number of partitions dropped
        
        """
        try:
            current_date = datetime.utcnow()
            cutoff_date = current_date - timedelta(days=30 * retention_months)
            
            dropped_count = 0
            partitions = self.list_partitions()
            
            for partition in partitions:
                # Extract year and month from partition name
                # Format: authority_ledger_events_YYYY_MM
                parts = partition["name"].split("_")
                if len(parts) >= 5:
                    try:
                        year = int(parts[-2])
                        month = int(parts[-1])
                        partition_date = datetime(year, month, 1)
                        
                        if partition_date < cutoff_date:
                            # Drop partition
                            drop_sql = text(f"DROP TABLE IF EXISTS {partition['name']}")
                            self.db_session.execute(drop_sql)
                            self.db_session.commit()
                            
                            logger.info(f"Dropped old partition {partition['name']}")
                            dropped_count += 1
                    except (ValueError, IndexError) as e:
                        logger.warning(f"Failed to parse partition name {partition['name']}: {e}")
            
            logger.info(f"Dropped {dropped_count} old partitions")
            return dropped_count
        
        except Exception as e:
            logger.error(f"Failed to drop old partitions: {e}", exc_info=True)
            self.db_session.rollback()
            return 0
    
    def get_partition_statistics(self) -> dict:
        """
        Get statistics about partitions.
        
        Returns:
            Dictionary with partition statistics:
            - total_partitions: Total number of partitions
            - total_size_bytes: Total size of all partitions
            - total_rows: Total approximate row count
            - oldest_partition: Name of oldest partition
            - newest_partition: Name of newest partition
        
        """
        try:
            partitions = self.list_partitions()
            
            if not partitions:
                return {
                    "total_partitions": 0,
                    "total_size_bytes": 0,
                    "total_rows": 0,
                    "oldest_partition": None,
                    "newest_partition": None
                }
            
            total_size = sum(p["size_bytes"] for p in partitions)
            total_rows = sum(p["row_count"] for p in partitions)
            
            return {
                "total_partitions": len(partitions),
                "total_size_bytes": total_size,
                "total_rows": total_rows,
                "oldest_partition": partitions[0]["name"] if partitions else None,
                "newest_partition": partitions[-1]["name"] if partitions else None
            }
        
        except Exception as e:
            logger.error(f"Failed to get partition statistics: {e}", exc_info=True)
            return {
                "total_partitions": 0,
                "total_size_bytes": 0,
                "total_rows": 0,
                "oldest_partition": None,
                "newest_partition": None
            }
    
    def ensure_current_partition_exists(self) -> bool:
        """
        Ensure partition exists for current month.
        
        Should be called before inserting events to avoid failures.
        
        Returns:
            True if partition exists or was created, False otherwise
        
        """
        current_date = datetime.utcnow()
        return self.create_partition(current_date.year, current_date.month)
    
    def initialize_partitioning(self) -> bool:
        """
        Initialize partitioning for authority_ledger_events table.
        
        Converts existing table to partitioned table if needed,
        and creates initial partitions.
        
        Returns:
            True if initialization successful, False otherwise
        
        """
        try:
            # Check if table is already partitioned
            check_sql = text("""
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = :table_name
                    AND n.nspname = 'public'
                    AND c.relkind = 'p'
                )
            """)
            
            result = self.db_session.execute(
                check_sql,
                {"table_name": self.TABLE_NAME}
            )
            is_partitioned = result.scalar()
            
            if is_partitioned:
                logger.info(f"Table {self.TABLE_NAME} is already partitioned")
            else:
                logger.warning(
                    f"Table {self.TABLE_NAME} is not partitioned. "
                    f"Manual migration required to convert to partitioned table."
                )
                return False
            
            # Create partitions for current month and next 3 months
            created_count = self.create_future_partitions(months_ahead=3)
            
            logger.info(
                f"Partitioning initialized: created {created_count} partitions"
            )
            return True
        
        except Exception as e:
            logger.error(f"Failed to initialize partitioning: {e}", exc_info=True)
            return False
