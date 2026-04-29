"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

UTC datetime helper that returns naive UTC for compatibility with current
SQLAlchemy column mappings; will be switched to timezone-aware once all
TIMESTAMP columns are migrated to TIMESTAMPTZ and the SA model column types,
test fixtures, and downstream comparisons are updated in lock-step.
"""

from datetime import datetime


def now_utc() -> datetime:
    """Return the current UTC time as a naive datetime."""
    return datetime.utcnow()
