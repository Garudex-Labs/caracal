"""
Database module for Caracal Core v0.2.

This module provides PostgreSQL database models and connection management.
"""

from caracal.db.connection import (
    DatabaseConfig,
    DatabaseConnectionManager,
    close_connection_manager,
    get_connection_manager,
    initialize_connection_manager,
)
from caracal.db.models import (
    Base,
    LedgerEvent,
    Principal,
    ExecutionMandate,
    AuthorityLedgerEvent,
    AuthorityPolicy,
)
from caracal.db.schema_version import (
    SchemaVersionManager,
    check_schema_version_on_startup,
)

__all__ = [
    # Models
    "Base",
    "LedgerEvent",
    "Principal",
    "ExecutionMandate",
    "AuthorityLedgerEvent",
    "AuthorityPolicy",
    # Connection management
    "DatabaseConfig",
    "DatabaseConnectionManager",
    "get_connection_manager",
    "initialize_connection_manager",
    "close_connection_manager",
    # Schema version management
    "SchemaVersionManager",
    "check_schema_version_on_startup",
]
