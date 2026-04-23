"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Shared date/time string parsing for CLI, Flow, and other callers.
"""

from __future__ import annotations

from datetime import datetime


def parse_datetime(date_str: str) -> datetime:
    """
    Parse datetime string in various formats.

    Supports:
    - ISO 8601: 2024-01-15T10:30:00Z
    - Date only: 2024-01-15 (assumes 00:00:00)
    - Date and time: 2024-01-15 10:30:00

    Args:
        date_str: Date/time string to parse

    Returns:
        datetime object

    Raises:
        ValueError: If date string cannot be parsed
    """
    for fmt in [
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue

    raise ValueError(
        f"Invalid date format: {date_str}. "
        f"Expected formats: YYYY-MM-DD, YYYY-MM-DD HH:MM:SS, or ISO 8601"
    )
