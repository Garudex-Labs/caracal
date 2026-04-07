"""Unit tests for the hard-cut HTTP-backed vault module."""

import os
from unittest.mock import Mock, patch

import pytest

from caracal.core.vault import (
    CaracalVault,
    GatewayContextRequired,
    RotationResult,
    SecretNotFound,
    VaultAuditEvent,
    VaultConfigurationError,
    VaultEntry,
    VaultError,
    VaultRateLimitExceeded,
    VaultUnavailableError,
    _load_vault_config,
    _read_env_or_dotenv,
    gateway_context,
)


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.content = b"{}" if payload is not None else b""

    def json(self):
        return self._payload


@pytest.fixture
def vault_env():
    return {
        "CARACAL_VAULT_URL": "http://vault.test",
        "CARACAL_VAULT_TOKEN": "token-123",
        "CARACAL_VAULT_PROJECT_ID": "proj-default",
        "CARACAL_VAULT_ENVIRONMENT": "dev",
        "CARACAL_VAULT_SECRET_PATH": "/",
        "CARACAL_VAULT_MODE": "managed",
    }


@pytest.fixture
def sample_vault_entry():
    return VaultEntry(
        entry_id="entry-123",
        org_id="org-456",
        env_id="env-789",
        secret_name="api-key",
        ciphertext_b64="",
        iv_b64="",
        encrypted_dek_b64="",
        dek_iv_b64="",
        key_version=1,
        created_at="2024-01-15T10:00:00Z",
        updated_at="2024-01-15T10:00:00Z",
    )


@pytest.fixture
def vault(vault_env):
    client = Mock()
    with patch.dict(os.environ, vault_env, clear=True):
        instance = CaracalVault(client=client)
    instance._ensure_service_health = Mock(return_value=None)
    return instance


@pytest.mark.unit
def test_vault_entry_dataclass(sample_vault_entry):
    assert sample_vault_entry.entry_id == "entry-123"
    assert sample_vault_entry.secret_name == "api-key"


@pytest.mark.unit
def test_vault_audit_event_dataclass():
    event = VaultAuditEvent(
        event_id="event-123",
        org_id="org-1",
        env_id="env-1",
        secret_name="k",
        operation="create",
        key_version=1,
        actor="gateway",
        timestamp="2024-01-01T00:00:00Z",
        success=True,
    )
    assert event.operation == "create"
    assert event.success is True


@pytest.mark.unit
def test_gateway_context_enforced():
    from caracal.core.vault import _assert_gateway_context

    with pytest.raises(GatewayContextRequired):
        _assert_gateway_context()

    with gateway_context():
        _assert_gateway_context()


@pytest.mark.unit
def test_load_vault_config_requires_url_and_token(vault_env):
    env = dict(vault_env)
    del env["CARACAL_VAULT_URL"]
    with patch("caracal.core.vault._read_env_or_dotenv", side_effect=lambda name: env.get(name)):
        with pytest.raises(VaultConfigurationError, match="CARACAL_VAULT_URL"):
            _load_vault_config()

    env = dict(vault_env)
    del env["CARACAL_VAULT_TOKEN"]
    with patch("caracal.core.vault._read_env_or_dotenv", side_effect=lambda name: env.get(name)):
        with pytest.raises(VaultConfigurationError, match="CARACAL_VAULT_TOKEN"):
            _load_vault_config()


@pytest.mark.unit
def test_load_vault_config_forbids_local_mode_in_hardcut(vault_env):
    env = dict(vault_env)
    env["CARACAL_VAULT_MODE"] = "local"
    with patch.dict(os.environ, env, clear=True):
        with pytest.raises(VaultConfigurationError, match="forbidden"):
            _load_vault_config()


@pytest.mark.unit
def test_load_vault_config_rejects_local_mode_without_fallback_defaults(vault_env):
    env = dict(vault_env)
    env["CARACAL_VAULT_MODE"] = "local"
    env.pop("CARACAL_VAULT_URL", None)
    env.pop("CARACAL_VAULT_TOKEN", None)

    with patch("caracal.core.vault._read_env_or_dotenv", side_effect=lambda name: env.get(name)):
        with pytest.raises(VaultConfigurationError, match="forbidden"):
            _load_vault_config()


@pytest.mark.unit
def test_load_vault_config_rejects_invalid_mode(vault_env):
    env = dict(vault_env)
    env["CARACAL_VAULT_MODE"] = "invalid-mode"

    with patch("caracal.core.vault._read_env_or_dotenv", side_effect=lambda name: env.get(name)):
        with pytest.raises(VaultConfigurationError, match="CARACAL_VAULT_MODE"):
            _load_vault_config()


@pytest.mark.unit
def test_read_env_or_dotenv_reads_environment_first(vault_env):
    with patch.dict(os.environ, vault_env, clear=True):
        assert _read_env_or_dotenv("CARACAL_VAULT_URL") == "http://vault.test"


@pytest.mark.unit
def test_request_raises_on_unexpected_status(vault_env):
    client = Mock()
    client.request.return_value = FakeResponse(status_code=500, payload={}, text="boom")

    with patch.dict(os.environ, vault_env, clear=True):
        vault = CaracalVault(client=client)

    with pytest.raises(VaultError, match="Vault API request failed"):
        vault._request("GET", "/api/test", allowed_statuses={200})


@pytest.mark.unit
def test_request_retries_and_succeeds_on_retryable_status(vault_env):
    client = Mock()
    client.request.side_effect = [
        FakeResponse(status_code=429, payload={}, text="rate limited"),
        FakeResponse(status_code=200, payload={"ok": True}, text="ok"),
    ]

    with patch.dict(os.environ, vault_env, clear=True):
        vault = CaracalVault(client=client)
    vault._config.retry_backoff_seconds = 0.0
    vault._config.retry_max_attempts = 2

    response = vault._request("GET", "/api/test", allowed_statuses={200})

    assert response.status_code == 200
    assert client.request.call_count == 2


@pytest.mark.unit
def test_request_raises_unavailable_after_retry_exhaustion(vault_env):
    client = Mock()
    client.request.side_effect = [
        FakeResponse(status_code=503, payload={}, text="unavailable"),
        FakeResponse(status_code=503, payload={}, text="unavailable"),
    ]

    with patch.dict(os.environ, vault_env, clear=True):
        vault = CaracalVault(client=client)
    vault._config.retry_backoff_seconds = 0.0
    vault._config.retry_max_attempts = 2

    with pytest.raises(VaultUnavailableError, match="unavailable"):
        vault._request("GET", "/api/test", allowed_statuses={200})

    assert client.request.call_count == 2


@pytest.mark.unit
def test_put_requires_gateway_context(vault):
    with pytest.raises(GatewayContextRequired):
        vault.put("org-1", "env-1", "name", "value")


@pytest.mark.unit
def test_put_success(vault):
    with patch.object(vault, "_secret_exists", return_value=False):
        with patch.object(vault, "_upsert_secret", return_value="entry-1"):
            with gateway_context():
                entry = vault.put("org-1", "env-1", "api-key", "value")

    assert entry.entry_id == "entry-1"
    assert entry.secret_name == "api-key"


@pytest.mark.unit
def test_put_routes_nested_secret_name_to_secret_path(vault):
    with patch.object(vault, "_secret_exists", return_value=False):
        with patch.object(vault, "_upsert_secret", return_value="entry-1") as upsert:
            with gateway_context():
                vault.put("org-1", "env-1", "principal-keys/abc-123", "value")

    upsert.assert_called_once_with(
        "org-1",
        "env-1",
        "/principal-keys",
        "abc-123",
        "value",
    )


@pytest.mark.unit
def test_get_success(vault):
    with patch.object(vault, "_get_secret_value", return_value="secret-value"):
        with gateway_context():
            value = vault.get("org-1", "env-1", "api-key")
    assert value == "secret-value"


@pytest.mark.unit
def test_get_routes_nested_secret_name_to_secret_path(vault):
    with patch.object(vault, "_get_secret_value", return_value="secret-value") as get_secret:
        with gateway_context():
            value = vault.get("org-1", "env-1", "principal-keys/abc-123")

    assert value == "secret-value"
    get_secret.assert_called_once_with("org-1", "env-1", "/principal-keys", "abc-123")


@pytest.mark.unit
def test_get_secret_not_found(vault):
    with patch.object(vault, "_get_secret_value", side_effect=SecretNotFound("missing")):
        with gateway_context():
            with pytest.raises(SecretNotFound):
                vault.get("org-1", "env-1", "api-key")


@pytest.mark.unit
def test_delete_success(vault):
    with patch.object(vault, "_delete_secret", return_value=None):
        with gateway_context():
            vault.delete("org-1", "env-1", "api-key")


@pytest.mark.unit
def test_list_secrets_success(vault):
    with patch.object(vault, "_list_secret_names", return_value=["one", "two"]):
        with gateway_context():
            names = vault.list_secrets("org-1", "env-1")
    assert names == ["one", "two"]


@pytest.mark.unit
def test_sign_jwt_uses_vault_managed_private_key(vault):
    response = FakeResponse(status_code=200, payload={"signedJwt": "token-123"})

    with patch.object(vault, "_request", return_value=response) as request:
        with gateway_context():
            token = vault.sign_jwt(
                "org-1",
                "env-1",
                "signing-key",
                payload={"sub": "principal-1"},
                headers={"kid": "principal-1"},
                algorithm="ES256",
            )

    assert token == "token-123"
    assert request.call_args.args[:2] == ("POST", "/api/caracal/sign/jwt")
    assert request.call_args.kwargs["payload"]["keyName"] == "signing-key"
    assert request.call_args.kwargs["payload"]["algorithm"] == "ES256"


@pytest.mark.unit
def test_sign_canonical_payload_uses_vault_managed_private_key(vault):
    response = FakeResponse(status_code=200, payload={"signatureHex": "abcd1234"})

    with patch.object(vault, "_request", return_value=response) as request:
        with gateway_context():
            signature = vault.sign_canonical_payload(
                "org-1",
                "env-1",
                "signing-key",
                payload={"hello": "world"},
            )

    assert signature == "abcd1234"
    assert request.call_args.args[:2] == ("POST", "/api/caracal/sign/canonical-payload")
    assert request.call_args.kwargs["payload"]["keyName"] == "signing-key"


@pytest.mark.unit
def test_ensure_asymmetric_keypair_bootstraps_missing_refs(vault):
    with patch.object(vault, "_request", return_value=FakeResponse(status_code=201, payload={"ok": True})) as request:
        with gateway_context():
            vault.ensure_asymmetric_keypair(
                "org-1",
                "env-1",
                private_key_name="keys/session-private",
                public_key_name="keys/session-public",
                algorithm="RS256",
            )

    assert request.call_args.args[:2] == ("POST", "/api/caracal/keys/bootstrap")
    assert request.call_args.kwargs["payload"] == {
        "projectId": "org-1",
        "environment": "env-1",
        "secretPath": "/keys",
        "privateKeyName": "session-private",
        "publicKeyName": "session-public",
        "algorithm": "RS256",
    }


@pytest.mark.unit
def test_ensure_asymmetric_keypair_rejects_same_private_and_public_ref(vault):
    with gateway_context():
        with pytest.raises(VaultConfigurationError, match="distinct private/public"):
            vault.ensure_asymmetric_keypair(
                "org-1",
                "env-1",
                private_key_name="keys/shared",
                public_key_name="keys/shared",
                algorithm="ES256",
            )


@pytest.mark.unit
def test_ensure_asymmetric_keypair_rejects_mismatched_secret_paths(vault):
    with gateway_context():
        with pytest.raises(VaultConfigurationError, match="same secret path namespace"):
            vault.ensure_asymmetric_keypair(
                "org-1",
                "env-1",
                private_key_name="keys/private",
                public_key_name="other/public",
                algorithm="ES256",
            )


@pytest.mark.unit
def test_ensure_asymmetric_keypair_falls_back_when_bootstrap_endpoint_missing(vault):
    missing_endpoint = VaultError(
        "Vault API request failed: POST /api/caracal/keys/bootstrap -> 404 not found"
    )

    with patch.object(vault, "_request", side_effect=missing_endpoint):
        with patch.object(vault, "_secret_exists", return_value=False):
            with patch.object(vault, "_upsert_secret", return_value="entry") as upsert:
                with gateway_context():
                    vault.ensure_asymmetric_keypair(
                        "org-1",
                        "env-1",
                        private_key_name="principal-keys/private",
                        public_key_name="principal-keys/public",
                        algorithm="ES256",
                    )

    assert upsert.call_count == 2
    first_call = upsert.call_args_list[0].args
    second_call = upsert.call_args_list[1].args
    assert first_call[:4] == ("org-1", "env-1", "/principal-keys", "private")
    assert second_call[:4] == ("org-1", "env-1", "/principal-keys", "public")


@pytest.mark.unit
def test_ensure_asymmetric_keypair_fallback_rejects_inconsistent_secret_state(vault):
    missing_endpoint = VaultError(
        "Vault API request failed: POST /api/caracal/keys/bootstrap -> 404 not found"
    )

    with patch.object(vault, "_request", side_effect=missing_endpoint):
        with patch.object(vault, "_secret_exists", side_effect=[True, False]):
            with gateway_context():
                with pytest.raises(VaultError, match="inconsistent"):
                    vault.ensure_asymmetric_keypair(
                        "org-1",
                        "env-1",
                        private_key_name="principal-keys/private",
                        public_key_name="principal-keys/public",
                        algorithm="ES256",
                    )


@pytest.mark.unit
def test_rate_limiting_is_enforced(vault_env):
    client = Mock()
    with patch.dict(os.environ, vault_env, clear=True):
        vault = CaracalVault(client=client, rate_limit=2)

    with patch.object(vault, "_ensure_service_health", return_value=None):
        with patch.object(vault, "_secret_exists", return_value=False):
            with patch.object(vault, "_upsert_secret", return_value="entry"):
                with gateway_context():
                    vault.put("org-1", "env-1", "k1", "v1")
                    vault.put("org-1", "env-1", "k2", "v2")
                    with pytest.raises(VaultRateLimitExceeded, match="rate limit exceeded"):
                        vault.put("org-1", "env-1", "k3", "v3")


@pytest.mark.unit
def test_rotate_master_key_requires_configured_endpoint(vault):
    with patch("caracal.core.vault._read_env_or_dotenv", return_value=""):
        with gateway_context():
            with pytest.raises(VaultError, match="rotation endpoint is not configured"):
                vault.rotate_master_key("org-1", "env-1", actor="cli")


@pytest.mark.unit
def test_rotate_master_key_success(vault):
    response = FakeResponse(
        status_code=200,
        payload={"secrets_rotated": 3, "secrets_failed": 0, "new_key_version": 4},
    )
    with patch("caracal.core.vault._read_env_or_dotenv", return_value="/api/v4/rotate"):
        with patch.object(vault, "_request", return_value=response):
            with gateway_context():
                result = vault.rotate_master_key("org-1", "env-1", actor="cli")

    assert isinstance(result, RotationResult)
    assert result.secrets_rotated == 3
    assert result.secrets_failed == 0
    assert result.new_key_version == 4


@pytest.mark.unit
def test_drain_audit_events_clears_buffer(vault):
    with patch.object(vault, "_secret_exists", return_value=False):
        with patch.object(vault, "_upsert_secret", return_value="entry-1"):
            with gateway_context():
                vault.put("org-1", "env-1", "k", "v")

    events = vault.drain_audit_events()
    assert len(events) >= 1
    assert all(isinstance(event, VaultAuditEvent) for event in events)
    assert vault.drain_audit_events() == []
