"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Exception hierarchy for deployment architecture components.

All deployment-related exceptions inherit from DeploymentError base class.
"""

from caracal.exceptions import CaracalError


class DeploymentError(CaracalError):
    """Base exception for all deployment-related errors."""
    pass


# Mode Management Errors
class ModeError(DeploymentError):
    """Base exception for mode-related errors."""
    pass


class InvalidModeError(ModeError):
    """Raised when an invalid mode is specified."""
    pass


class ModeConfigurationError(ModeError):
    """Raised when mode configuration is invalid or cannot be loaded."""
    pass


class ModeDetectionError(ModeError):
    """Raised when mode detection fails."""
    pass


# Edition Management Errors
class EditionError(DeploymentError):
    """Base exception for edition-related errors."""
    pass


class InvalidEditionError(EditionError):
    """Raised when an invalid edition is specified."""
    pass


class EditionConfigurationError(EditionError):
    """Raised when edition configuration is invalid or cannot be loaded."""
    pass


class EditionDetectionError(EditionError):
    """Raised when edition detection fails."""
    pass


# Configuration Management Errors
class ConfigurationError(DeploymentError):
    """Base exception for configuration-related errors."""
    pass


class ConfigurationNotFoundError(ConfigurationError):
    """Raised when configuration file is not found."""
    pass


class ConfigurationCorruptedError(ConfigurationError):
    """Raised when configuration file is corrupted."""
    pass


class ConfigurationValidationError(ConfigurationError):
    """Raised when configuration validation fails."""
    pass


class WorkspaceError(ConfigurationError):
    """Base exception for workspace-related errors."""
    pass


class WorkspaceNotFoundError(WorkspaceError):
    """Raised when a workspace is not found."""
    pass


class WorkspaceAlreadyExistsError(WorkspaceError):
    """Raised when attempting to create a workspace that already exists."""
    pass


class InvalidWorkspaceNameError(WorkspaceError):
    """Raised when a workspace name is invalid."""
    pass


class WorkspaceOperationError(WorkspaceError):
    """Raised when a workspace operation fails."""
    pass


# Encryption and Security Errors
class EncryptionError(DeploymentError):
    """Base exception for encryption-related errors."""
    pass


class EncryptionKeyError(EncryptionError):
    """Raised when encryption key operations fail."""
    pass


class DecryptionError(EncryptionError):
    """Raised when decryption fails."""
    pass


class SecretNotFoundError(EncryptionError):
    """Raised when a secret is not found in the vault."""
    pass


# Synchronization Errors
class SyncError(DeploymentError):
    """Base exception for synchronization-related errors."""
    pass


class SyncConnectionError(SyncError):
    """Raised when sync connection fails."""
    pass


class SyncOperationError(SyncError):
    """Raised when a sync operation fails."""
    pass


class SyncConflictError(SyncError):
    """Raised when a sync conflict cannot be resolved."""
    pass


class SyncStateError(SyncError):
    """Raised when sync state is invalid or corrupted."""
    pass


class NetworkError(SyncError):
    """Raised when network operations fail."""
    pass


class OfflineError(SyncError):
    """Raised when an operation requires network connectivity but is offline."""
    pass


# Provider Communication Errors
class ProviderError(DeploymentError):
    """Base exception for provider-related errors."""
    pass


class ProviderNotFoundError(ProviderError):
    """Raised when a provider is not found."""
    pass


class ProviderConfigurationError(ProviderError):
    """Raised when provider configuration is invalid."""
    pass


class ProviderConnectionError(ProviderError):
    """Raised when provider connection fails."""
    pass


class ProviderAuthenticationError(ProviderError):
    """Raised when provider authentication fails."""
    pass


class ProviderAuthorizationError(ProviderError):
    """Raised when provider authorization is denied."""
    pass


class ProviderRateLimitError(ProviderError):
    """Raised when provider rate limit is exceeded."""
    pass


class ProviderTimeoutError(ProviderError):
    """Raised when provider request times out."""
    pass


class CircuitBreakerOpenError(ProviderError):
    """Raised when circuit breaker is open for a provider."""
    pass


# Gateway Errors
class GatewayError(DeploymentError):
    """Base exception for gateway-related errors."""
    pass


class GatewayConnectionError(GatewayError):
    """Raised when gateway connection fails."""
    pass


class GatewayAuthenticationError(GatewayError):
    """Raised when gateway authentication fails."""
    pass


class GatewayAuthorizationError(GatewayError):
    """Raised when gateway denies a request after authentication."""
    pass


class GatewayUnavailableError(GatewayError):
    """Raised when gateway is unavailable."""
    pass


class GatewayQuotaExceededError(GatewayError):
    """Raised when gateway quota is exceeded."""
    pass


class GatewayTimeoutError(GatewayError):
    """Raised when gateway request times out."""
    pass


# Migration Errors
class MigrationError(DeploymentError):
    """Base exception for migration-related errors."""
    pass


class MigrationValidationError(MigrationError):
    """Raised when migration validation fails."""
    pass


class MigrationDataError(MigrationError):
    """Raised when migration data is invalid or corrupted."""
    pass


class MigrationRollbackError(MigrationError):
    """Raised when migration rollback fails."""
    pass


class BackupError(MigrationError):
    """Raised when backup operations fail."""
    pass


class RestoreError(MigrationError):
    """Raised when restore operations fail."""
    pass


# Version Compatibility Errors
class VersionError(DeploymentError):
    """Base exception for version-related errors."""
    pass


class VersionIncompatibleError(VersionError):
    """Raised when versions are incompatible."""
    pass


class VersionParseError(VersionError):
    """Raised when version parsing fails."""
    pass


# Health Check Errors
class HealthCheckError(DeploymentError):
    """Base exception for health check-related errors."""
    pass


class HealthCheckFailedError(HealthCheckError):
    """Raised when a health check fails."""
    pass


class SystemUnhealthyError(HealthCheckError):
    """Raised when the system is unhealthy."""
    pass
