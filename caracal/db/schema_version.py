"""
Schema version tracking for Caracal Core database.

This module provides utilities for checking and managing database schema versions.

Requirements: 19.1, 19.2, 19.7
"""

import logging
from typing import Optional

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)


class SchemaVersionManager:
    """
    Manages database schema versioning using Alembic.
    
    Provides utilities for checking current schema version,
    detecting pending migrations, and validating schema state.
    """
    
    def __init__(self, engine: Engine, alembic_ini_path: str = "alembic.ini"):
        """
        Initialize schema version manager.
        
        Args:
            engine: SQLAlchemy engine
            alembic_ini_path: Path to alembic.ini configuration file
        """
        self.engine = engine
        self.alembic_config = Config(alembic_ini_path)
    
    def get_current_revision(self) -> Optional[str]:
        """
        Get current database schema revision.
        
        Returns:
            Current revision ID or None if no migrations applied
        """
        with self.engine.connect() as connection:
            context = MigrationContext.configure(connection)
            current_rev = context.get_current_revision()
            return current_rev
    
    def get_head_revision(self) -> str:
        """
        Get the latest available migration revision.
        
        Returns:
            Head revision ID from migration scripts
        """
        script = ScriptDirectory.from_config(self.alembic_config)
        head_rev = script.get_current_head()
        return head_rev
    
    def is_up_to_date(self) -> bool:
        """
        Check if database schema is up to date.
        
        Returns:
            True if current revision matches head revision, False otherwise
        """
        current = self.get_current_revision()
        head = self.get_head_revision()
        
        if current is None:
            logger.warning("No migrations applied to database")
            return False
        
        is_current = current == head
        if not is_current:
            logger.warning(
                f"Database schema is outdated: current={current}, head={head}"
            )
        
        return is_current
    
    def get_pending_migrations(self) -> list:
        """
        Get list of pending migrations that need to be applied.
        
        Returns:
            List of pending migration revision IDs
        """
        script = ScriptDirectory.from_config(self.alembic_config)
        current = self.get_current_revision()
        head = self.get_head_revision()
        
        if current == head:
            return []
        
        # Get all revisions between current and head
        pending = []
        for rev in script.iterate_revisions(head, current):
            if rev.revision != current:
                pending.append(rev.revision)
        
        return list(reversed(pending))
    
    def check_schema_version(self, fail_on_outdated: bool = True) -> bool:
        """
        Check database schema version and optionally fail if outdated.
        
        Args:
            fail_on_outdated: If True, raise exception when schema is outdated
        
        Returns:
            True if schema is up to date, False otherwise
        
        Raises:
            RuntimeError: If schema is outdated and fail_on_outdated is True
        """
        is_current = self.is_up_to_date()
        
        if not is_current and fail_on_outdated:
            current = self.get_current_revision()
            head = self.get_head_revision()
            pending = self.get_pending_migrations()
            
            error_msg = (
                f"Database schema is outdated!\n"
                f"Current revision: {current}\n"
                f"Head revision: {head}\n"
                f"Pending migrations: {len(pending)}\n"
                f"Run 'alembic upgrade head' to apply pending migrations."
            )
            raise RuntimeError(error_msg)
        
        return is_current
    
    def upgrade_to_head(self) -> None:
        """
        Upgrade database schema to the latest version.
        
        Applies all pending migrations to bring database to head revision.
        """
        logger.info("Upgrading database schema to head revision")
        command.upgrade(self.alembic_config, "head")
        logger.info("Database schema upgraded successfully")
    
    def downgrade_to_base(self) -> None:
        """
        Downgrade database schema to base (remove all migrations).
        
        WARNING: This will drop all tables and data!
        """
        logger.warning("Downgrading database schema to base (all data will be lost)")
        command.downgrade(self.alembic_config, "base")
        logger.info("Database schema downgraded to base")
    
    def get_schema_info(self) -> dict:
        """
        Get comprehensive schema version information.
        
        Returns:
            Dictionary with schema version details:
            - current_revision: Current database revision
            - head_revision: Latest available revision
            - is_up_to_date: Whether schema is current
            - pending_migrations: List of pending migration IDs
        """
        current = self.get_current_revision()
        head = self.get_head_revision()
        is_current = current == head
        pending = self.get_pending_migrations() if not is_current else []
        
        return {
            "current_revision": current,
            "head_revision": head,
            "is_up_to_date": is_current,
            "pending_migrations": pending,
        }


def check_schema_version_on_startup(engine: Engine, alembic_ini_path: str = "alembic.ini") -> None:
    """
    Check schema version on application startup.
    
    Validates that database schema is up to date and fails startup if not.
    This ensures the application doesn't run with an outdated schema.
    
    Args:
        engine: SQLAlchemy engine
        alembic_ini_path: Path to alembic.ini configuration file
    
    Raises:
        RuntimeError: If schema is outdated
    """
    manager = SchemaVersionManager(engine, alembic_ini_path)
    manager.check_schema_version(fail_on_outdated=True)
    logger.info("Database schema version check passed")
