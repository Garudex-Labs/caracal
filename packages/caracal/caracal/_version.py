"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Version information for Caracal Core.

The resolver supports both source-tree and installed/container layouts.
"""

from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path


def get_version() -> str:
    """Resolve Caracal version from package metadata or VERSION file."""
    # Installed distributions should resolve from metadata first.
    for distribution_name in ("caracal-core", "caracal"):
        try:
            resolved = package_version(distribution_name).strip()
            if resolved:
                return resolved
        except PackageNotFoundError:
            continue

    # Source-tree fallback when running directly from checkout.
    candidate_paths = (
        Path(__file__).resolve().parent.parent / "VERSION",
        Path.cwd() / "VERSION",
    )
    for version_file in candidate_paths:
        try:
            if version_file.exists():
                resolved = version_file.read_text().strip()
                if resolved:
                    return resolved
        except OSError:
            continue

    return "unknown"


__version__ = get_version()
