"""Compatibility helpers for standalone and in-repo SDK usage."""

from __future__ import annotations

import logging


def get_logger(name: str) -> logging.Logger:
    """Return Caracal logger when available, else stdlib logger."""
    try:
        from caracal.logging_config import get_logger as core_get_logger

        return core_get_logger(name)
    except Exception:
        return logging.getLogger(name)


def get_version() -> str:
    """Resolve version from core when available, else SDK fallback."""
    try:
        from caracal._version import get_version as core_get_version

        return core_get_version()
    except Exception:
        return "0.1.0"


class SDKConfigurationError(Exception):
    """Raised when SDK configuration is invalid."""


class ConnectionError(Exception):
    """Raised when SDK cannot connect to Caracal APIs."""


class AuthorityDeniedError(Exception):
    """Raised when mandate validation fails and execution must be denied."""


try:
    from caracal.exceptions import (  # type: ignore
        SDKConfigurationError as CoreSDKConfigurationError,
        ConnectionError as CoreConnectionError,
        AuthorityDeniedError as CoreAuthorityDeniedError,
    )
except ImportError:
    pass
else:
    SDKConfigurationError = CoreSDKConfigurationError
    ConnectionError = CoreConnectionError
    AuthorityDeniedError = CoreAuthorityDeniedError
