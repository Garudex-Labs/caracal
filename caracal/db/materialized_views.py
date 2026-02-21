"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Materialized view management for Caracal Core v0.3.

This module provides functionality to refresh materialized views used for
optimized ledger queries. Views are refreshed concurrently to avoid blocking
reads during refresh operations.

"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from caracal.exceptions import DatabaseError

logger = logging.getLogger(__name__)


class MaterializedViewManager:
    """
    Manager for PostgreSQL materialized views.
    
    Provides methods to refresh materialized views used for ledger query
    optimization. Supports concurrent refresh to avoid blocking reads.
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize materialized view manager.
        
        Args:
            db_session: SQLAlchemy database session
        """
        self.db_session = db_session
    
    def refresh_usage_by_agent(self, concurrent: bool = True) -> None:
        """
        Refresh the usage_by_agent_mv materialized view.
        
        This view aggregates total usage per agent.
        
        Args:
            concurrent: If True, use CONCURRENTLY to avoid blocking reads
                       (requires unique index on view)
        
        Raises:
            DatabaseError: If refresh fails
        """
        try:
            refresh_mode = "CONCURRENTLY" if concurrent else ""
            sql = f"REFRESH MATERIALIZED VIEW {refresh_mode} usage_by_agent_mv"
            
            logger.info(f"Refreshing usage_by_agent_mv (concurrent={concurrent})")
            start_time = datetime.utcnow()
            
            self.db_session.execute(text(sql))
            self.db_session.commit()
            
            duration = (datetime.utcnow() - start_time).total_seconds()
            logger.info(f"Refreshed usage_by_agent_mv in {duration:.2f}s")
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Failed to refresh usage_by_agent_mv: {e}")
            raise DatabaseError(f"Materialized view refresh failed: {e}") from e
    
    def refresh_usage_by_time_window(self, concurrent: bool = True) -> None:
        """
        Refresh the usage_by_time_window_mv materialized view.
        
        This view aggregates usage by various time windows (hourly, daily,
        weekly, monthly) for both rolling and calendar windows.
        
        Args:
            concurrent: If True, use CONCURRENTLY to avoid blocking reads
                       (requires unique index on view)
        
        Raises:
            DatabaseError: If refresh fails
        """
        try:
            refresh_mode = "CONCURRENTLY" if concurrent else ""
            sql = f"REFRESH MATERIALIZED VIEW {refresh_mode} usage_by_time_window_mv"
            
            logger.info(f"Refreshing usage_by_time_window_mv (concurrent={concurrent})")
            start_time = datetime.utcnow()
            
            self.db_session.execute(text(sql))
            self.db_session.commit()
            
            duration = (datetime.utcnow() - start_time).total_seconds()
            logger.info(f"Refreshed usage_by_time_window_mv in {duration:.2f}s")
            
        except Exception as e:
            self.db_session.rollback()
            logger.error(f"Failed to refresh usage_by_time_window_mv: {e}")
            raise DatabaseError(f"Materialized view refresh failed: {e}") from e
    
    def refresh_all(self, concurrent: bool = True) -> None:
        """
        Refresh all materialized views.
        
        Args:
            concurrent: If True, use CONCURRENTLY to avoid blocking reads
        
        Raises:
            DatabaseError: If any refresh fails
        """
        logger.info("Refreshing all materialized views")
        start_time = datetime.utcnow()
        
        self.refresh_usage_by_agent(concurrent=concurrent)
        self.refresh_usage_by_time_window(concurrent=concurrent)
        
        duration = (datetime.utcnow() - start_time).total_seconds()
        logger.info(f"Refreshed all materialized views in {duration:.2f}s")
    
    def get_view_refresh_time(self, view_name: str) -> Optional[datetime]:
        """
        Get the last refresh time for a materialized view.
        
        Args:
            view_name: Name of the materialized view
        
        Returns:
            Last refresh timestamp, or None if view doesn't exist or has no data
        """
        try:
            sql = text(f"SELECT refreshed_at FROM {view_name} LIMIT 1")
            result = self.db_session.execute(sql).fetchone()
            
            if result:
                return result[0]
            return None
            
        except Exception as e:
            logger.warning(f"Failed to get refresh time for {view_name}: {e}")
            return None


def create_refresh_scheduler(db_session: Session, interval_seconds: int = 300):
    """
    Create a background scheduler to refresh materialized views periodically.
    
    This function is intended to be run in a background thread or process.
    The default refresh interval is 5 minutes (300 seconds).
    
    Args:
        db_session: SQLAlchemy database session
        interval_seconds: Refresh interval in seconds (default: 300 = 5 minutes)
    
    Example:
        >>> from caracal.db.connection import get_session
        >>> from caracal.db.materialized_views import create_refresh_scheduler
        >>> import threading
        >>> 
        >>> session = get_session()
        >>> scheduler = threading.Thread(
        ...     target=create_refresh_scheduler,
        ...     args=(session, 300),
        ...     daemon=True
        ... )
        >>> scheduler.start()
    """
    import time
    
    manager = MaterializedViewManager(db_session)
    
    logger.info(f"Starting materialized view refresh scheduler (interval={interval_seconds}s)")
    
    while True:
        try:
            manager.refresh_all(concurrent=True)
            logger.info(f"Next refresh in {interval_seconds}s")
            time.sleep(interval_seconds)
            
        except KeyboardInterrupt:
            logger.info("Refresh scheduler stopped by user")
            break
            
        except Exception as e:
            logger.error(f"Error in refresh scheduler: {e}")
            # Continue running even if refresh fails
            time.sleep(interval_seconds)
