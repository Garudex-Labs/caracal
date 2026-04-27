"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for the deployment exception hierarchy in exceptions.py.
"""

from __future__ import annotations

import pytest

from caracal.deployment.exceptions import (
    BackupError,
    CircuitBreakerOpenError,
    ConfigurationCorruptedError,
    ConfigurationError,
    ConfigurationNotFoundError,
    ConfigurationValidationError,
    DecryptionError,
    DeploymentError,
    EditionConfigurationError,
    EditionDetectionError,
    EditionError,
    EncryptionError,
    EncryptionKeyError,
    GatewayAuthenticationError,
    GatewayAuthorizationError,
    GatewayConnectionError,
    GatewayError,
    GatewayQuotaExceededError,
    GatewayTimeoutError,
    GatewayUnavailableError,
    HealthCheckError,
    HealthCheckFailedError,
    InvalidEditionError,
    InvalidModeError,
    InvalidWorkspaceNameError,
    MigrationDataError,
    MigrationError,
    MigrationRollbackError,
    MigrationValidationError,
    ModeConfigurationError,
    ModeDetectionError,
    ModeError,
    NetworkError,
    OfflineError,
    ProviderAuthenticationError,
    ProviderAuthorizationError,
    ProviderConfigurationError,
    ProviderConnectionError,
    ProviderError,
    ProviderNotFoundError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    RestoreError,
    SecretNotFoundError,
    SyncConflictError,
    SyncConnectionError,
    SyncError,
    SyncOperationError,
    SyncStateError,
    SystemUnhealthyError,
    VersionError,
    VersionIncompatibleError,
    VersionParseError,
    WorkspaceAlreadyExistsError,
    WorkspaceError,
    WorkspaceNotFoundError,
    WorkspaceOperationError,
)
from caracal.exceptions import CaracalError


@pytest.mark.unit
class TestDeploymentErrorBase:
    def test_is_caracal_error(self):
        assert issubclass(DeploymentError, CaracalError)

    def test_can_be_raised_with_message(self):
        with pytest.raises(DeploymentError, match="test"):
            raise DeploymentError("test")


@pytest.mark.unit
class TestModeErrors:
    def test_mode_error_is_deployment_error(self):
        assert issubclass(ModeError, DeploymentError)

    def test_invalid_mode_error_is_mode_error(self):
        assert issubclass(InvalidModeError, ModeError)

    def test_mode_configuration_error_is_mode_error(self):
        assert issubclass(ModeConfigurationError, ModeError)

    def test_mode_detection_error_is_mode_error(self):
        assert issubclass(ModeDetectionError, ModeError)

    def test_raise_invalid_mode_error(self):
        with pytest.raises(InvalidModeError):
            raise InvalidModeError("bad mode")

    def test_catch_as_deployment_error(self):
        with pytest.raises(DeploymentError):
            raise ModeConfigurationError("config fail")


@pytest.mark.unit
class TestEditionErrors:
    def test_edition_error_is_deployment_error(self):
        assert issubclass(EditionError, DeploymentError)

    def test_invalid_edition_error(self):
        assert issubclass(InvalidEditionError, EditionError)
        with pytest.raises(InvalidEditionError): raise InvalidEditionError("x")

    def test_edition_configuration_error(self):
        assert issubclass(EditionConfigurationError, EditionError)

    def test_edition_detection_error(self):
        assert issubclass(EditionDetectionError, EditionError)


@pytest.mark.unit
class TestConfigurationErrors:
    def test_configuration_error_is_deployment_error(self):
        assert issubclass(ConfigurationError, DeploymentError)

    def test_configuration_not_found(self):
        assert issubclass(ConfigurationNotFoundError, ConfigurationError)
        with pytest.raises(ConfigurationNotFoundError): raise ConfigurationNotFoundError("missing")

    def test_configuration_corrupted(self):
        assert issubclass(ConfigurationCorruptedError, ConfigurationError)

    def test_configuration_validation(self):
        assert issubclass(ConfigurationValidationError, ConfigurationError)


@pytest.mark.unit
class TestWorkspaceErrors:
    def test_workspace_error_is_configuration_error(self):
        assert issubclass(WorkspaceError, ConfigurationError)

    def test_workspace_not_found(self):
        assert issubclass(WorkspaceNotFoundError, WorkspaceError)
        with pytest.raises(WorkspaceNotFoundError): raise WorkspaceNotFoundError("workspace")

    def test_workspace_already_exists(self):
        assert issubclass(WorkspaceAlreadyExistsError, WorkspaceError)

    def test_invalid_workspace_name(self):
        assert issubclass(InvalidWorkspaceNameError, WorkspaceError)

    def test_workspace_operation_error(self):
        assert issubclass(WorkspaceOperationError, WorkspaceError)


@pytest.mark.unit
class TestEncryptionErrors:
    def test_encryption_error_is_deployment_error(self):
        assert issubclass(EncryptionError, DeploymentError)

    def test_encryption_key_error(self):
        assert issubclass(EncryptionKeyError, EncryptionError)
        with pytest.raises(EncryptionKeyError): raise EncryptionKeyError("key fail")

    def test_decryption_error(self):
        assert issubclass(DecryptionError, EncryptionError)

    def test_secret_not_found(self):
        assert issubclass(SecretNotFoundError, EncryptionError)


@pytest.mark.unit
class TestSyncErrors:
    def test_sync_error_is_deployment_error(self):
        assert issubclass(SyncError, DeploymentError)

    def test_sync_connection_error(self):
        assert issubclass(SyncConnectionError, SyncError)
        with pytest.raises(SyncConnectionError): raise SyncConnectionError("refused")

    def test_sync_operation_error(self):
        assert issubclass(SyncOperationError, SyncError)

    def test_sync_conflict_error(self):
        assert issubclass(SyncConflictError, SyncError)

    def test_sync_state_error(self):
        assert issubclass(SyncStateError, SyncError)

    def test_network_error(self):
        assert issubclass(NetworkError, SyncError)

    def test_offline_error(self):
        assert issubclass(OfflineError, SyncError)


@pytest.mark.unit
class TestProviderErrors:
    def test_provider_error_is_deployment_error(self):
        assert issubclass(ProviderError, DeploymentError)

    def test_provider_not_found(self):
        assert issubclass(ProviderNotFoundError, ProviderError)
        with pytest.raises(ProviderNotFoundError): raise ProviderNotFoundError("openai")

    def test_provider_configuration_error(self):
        assert issubclass(ProviderConfigurationError, ProviderError)

    def test_provider_connection_error(self):
        assert issubclass(ProviderConnectionError, ProviderError)

    def test_provider_authentication_error(self):
        assert issubclass(ProviderAuthenticationError, ProviderError)

    def test_provider_authorization_error(self):
        assert issubclass(ProviderAuthorizationError, ProviderError)

    def test_provider_rate_limit_error(self):
        assert issubclass(ProviderRateLimitError, ProviderError)

    def test_provider_timeout_error(self):
        assert issubclass(ProviderTimeoutError, ProviderError)

    def test_circuit_breaker_open_error(self):
        assert issubclass(CircuitBreakerOpenError, ProviderError)


@pytest.mark.unit
class TestGatewayErrors:
    def test_gateway_error_is_deployment_error(self):
        assert issubclass(GatewayError, DeploymentError)

    def test_gateway_connection_error(self):
        assert issubclass(GatewayConnectionError, GatewayError)
        with pytest.raises(GatewayConnectionError): raise GatewayConnectionError("conn fail")

    def test_gateway_authentication_error(self):
        assert issubclass(GatewayAuthenticationError, GatewayError)

    def test_gateway_authorization_error(self):
        assert issubclass(GatewayAuthorizationError, GatewayError)

    def test_gateway_unavailable_error(self):
        assert issubclass(GatewayUnavailableError, GatewayError)

    def test_gateway_quota_exceeded(self):
        assert issubclass(GatewayQuotaExceededError, GatewayError)

    def test_gateway_timeout_error(self):
        assert issubclass(GatewayTimeoutError, GatewayError)


@pytest.mark.unit
class TestMigrationErrors:
    def test_migration_error_is_deployment_error(self):
        assert issubclass(MigrationError, DeploymentError)

    def test_migration_validation_error(self):
        assert issubclass(MigrationValidationError, MigrationError)
        with pytest.raises(MigrationValidationError): raise MigrationValidationError("x")

    def test_migration_data_error(self):
        assert issubclass(MigrationDataError, MigrationError)

    def test_migration_rollback_error(self):
        assert issubclass(MigrationRollbackError, MigrationError)

    def test_backup_error(self):
        assert issubclass(BackupError, MigrationError)

    def test_restore_error(self):
        assert issubclass(RestoreError, MigrationError)


@pytest.mark.unit
class TestVersionErrors:
    def test_version_error_is_deployment_error(self):
        assert issubclass(VersionError, DeploymentError)

    def test_version_incompatible_error(self):
        assert issubclass(VersionIncompatibleError, VersionError)
        with pytest.raises(VersionIncompatibleError): raise VersionIncompatibleError("v1 vs v2")

    def test_version_parse_error(self):
        assert issubclass(VersionParseError, VersionError)
        with pytest.raises(VersionParseError): raise VersionParseError("bad version")


@pytest.mark.unit
class TestHealthCheckErrors:
    def test_health_check_error_is_deployment_error(self):
        assert issubclass(HealthCheckError, DeploymentError)

    def test_health_check_failed_error(self):
        assert issubclass(HealthCheckFailedError, HealthCheckError)
        with pytest.raises(HealthCheckFailedError): raise HealthCheckFailedError("db down")

    def test_system_unhealthy_error(self):
        assert issubclass(SystemUnhealthyError, HealthCheckError)
        with pytest.raises(SystemUnhealthyError): raise SystemUnhealthyError("critical")
