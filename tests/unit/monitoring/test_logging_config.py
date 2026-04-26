"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for logging_config structured logging functions.
"""

from __future__ import annotations

from unittest.mock import MagicMock, call

import pytest

from caracal.logging_config import (
    _redact_sensitive_values,
    add_correlation_id,
    clear_correlation_id,
    get_correlation_id,
    log_allowlist_check,
    log_authentication_failure,
    log_authority_decision,
    log_authority_policy_change,
    log_database_query,
    log_delegation_chain_validation,
    log_delegation_token_validation,
    log_dlq_event,
    log_event_replay,
    log_intent_validation,
    log_mandate_issuance,
    log_mandate_revocation,
    log_mandate_validation,
    log_merkle_root_computation,
    log_merkle_signature,
    log_merkle_verification,
    log_policy_version_change,
    log_snapshot_operation,
    redact_sensitive_fields,
    resolve_runtime_logging_policy,
    set_correlation_id,
)


def _logger() -> MagicMock:
    m = MagicMock()
    m.info = MagicMock()
    m.warning = MagicMock()
    m.error = MagicMock()
    m.debug = MagicMock()
    return m


@pytest.mark.unit
class TestCorrelationId:
    def test_set_returns_id(self) -> None:
        cid = set_correlation_id("abc-123")
        assert cid == "abc-123"
        clear_correlation_id()

    def test_set_none_generates_uuid(self) -> None:
        cid = set_correlation_id()
        assert len(cid) == 36
        clear_correlation_id()

    def test_get_returns_set_id(self) -> None:
        set_correlation_id("my-id")
        assert get_correlation_id() == "my-id"
        clear_correlation_id()

    def test_clear_returns_none(self) -> None:
        set_correlation_id("x")
        clear_correlation_id()
        assert get_correlation_id() is None

    def test_add_correlation_id_processor_adds_when_set(self) -> None:
        set_correlation_id("cid-1")
        event_dict = {"event": "test"}
        result = add_correlation_id(None, None, event_dict)
        assert result["correlation_id"] == "cid-1"
        clear_correlation_id()

    def test_add_correlation_id_processor_skips_when_none(self) -> None:
        clear_correlation_id()
        event_dict = {"event": "test"}
        result = add_correlation_id(None, None, event_dict)
        assert "correlation_id" not in result


@pytest.mark.unit
class TestRedactSensitiveValues:
    def test_redacts_password_key(self) -> None:
        result = _redact_sensitive_values({"password": "secret"})
        assert result["password"] == "[REDACTED]"

    def test_redacts_token_key(self) -> None:
        result = _redact_sensitive_values({"access_token": "tok"})
        assert result["access_token"] == "[REDACTED]"

    def test_redacts_secret_key(self) -> None:
        result = _redact_sensitive_values({"api_secret": "val"})
        assert result["api_secret"] == "[REDACTED]"

    def test_non_sensitive_key_unchanged(self) -> None:
        result = _redact_sensitive_values({"user": "alice"})
        assert result["user"] == "alice"

    def test_nested_dict_redacted(self) -> None:
        result = _redact_sensitive_values({"creds": {"password": "x"}})
        assert result["creds"]["password"] == "[REDACTED]"

    def test_list_recursed(self) -> None:
        result = _redact_sensitive_values([{"password": "s"}])
        assert result[0]["password"] == "[REDACTED]"

    def test_tuple_recursed(self) -> None:
        result = _redact_sensitive_values(({"password": "s"},))
        assert result[0]["password"] == "[REDACTED]"

    def test_non_dict_passthrough(self) -> None:
        assert _redact_sensitive_values("plain") == "plain"
        assert _redact_sensitive_values(42) == 42

    def test_redact_processor_wrapper(self) -> None:
        event_dict = {"password": "secret", "event": "test"}
        result = redact_sensitive_fields(None, None, event_dict)
        assert result["password"] == "[REDACTED]"


@pytest.mark.unit
class TestResolveRuntimeLoggingPolicy:
    def test_dev_mode_debug_level_when_debug_enabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_DEBUG_LOGS", "true")
        policy = resolve_runtime_logging_policy(mode="dev")
        assert policy.level == "DEBUG"

    def test_dev_mode_info_level_when_debug_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CCL_DEBUG_LOGS", raising=False)
        policy = resolve_runtime_logging_policy(mode="dev")
        assert policy.level == "INFO"

    def test_prod_mode_forces_json(self) -> None:
        policy = resolve_runtime_logging_policy(mode="prod")
        assert policy.json_format is True

    def test_prod_mode_level_not_debug(self) -> None:
        policy = resolve_runtime_logging_policy(mode="prod", requested_level="DEBUG")
        assert policy.level == "INFO"

    def test_requested_level_honored_for_info(self) -> None:
        policy = resolve_runtime_logging_policy(mode="dev", requested_level="WARNING")
        assert policy.level == "WARNING"


@pytest.mark.unit
class TestLogAuthenticationFailure:
    def test_calls_warning_with_auth_method(self) -> None:
        logger = _logger()
        log_authentication_failure(logger, auth_method="jwt", reason="expired")
        logger.warning.assert_called_once()
        _, kwargs = logger.warning.call_args
        assert kwargs["event_type"] == "authentication_failure"
        assert kwargs["auth_method"] == "jwt"

    def test_includes_principal_id_when_provided(self) -> None:
        logger = _logger()
        log_authentication_failure(logger, "mtls", principal_id="pid-1")
        _, kwargs = logger.warning.call_args
        assert kwargs["principal_id"] == "pid-1"

    def test_omits_principal_id_when_none(self) -> None:
        logger = _logger()
        log_authentication_failure(logger, "api_key")
        _, kwargs = logger.warning.call_args
        assert "principal_id" not in kwargs


@pytest.mark.unit
class TestLogDatabaseQuery:
    def test_calls_debug(self) -> None:
        logger = _logger()
        log_database_query(logger, "select", "principals", 5.0)
        logger.debug.assert_called_once()

    def test_includes_all_fields(self) -> None:
        logger = _logger()
        log_database_query(logger, "insert", "ledger", 12.5)
        _, kwargs = logger.debug.call_args
        assert kwargs["operation"] == "insert"
        assert kwargs["table"] == "ledger"
        assert kwargs["duration_ms"] == 12.5


@pytest.mark.unit
class TestLogDelegationTokenValidation:
    def test_success_calls_info(self) -> None:
        logger = _logger()
        log_delegation_token_validation(logger, "pid-a", "pid-b", success=True)
        logger.info.assert_called_once()

    def test_failure_calls_warning(self) -> None:
        logger = _logger()
        log_delegation_token_validation(logger, "pid-a", "pid-b", success=False, reason="expired")
        logger.warning.assert_called_once()

    def test_failure_reason_included(self) -> None:
        logger = _logger()
        log_delegation_token_validation(logger, "pid-a", "pid-b", False, reason="revoked")
        _, kwargs = logger.warning.call_args
        assert kwargs["reason"] == "revoked"


@pytest.mark.unit
class TestLogMerkleRootComputation:
    def test_calls_info(self) -> None:
        logger = _logger()
        log_merkle_root_computation(logger, "batch-1", 100, "abc123", 45.0)
        logger.info.assert_called_once()

    def test_includes_all_fields(self) -> None:
        logger = _logger()
        log_merkle_root_computation(logger, "batch-2", 50, "deadbeef", 20.0)
        _, kwargs = logger.info.call_args
        assert kwargs["batch_id"] == "batch-2"
        assert kwargs["event_count"] == 50
        assert kwargs["merkle_root"] == "deadbeef"


@pytest.mark.unit
class TestLogMerkleSignature:
    def test_calls_info(self) -> None:
        logger = _logger()
        log_merkle_signature(logger, "b-1", "root-hex", "sig-hex", "software", 3.0)
        logger.info.assert_called_once()

    def test_fields_present(self) -> None:
        logger = _logger()
        log_merkle_signature(logger, "b-1", "r", "s", "vault", 5.0)
        _, kwargs = logger.info.call_args
        assert kwargs["signing_backend"] == "vault"


@pytest.mark.unit
class TestLogMerkleVerification:
    def test_success_calls_info(self) -> None:
        logger = _logger()
        log_merkle_verification(logger, "batch-1", success=True, duration_ms=10.0)
        logger.info.assert_called_once()

    def test_failure_calls_error(self) -> None:
        logger = _logger()
        log_merkle_verification(logger, "batch-1", success=False, duration_ms=5.0, failure_reason="hash mismatch")
        logger.error.assert_called_once()

    def test_failure_reason_included(self) -> None:
        logger = _logger()
        log_merkle_verification(logger, "b1", False, 5.0, failure_reason="invalid")
        _, kwargs = logger.error.call_args
        assert kwargs["failure_reason"] == "invalid"


@pytest.mark.unit
class TestLogPolicyVersionChange:
    def test_calls_info(self) -> None:
        logger = _logger()
        log_policy_version_change(logger, "pol-1", "pid-1", "created", 1, "admin", "initial")
        logger.info.assert_called_once()

    def test_before_after_values_included(self) -> None:
        logger = _logger()
        log_policy_version_change(
            logger, "p", "pid", "modified", 2, "user", "fix",
            before_values={"allow": True},
            after_values={"allow": False},
        )
        _, kwargs = logger.info.call_args
        assert kwargs["before_values"] == {"allow": True}
        assert kwargs["after_values"] == {"allow": False}


@pytest.mark.unit
class TestLogAllowlistCheck:
    def test_allowed_calls_info(self) -> None:
        logger = _logger()
        log_allowlist_check(logger, "pid-1", "api://openai/*", "allowed")
        logger.info.assert_called_once()

    def test_denied_calls_warning(self) -> None:
        logger = _logger()
        log_allowlist_check(logger, "pid-1", "api://other/*", "denied")
        logger.warning.assert_called_once()

    def test_other_result_calls_debug(self) -> None:
        logger = _logger()
        log_allowlist_check(logger, "pid-1", "*", "no_allowlist")
        logger.debug.assert_called_once()

    def test_optional_fields_included(self) -> None:
        logger = _logger()
        log_allowlist_check(
            logger, "pid-1", "res", "allowed",
            matched_pattern="api://*",
            pattern_type="glob",
            duration_ms=0.5,
        )
        _, kwargs = logger.info.call_args
        assert kwargs["matched_pattern"] == "api://*"
        assert kwargs["pattern_type"] == "glob"
        assert kwargs["duration_ms"] == 0.5


@pytest.mark.unit
class TestLogEventReplay:
    def test_started_calls_info(self) -> None:
        logger = _logger()
        log_event_replay(logger, "replay-1", "timestamp", status="started")
        logger.info.assert_called_once()

    def test_completed_calls_info(self) -> None:
        logger = _logger()
        log_event_replay(logger, "replay-1", "snapshot", status="completed")
        logger.info.assert_called_once()

    def test_failed_calls_error(self) -> None:
        logger = _logger()
        log_event_replay(logger, "replay-1", "offset", status="failed")
        logger.error.assert_called_once()

    def test_in_progress_calls_debug(self) -> None:
        logger = _logger()
        log_event_replay(logger, "replay-1", "snapshot", status="in_progress")
        logger.debug.assert_called_once()

    def test_optional_fields_included(self) -> None:
        logger = _logger()
        log_event_replay(
            logger, "r-1", "snapshot",
            start_offset=100,
            start_timestamp="2024-01-01T00:00:00Z",
            events_processed=500,
            duration_seconds=30.0,
            status="completed",
        )
        _, kwargs = logger.info.call_args
        assert kwargs["start_offset"] == 100
        assert kwargs["events_processed"] == 500


@pytest.mark.unit
class TestLogSnapshotOperation:
    def test_started_calls_info(self) -> None:
        logger = _logger()
        log_snapshot_operation(logger, "snap-1", "create", status="started")
        logger.info.assert_called_once()

    def test_completed_calls_info(self) -> None:
        logger = _logger()
        log_snapshot_operation(logger, "snap-1", "restore", status="completed")
        logger.info.assert_called_once()

    def test_failed_calls_error(self) -> None:
        logger = _logger()
        log_snapshot_operation(logger, "snap-1", "delete", status="failed")
        logger.error.assert_called_once()

    def test_debug_for_other_status(self) -> None:
        logger = _logger()
        log_snapshot_operation(logger, "snap-1", "create", status="in_progress")
        logger.debug.assert_called_once()


@pytest.mark.unit
class TestLogDlqEvent:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_dlq_event(logger, "tx", 0, 100, "ParseError", "bad payload", 3)


@pytest.mark.unit
class TestLogAuthorityDecision:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_authority_decision(logger, "pid-1", "mandate-1", "allowed", "read", "/secrets")


@pytest.mark.unit
class TestLogMandateIssuance:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_mandate_issuance(logger, "mandate-1", "issuer-1", "subject-1", ["read"], ["api:*"], 3600)


@pytest.mark.unit
class TestLogMandateValidation:
    def test_success_calls_logger(self) -> None:
        logger = _logger()
        log_mandate_validation(logger, "mandate-1", "pid-1", "read", "api://x", "allowed")

    def test_failure_calls_logger(self) -> None:
        logger = _logger()
        log_mandate_validation(logger, "mandate-1", "pid-1", "write", "api://y", "denied", denial_reason="no permission")


@pytest.mark.unit
class TestLogMandateRevocation:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_mandate_revocation(logger, "mandate-1", "pid-1", "actor-1", "security breach")


@pytest.mark.unit
class TestLogAuthorityPolicyChange:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_authority_policy_change(logger, "policy-1", "pid-1", "created", "admin", "initial setup")


@pytest.mark.unit
class TestLogDelegationChainValidation:
    def test_success_calls_logger(self) -> None:
        logger = _logger()
        log_delegation_chain_validation(logger, "mandate-1", "pid-1", 2, chain_valid=True)

    def test_failure_calls_logger(self) -> None:
        logger = _logger()
        log_delegation_chain_validation(logger, "mandate-1", "pid-1", 3, chain_valid=False, failure_reason="cycle")


@pytest.mark.unit
class TestLogIntentValidation:
    def test_calls_logger(self) -> None:
        logger = _logger()
        log_intent_validation(logger, "pid-1", "mandate-1", "INFER", True, 5.0)
