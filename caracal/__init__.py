"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Core - Pre-Execution Authority Enforcement System

Caracal Core provides execution authority, mandate management, delegation,
policy enforcement, and audit capabilities for principals (humans, orchestrators,
workers, and services).
"""

from pathlib import Path
import sys

# Enable in-repo imports for relocated SDK package during local development.
_sdk_src = Path(__file__).resolve().parent.parent / "sdk" / "python-sdk" / "src"
if _sdk_src.exists():
    sdk_path = str(_sdk_src)
    if sdk_path not in sys.path:
        sys.path.insert(0, sdk_path)

from caracal._version import __version__

__all__ = ["__version__"]
