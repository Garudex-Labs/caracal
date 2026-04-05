"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deployment architecture components for Caracal.

This package contains components for managing deployment modes, editions,
configuration, synchronization, and provider communication.
"""

from caracal.deployment.mode import Mode, ModeManager
from caracal.deployment.edition import Edition, EditionManager
from caracal.deployment.edition_adapter import (
    DeploymentEditionAdapter,
    get_deployment_edition_adapter,
)
from caracal.deployment.config_manager import (
    ConfigManager,
    WorkspaceConfig,
    PostgresConfig,
    SyncDirection,
    ConflictStrategy,
)
from caracal.deployment.migration import MigrationManager
from caracal.deployment.version import (
    VersionChecker,
    SemanticVersion,
    CompatibilityLevel,
    VersionCompatibility,
    get_version_checker,
)

__all__ = [
    "Mode",
    "ModeManager",
    "Edition",
    "EditionManager",
    "DeploymentEditionAdapter",
    "get_deployment_edition_adapter",
    "ConfigManager",
    "WorkspaceConfig",
    "PostgresConfig",
    "SyncDirection",
    "ConflictStrategy",
    "MigrationManager",
    "VersionChecker",
    "SemanticVersion",
    "CompatibilityLevel",
    "VersionCompatibility",
    "get_version_checker",
]


