#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

"""
Script to convert authority_ledger_events table to partitioned table.

This script performs the following steps:
1. Creates a new partitioned table
2. Creates partitions for historical and future data
3. Migrates existing data to partitions
4. Swaps old table with new partitioned table

"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text

from caracal.db.connection import DatabaseConnectionManager, get_db_manager
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def create_partitioned_table(db_manager: DatabaseConnectionManager) -> bool:
    """
    Create new partitioned authority_ledger_events table.
    
    Args:
        db_manager: Database connection manager
    
    Returns:
        True if successful, False otherwise
    """
    try:
        with db_manager.session_scope() as session:
            # Create partitioned table
            create_sql = text("""
                CREATE TABLE IF NOT EXISTS authority_ledger_events_partitioned (
                    event_id BIGSERIAL,
                    event_type VARCHAR(50) NOT NULL,
                    timestamp TIMESTAMP NOT NULL,
                    principal_id UUID NOT NULL,
                    mandate_id UUID,
                    decision VARCHAR(20),
                    denial_reason VARCHAR(1000),
                    requested_action VARCHAR(255),
                    requested_resource VARCHAR(1000),
                    event_metadata JSONB,
                    correlation_id VARCHAR(255),
                    merkle_root_id UUID,
                    PRIMARY KEY (event_id, timestamp)
                ) PARTITION BY RANGE (timestamp);
                
                -- Create indexes on partitioned table
                CREATE INDEX IF NOT EXISTS idx_ale_part_event_type 
                    ON authority_ledger_events_partitioned (event_type);
                CREATE INDEX IF NOT EXISTS idx_ale_part_timestamp 
                    ON authority_ledger_events_partitioned (timestamp);
                CREATE INDEX IF NOT EXISTS idx_ale_part_principal_id 
                    ON authority_ledger_events_partitioned (principal_id);
                CREATE INDEX IF NOT EXISTS idx_ale_part_mandate_id 
                    ON authority_ledger_events_partitioned (mandate_id);
                CREATE INDEX IF NOT EXISTS idx_ale_part_correlation_id 
                    ON authority_ledger_events_partitioned (correlation_id);
                CREATE INDEX IF NOT EXISTS idx_ale_part_merkle_root_id 
                    ON authority_ledger_events_partitioned (merkle_root_id);
            """)
            
            session.execute(create_sql)
            session.commit()
            
            logger.info("Created partitioned authority_ledger_events table")
            return True
    
    except Exception as e:
        logger.error(f"Failed to create partitioned table: {e}", exc_info=True)
        return False


def create_partitions(db_manager: DatabaseConnectionManager, months_back: int = 12, months_ahead: int = 3) -> bool:
    """
    Create partitions for historical and future data.
    
    Args:
        db_manager: Database connection manager
        months_back: Number of months of historical data to partition
        months_ahead: Number of future months to partition
    
    Returns:
        True if successful, False otherwise
    """
    try:
        with db_manager.session_scope() as session:
            current_date = datetime.utcnow()
            
            # Create partitions for past months
            for i in range(months_back, 0, -1):
                target_date = current_date - timedelta(days=30 * i)
                year = target_date.year
                month = target_date.month
                
                partition_name = f"authority_ledger_events_{year:04d}_{month:02d}"
                start_date = datetime(year, month, 1)
                
                if month == 12:
                    end_date = datetime(year + 1, 1, 1)
                else:
                    end_date = datetime(year, month + 1, 1)
                
                create_partition_sql = text(f"""
                    CREATE TABLE IF NOT EXISTS {partition_name}
                    PARTITION OF authority_ledger_events_partitioned
                    FOR VALUES FROM ('{start_date.isoformat()}') TO ('{end_date.isoformat()}')
                """)
                
                session.execute(create_partition_sql)
                logger.info(f"Created partition {partition_name}")
            
            # Create partitions for current and future months
            for i in range(months_ahead + 1):
                target_date = current_date + timedelta(days=30 * i)
                year = target_date.year
                month = target_date.month
                
                partition_name = f"authority_ledger_events_{year:04d}_{month:02d}"
                start_date = datetime(year, month, 1)
                
                if month == 12:
                    end_date = datetime(year + 1, 1, 1)
                else:
                    end_date = datetime(year, month + 1, 1)
                
                create_partition_sql = text(f"""
                    CREATE TABLE IF NOT EXISTS {partition_name}
                    PARTITION OF authority_ledger_events_partitioned
                    FOR VALUES FROM ('{start_date.isoformat()}') TO ('{end_date.isoformat()}')
                """)
                
                session.execute(create_partition_sql)
                logger.info(f"Created partition {partition_name}")
            
            session.commit()
            logger.info("Created all partitions")
            return True
    
    except Exception as e:
        logger.error(f"Failed to create partitions: {e}", exc_info=True)
        return False


def migrate_data(db_manager: DatabaseConnectionManager) -> bool:
    """
    Migrate existing data to partitioned table.
    
    Args:
        db_manager: Database connection manager
    
    Returns:
        True if successful, False otherwise
    """
    try:
        with db_manager.session_scope() as session:
            # Check if old table exists
            check_sql = text("""
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = 'authority_ledger_events'
                    AND n.nspname = 'public'
                    AND c.relkind = 'r'
                )
            """)
            
            result = session.execute(check_sql)
            old_table_exists = result.scalar()
            
            if not old_table_exists:
                logger.info("No existing authority_ledger_events table to migrate")
                return True
            
            # Copy data from old table to partitioned table
            migrate_sql = text("""
                INSERT INTO authority_ledger_events_partitioned
                SELECT * FROM authority_ledger_events
                ON CONFLICT DO NOTHING
            """)
            
            session.execute(migrate_sql)
            session.commit()
            
            logger.info("Migrated data to partitioned table")
            return True
    
    except Exception as e:
        logger.error(f"Failed to migrate data: {e}", exc_info=True)
        return False


def swap_tables(db_manager: DatabaseConnectionManager) -> bool:
    """
    Swap old table with new partitioned table.
    
    Args:
        db_manager: Database connection manager
    
    Returns:
        True if successful, False otherwise
    """
    try:
        with db_manager.session_scope() as session:
            # Rename old table
            rename_old_sql = text("""
                ALTER TABLE IF EXISTS authority_ledger_events
                RENAME TO authority_ledger_events_old
            """)
            session.execute(rename_old_sql)
            
            # Rename partitioned table to original name
            rename_new_sql = text("""
                ALTER TABLE authority_ledger_events_partitioned
                RENAME TO authority_ledger_events
            """)
            session.execute(rename_new_sql)
            
            session.commit()
            
            logger.info("Swapped tables successfully")
            logger.info("Old table renamed to authority_ledger_events_old")
            logger.info("You can drop the old table after verifying the migration")
            return True
    
    except Exception as e:
        logger.error(f"Failed to swap tables: {e}", exc_info=True)
        return False


def main():
    """Main function to run partitioning migration."""
    logger.info("Starting authority_ledger_events partitioning migration")
    
    # Initialize database connection
    try:
        db_manager = get_db_manager()
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}", exc_info=True)
        return 1
    
    try:
        # Step 1: Create partitioned table
        logger.info("Step 1: Creating partitioned table")
        if not create_partitioned_table(db_manager):
            logger.error("Failed to create partitioned table")
            return 1
        
        # Step 2: Create partitions
        logger.info("Step 2: Creating partitions")
        if not create_partitions(db_manager, months_back=12, months_ahead=3):
            logger.error("Failed to create partitions")
            return 1
        
        # Step 3: Migrate data
        logger.info("Step 3: Migrating data")
        if not migrate_data(db_manager):
            logger.error("Failed to migrate data")
            return 1
        
        # Step 4: Swap tables
        logger.info("Step 4: Swapping tables")
        if not swap_tables(db_manager):
            logger.error("Failed to swap tables")
            return 1
        
        logger.info("Partitioning migration completed successfully!")
        logger.info("To drop the old table, run: DROP TABLE authority_ledger_events_old;")
        return 0
    
    finally:
        db_manager.close()


if __name__ == "__main__":
    sys.exit(main())
