"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Version information for Caracal Core.

This module reads the version from the VERSION file at the root of the package.
"""

from pathlib import Path

def get_version() -> str:
    """
    Read version from VERSION file.
    
    Returns:
        str: The version string (e.g., "1.0.0")
    """
    version_file = Path(__file__).parent.parent / "VERSION"
    if version_file.exists():
        return version_file.read_text().strip()
    return "unknown"

__version__ = get_version()
