"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Internal SDK helpers: version resolution, logging, and SDK exception types.
This module is the single source of truth for these primitives inside the
SDK and must never import from the Caracal server packages.
"""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path


class CaracalSDKError(Exception):
    """Root of the SDK exception hierarchy."""


class SDKConfigurationError(CaracalSDKError):
    """Raised when SDK configuration is invalid."""


class ConnectionError(CaracalSDKError):
    """Raised when the SDK cannot reach the Caracal API."""


class AuthorityDeniedError(CaracalSDKError):
    """Raised when authority validation fails and the action is denied."""


def get_logger(name: str) -> logging.Logger:
    """Return a stdlib logger namespaced under the SDK."""
    return logging.getLogger(f"caracal_sdk.{name}")


def get_version() -> str:
    """Resolve the installed `caracal-sdk` distribution version."""
    try:
        resolved = package_version("caracal-sdk").strip()
        if resolved:
            return resolved
    except PackageNotFoundError:
        pass

    version_file = Path(__file__).resolve().parent.parent.parent / "VERSION"
    try:
        if version_file.exists():
            resolved = version_file.read_text().strip()
            if resolved:
                return resolved
    except OSError:
        pass

    return "unknown"
