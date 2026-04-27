"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for structured logging helpers in deployment/logging_utils.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from caracal.deployment.logging_utils import (
    log_edition_change,
    log_encryption_operation,
    log_health_check,
    log_migration_operation,
    log_mode_change,
    log_provider_call,
    log_sync_operation,
    log_workspace_operation,
)


def _logger():
    m = MagicMock()
    m.info = MagicMock()
    m.error = MagicMock()
    m.warning = MagicMock()
    m.debug = MagicMock()
    return m


@pytest.mark.unit
class TestLogModeChange:
    def test_calls_info(self):
        lg = _logger()
        log_mode_change(lg, "dev", "user", "admin")
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["event_type"] == "mode_change"
        assert call_kwargs["old_mode"] == "dev"
        assert call_kwargs["new_mode"] == "user"
        assert call_kwargs["changed_by"] == "admin"

    def test_passes_extra_kwargs(self):
        lg = _logger()
        log_mode_change(lg, "dev", "user", "admin", reason="upgrade")
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["reason"] == "upgrade"


@pytest.mark.unit
class TestLogEditionChange:
    def test_calls_info(self):
        lg = _logger()
        log_edition_change(lg, "oss", "enterprise", "admin")
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["event_type"] == "edition_change"
        assert call_kwargs["old_edition"] == "oss"
        assert call_kwargs["new_edition"] == "enterprise"


@pytest.mark.unit
class TestLogWorkspaceOperation:
    def test_success_calls_info(self):
        lg = _logger()
        log_workspace_operation(lg, "create", "my_workspace", success=True, duration_ms=50.0)
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["workspace"] == "my_workspace"
        assert call_kwargs["duration_ms"] == 50.0

    def test_failure_calls_error(self):
        lg = _logger()
        log_workspace_operation(lg, "delete", "my_workspace", success=False, error="permission denied")
        lg.error.assert_called_once()
        call_kwargs = lg.error.call_args[1]
        assert call_kwargs["error"] == "permission denied"

    def test_no_duration_excluded(self):
        lg = _logger()
        log_workspace_operation(lg, "create", "workspace", success=True)
        call_kwargs = lg.info.call_args[1]
        assert "duration_ms" not in call_kwargs


@pytest.mark.unit
class TestLogSyncOperation:
    def test_success_calls_info(self):
        lg = _logger()
        log_sync_operation(lg, "workspace1", "push", success=True, uploaded=5)
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["uploaded"] == 5
        assert call_kwargs["direction"] == "push"

    def test_failure_calls_error(self):
        lg = _logger()
        log_sync_operation(lg, "workspace1", "pull", success=False, error="timeout")
        lg.error.assert_called_once()
        call_kwargs = lg.error.call_args[1]
        assert call_kwargs["error"] == "timeout"


@pytest.mark.unit
class TestLogProviderCall:
    def test_success_calls_info(self):
        lg = _logger()
        log_provider_call(lg, "openai", "chat", success=True, status_code=200)
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["provider"] == "openai"
        assert call_kwargs["status_code"] == 200

    def test_failure_calls_warning(self):
        lg = _logger()
        log_provider_call(lg, "openai", "chat", success=False, error="rate limit")
        lg.warning.assert_called_once()
        call_kwargs = lg.warning.call_args[1]
        assert call_kwargs["error"] == "rate limit"


@pytest.mark.unit
class TestLogEncryptionOperation:
    def test_success_calls_debug(self):
        lg = _logger()
        log_encryption_operation(lg, "encrypt", "key-1", success=True, duration_ms=2.5)
        lg.debug.assert_called_once()
        call_kwargs = lg.debug.call_args[1]
        assert call_kwargs["key_id"] == "key-1"
        assert call_kwargs["duration_ms"] == 2.5

    def test_failure_calls_error(self):
        lg = _logger()
        log_encryption_operation(lg, "decrypt", "key-1", success=False, error="invalid key")
        lg.error.assert_called_once()
        call_kwargs = lg.error.call_args[1]
        assert call_kwargs["error"] == "invalid key"


@pytest.mark.unit
class TestLogMigrationOperation:
    def test_success_calls_info(self):
        lg = _logger()
        log_migration_operation(lg, "storage", success=True, items_migrated=10)
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["items_migrated"] == 10

    def test_failure_calls_error(self):
        lg = _logger()
        log_migration_operation(lg, "storage", success=False, error="disk full")
        lg.error.assert_called_once()


@pytest.mark.unit
class TestLogHealthCheck:
    def test_pass_status_calls_info(self):
        lg = _logger()
        log_health_check(lg, "db", "pass", "healthy", duration_ms=5.0)
        lg.info.assert_called_once()
        call_kwargs = lg.info.call_args[1]
        assert call_kwargs["check_name"] == "db"
        assert call_kwargs["duration_ms"] == 5.0

    def test_warn_status_calls_warning(self):
        lg = _logger()
        log_health_check(lg, "redis", "warn", "slow")
        lg.warning.assert_called_once()

    def test_fail_status_calls_error(self):
        lg = _logger()
        log_health_check(lg, "db", "fail", "unreachable")
        lg.error.assert_called_once()
        call_kwargs = lg.error.call_args[1]
        assert call_kwargs["message"] == "unreachable"

    def test_no_duration_excluded(self):
        lg = _logger()
        log_health_check(lg, "db", "pass", "ok")
        call_kwargs = lg.info.call_args[1]
        assert "duration_ms" not in call_kwargs
