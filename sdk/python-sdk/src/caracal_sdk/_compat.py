"""SDK compatibility facade bound to canonical Caracal runtime contracts."""

from __future__ import annotations

from caracal._version import get_version as core_get_version
from caracal.exceptions import AuthorityDeniedError, ConnectionError, SDKConfigurationError
from caracal.logging_config import get_logger as core_get_logger


def get_logger(name: str):
    """Return the canonical Caracal logger."""
    return core_get_logger(name)


def get_version() -> str:
    """Resolve version from canonical Caracal runtime package metadata."""
    return core_get_version()
