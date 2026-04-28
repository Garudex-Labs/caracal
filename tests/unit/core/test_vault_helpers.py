"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for vault module helper functions.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from caracal.core.vault import (
    _extract_string,
    _is_local_bootstrap_token,
    _is_local_bootstrap_vault_url,
    _json_object,
    _save_recovered_vault_token,
    _truncate_detail,
    _VaultRateLimiter,
    _assert_vault_access_context,
    vault_access_context,
    GatewayContextRequired,
    RotationResult,
    VaultAuditEvent,
    VaultEntry,
    VaultError,
    VaultRateLimitExceeded,
    SecretNotFound,
    VaultConfigurationError,
    VaultUnavailableError,
)

@pytest.mark.unit
class TestTruncateDetail:
    def test_empty_string(self) -> None:
        assert _truncate_detail("") == ""

    def test_none_like_value(self) -> None:
        assert _truncate_detail(None) == ""  # type: ignore[arg-type]

    def test_short_string_unchanged(self) -> None:
        assert _truncate_detail("hello") == "hello"

    def test_string_at_limit(self) -> None:
        s = "x" * 300
        assert _truncate_detail(s) == s

    def test_string_over_limit_truncated(self) -> None:
        s = "x" * 400
        result = _truncate_detail(s)
        assert result.endswith("...")
        assert len(result) == 303

    def test_custom_limit(self) -> None:
        result = _truncate_detail("abcde", limit=3)
        assert result == "abc..."

    def test_whitespace_is_stripped(self) -> None:
        assert _truncate_detail("  hello  ") == "hello"

    def test_whitespace_only_returns_empty(self) -> None:
        assert _truncate_detail("   ") == ""


@pytest.mark.unit
class TestJsonObject:
    def _make_response(
        self,
        content: bytes,
        payload: dict | list | None = None,
        raises: bool = False,
    ) -> MagicMock:
        resp = MagicMock()
        resp.content = content
        if raises:
            resp.json.side_effect = ValueError("bad json")
        else:
            resp.json.return_value = payload
        return resp

    def test_empty_content_returns_empty_dict(self) -> None:
        resp = self._make_response(b"")
        assert _json_object(resp) == {}

    def test_valid_dict_payload(self) -> None:
        resp = self._make_response(b"{}", payload={"key": "val"})
        assert _json_object(resp) == {"key": "val"}

    def test_json_parse_error_returns_empty_dict(self) -> None:
        resp = self._make_response(b"bad", raises=True)
        assert _json_object(resp) == {}

    def test_list_payload_returns_empty_dict(self) -> None:
        resp = self._make_response(b"[]", payload=[1, 2, 3])
        assert _json_object(resp) == {}


@pytest.mark.unit
class TestExtractString:
    def test_simple_path(self) -> None:
        payload = {"a": {"b": "value"}}
        result = _extract_string(payload, ("a", "b"))
        assert result == "value"

    def test_missing_path_returns_none(self) -> None:
        payload = {"a": {}}
        result = _extract_string(payload, ("a", "missing"))
        assert result is None

    def test_fallback_path(self) -> None:
        payload = {"alt": "fallback"}
        result = _extract_string(payload, ("primary",), ("alt",))
        assert result == "fallback"

    def test_empty_string_not_returned(self) -> None:
        payload = {"key": "   "}
        result = _extract_string(payload, ("key",))
        assert result is None

    def test_no_paths_returns_none(self) -> None:
        assert _extract_string({}) is None

    def test_non_string_value_returns_none(self) -> None:
        payload = {"key": 42}
        result = _extract_string(payload, ("key",))
        assert result is None

    def test_nested_miss_mid_path(self) -> None:
        payload = {"a": "not-a-dict"}
        result = _extract_string(payload, ("a", "b"))
        assert result is None


@pytest.mark.unit
class TestIsLocalBootstrapToken:
    def test_known_dev_token(self) -> None:
        assert _is_local_bootstrap_token("dev-local-token") is True

    def test_known_enterprise_token(self) -> None:
        assert _is_local_bootstrap_token("enterprise-local-token") is True

    def test_case_insensitive(self) -> None:
        assert _is_local_bootstrap_token("DEV-LOCAL-TOKEN") is True

    def test_unknown_token(self) -> None:
        assert _is_local_bootstrap_token("some-other-token") is False

    def test_empty_string(self) -> None:
        assert _is_local_bootstrap_token("") is False

    def test_none(self) -> None:
        assert _is_local_bootstrap_token(None) is False  # type: ignore[arg-type]


@pytest.mark.unit
class TestIsLocalBootstrapVaultUrl:
    def test_localhost(self) -> None:
        assert _is_local_bootstrap_vault_url("http://localhost:8080") is True

    def test_loopback_ip(self) -> None:
        assert _is_local_bootstrap_vault_url("https://127.0.0.1/api") is True

    def test_vault_hostname(self) -> None:
        assert _is_local_bootstrap_vault_url("http://vault:8200") is True

    def test_external_host(self) -> None:
        assert _is_local_bootstrap_vault_url("https://vault.example.com") is False

    def test_empty_string(self) -> None:
        assert _is_local_bootstrap_vault_url("") is False

    def test_invalid_scheme(self) -> None:
        assert _is_local_bootstrap_vault_url("ftp://localhost") is False

    def test_none(self) -> None:
        assert _is_local_bootstrap_vault_url(None) is False  # type: ignore[arg-type]


@pytest.mark.unit
class TestSaveRecoveredVaultToken:
    def test_no_ccl_home_is_noop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CCL_HOME", raising=False)
        _save_recovered_vault_token("my-token")  # must not raise

    def test_writes_token_to_new_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        _save_recovered_vault_token("new-token")
        env_file = tmp_path / ".env"
        contents = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=new-token" in contents

    def test_creates_missing_ccl_home_directory(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        nested_home = tmp_path / "nested" / "vault-home"
        monkeypatch.setenv("CCL_HOME", str(nested_home))
        _save_recovered_vault_token("created-token")
        env_file = nested_home / ".env"
        assert env_file.exists() is True
        assert "CCL_VAULT_ID_TOKEN=created-token" in env_file.read_text()

    def test_replaces_existing_key(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("CCL_VAULT_ID_TOKEN=old-token\nOTHER=value\n")
        _save_recovered_vault_token("new-token")
        contents = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=new-token" in contents
        assert "CCL_VAULT_ID_TOKEN=old-token" not in contents
        assert "OTHER=value" in contents

    def test_appends_when_key_missing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("OTHER=value\n")
        _save_recovered_vault_token("appended-token")
        contents = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=appended-token" in contents
        assert "OTHER=value" in contents

    def test_appends_newline_before_key_when_missing_newline(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        env_file = tmp_path / ".env"
        env_file.write_text("OTHER=value")
        _save_recovered_vault_token("tok")
        contents = env_file.read_text()
        assert "CCL_VAULT_ID_TOKEN=tok" in contents


@pytest.mark.unit
class TestVaultExceptions:
    def test_vault_error_is_exception(self) -> None:
        e = VaultError("base")
        assert isinstance(e, Exception)

    def test_gateway_context_required_hierarchy(self) -> None:
        e = GatewayContextRequired("ctx")
        assert isinstance(e, VaultError)

    def test_secret_not_found_hierarchy(self) -> None:
        e = SecretNotFound("missing")
        assert isinstance(e, VaultError)

    def test_vault_rate_limit_exceeded_hierarchy(self) -> None:
        e = VaultRateLimitExceeded("limit")
        assert isinstance(e, VaultError)

    def test_vault_configuration_error_hierarchy(self) -> None:
        e = VaultConfigurationError("cfg")
        assert isinstance(e, VaultError)

    def test_vault_unavailable_error_hierarchy(self) -> None:
        e = VaultUnavailableError("down")
        assert isinstance(e, VaultError)


@pytest.mark.unit
class TestVaultDataClasses:
    def test_vault_entry_fields(self) -> None:
        entry = VaultEntry(
            entry_id="e1",
            workspace_id="workspace1",
            env_id="env1",
            secret_name="my-secret",
            ciphertext_b64="abc",
            iv_b64="iv",
            encrypted_dek_b64="dek",
            dek_iv_b64="div",
            key_version=1,
            created_at="2026-01-01",
            updated_at="2026-01-02",
        )
        assert entry.secret_name == "my-secret"
        assert entry.key_version == 1

    def test_vault_audit_event_defaults(self) -> None:
        event = VaultAuditEvent(
            event_id="ev1",
            workspace_id="workspace1",
            env_id="env1",
            secret_name="s",
            operation="read",
            key_version=2,
            actor="alice",
            timestamp="t",
            success=True,
        )
        assert event.error_code is None
        assert event.success is True

    def test_rotation_result_fields(self) -> None:
        r = RotationResult(
            secrets_rotated=5,
            secrets_failed=1,
            new_key_version=3,
            duration_seconds=0.42,
        )
        assert r.secrets_rotated == 5
        assert r.new_key_version == 3


@pytest.mark.unit
class TestVaultRateLimiter:
    def test_first_request_allowed(self) -> None:
        limiter = _VaultRateLimiter(limit=10, window=60.0)
        limiter.check("workspace1")  # must not raise

    def test_repeated_requests_within_limit(self) -> None:
        limiter = _VaultRateLimiter(limit=5, window=60.0)
        for _ in range(5):
            limiter.check("workspace1")

    def test_exceeding_limit_raises(self) -> None:
        limiter = _VaultRateLimiter(limit=1, window=3600.0)
        limiter.check("workspace1")  # first request uses the token
        with pytest.raises(VaultRateLimitExceeded):
            limiter.check("workspace1")

    def test_different_workspaces_independent(self) -> None:
        limiter = _VaultRateLimiter(limit=1, window=3600.0)
        limiter.check("workspace1")
        limiter.check("ws2")  # independent bucket, must not raise


@pytest.mark.unit
class TestVaultAccessContext:
    def test_context_manager_sets_active(self) -> None:
        with vault_access_context():
            _assert_vault_access_context()  # must not raise

    def test_outside_context_raises(self) -> None:
        with pytest.raises(GatewayContextRequired):
            _assert_vault_access_context()

    def test_nested_context_stays_active(self) -> None:
        with vault_access_context():
            with vault_access_context():
                _assert_vault_access_context()
            _assert_vault_access_context()  # still active

    def test_context_deactivated_after_exit(self) -> None:
        with vault_access_context():
            pass
        with pytest.raises(GatewayContextRequired):
            _assert_vault_access_context()
