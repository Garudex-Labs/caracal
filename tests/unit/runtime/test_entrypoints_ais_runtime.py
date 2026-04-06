"""Unit tests for AIS runtime lifecycle wiring in runtime entrypoints."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from caracal.identity.ais_server import (
    AISServerConfig,
    RefreshRequest,
    SpawnRequest,
    TokenIssueRequest,
    create_ais_app,
)
from caracal.identity.attestation_nonce import (
    AttestationNonceConsumedError,
    AttestationNonceValidationError,
)
from caracal.runtime import entrypoints


class _OpenSourceEditionManager:
    def get_edition(self):
        return "opensource"

    def resolve_revocation_publisher_mode(self, *, explicit_mode: str = "") -> str:
        if explicit_mode:
            if explicit_mode in {"redis", "enterprise_webhook"}:
                return explicit_mode
            raise RuntimeError("invalid revocation publisher mode")
        return "redis"


class _EnterpriseEditionManager:
    def get_edition(self):
        from caracal.deployment.edition import Edition

        return Edition.ENTERPRISE

    def get_gateway_url(self) -> str:
        return "https://enterprise.example"

    def resolve_revocation_publisher_mode(self, *, explicit_mode: str = "") -> str:
        if explicit_mode:
            if explicit_mode in {"redis", "enterprise_webhook"}:
                return explicit_mode
            raise RuntimeError("invalid revocation publisher mode")
        return "enterprise_webhook"

    def resolve_enterprise_revocation_target(
        self,
        *,
        webhook_url_override: str | None = None,
        sync_api_key_override: str | None = None,
    ) -> tuple[str, str]:
        webhook_url = webhook_url_override or "https://enterprise.example/api/sync/revocation-events"
        if not sync_api_key_override:
            raise RuntimeError(entrypoints.AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV)
        return webhook_url, sync_api_key_override


@dataclass
class _FakeAisProcess:
    poll_values: list[int | None]

    def __post_init__(self) -> None:
        self._index = 0

    def poll(self) -> int | None:
        if self._index >= len(self.poll_values):
            return self.poll_values[-1] if self.poll_values else None
        value = self.poll_values[self._index]
        self._index += 1
        return value


@dataclass
class _FakeMcpProcess:
    poll_values: list[int | None]

    def __post_init__(self) -> None:
        self._index = 0

    def poll(self) -> int | None:
        if self._index >= len(self.poll_values):
            return self.poll_values[-1] if self.poll_values else 0
        value = self.poll_values[self._index]
        self._index += 1
        return value


@dataclass
class _FakeIssuedSession:
    access_token: str
    access_expires_at: datetime
    session_id: str
    token_jti: str
    refresh_token: str | None = None
    refresh_expires_at: datetime | None = None
    refresh_jti: str | None = None


class _FakeSessionManager:
    def __init__(self) -> None:
        self.issue_calls: list[dict[str, object]] = []
        self.refresh_calls: list[str] = []

    def issue_session(self, **kwargs):
        self.issue_calls.append(kwargs)
        now = datetime.now(timezone.utc)
        return _FakeIssuedSession(
            access_token="access-1",
            access_expires_at=now + timedelta(minutes=5),
            session_id="sid-1",
            token_jti="jti-1",
            refresh_token="refresh-1",
            refresh_expires_at=now + timedelta(minutes=30),
            refresh_jti="rjti-1",
        )

    async def refresh_session(self, refresh_token: str):
        self.refresh_calls.append(refresh_token)
        now = datetime.now(timezone.utc)
        return _FakeIssuedSession(
            access_token="access-2",
            access_expires_at=now + timedelta(minutes=5),
            session_id="sid-2",
            token_jti="jti-2",
            refresh_token="refresh-2",
            refresh_expires_at=now + timedelta(minutes=30),
            refresh_jti="rjti-2",
        )


class _FakeDbManager:
    @contextmanager
    def session_scope(self):
        yield object()


@pytest.mark.unit
def test_run_ais_server_fails_when_startup_license_gate_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("enterprise license invalid")

    monkeypatch.setattr("caracal.deployment.edition_adapter.get_deployment_edition_adapter", _raise)

    assert entrypoints._run_ais_server() == 1


class _FakePrincipalQuery:
    def __init__(self, principal: object | None) -> None:
        self._principal = principal

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._principal


@pytest.mark.unit
def test_consume_ais_startup_attestation_requires_nonce(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(entrypoints.AIS_STARTUP_NONCE_ENV, raising=False)

    with pytest.raises(RuntimeError, match=entrypoints.AIS_STARTUP_NONCE_ENV):
        entrypoints._consume_ais_startup_attestation(
            nonce_manager_factory=lambda: object(),
        )


@pytest.mark.unit
def test_consume_ais_startup_attestation_rejects_consumed_nonce(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Manager:
        def consume_nonce(self, nonce: str, *, expected_principal_id: str | None = None) -> str:
            raise AttestationNonceConsumedError("missing")

    monkeypatch.setenv(entrypoints.AIS_STARTUP_NONCE_ENV, "nonce-1")

    with pytest.raises(RuntimeError, match="invalid or already consumed"):
        entrypoints._consume_ais_startup_attestation(
            nonce_manager_factory=lambda: _Manager(),
        )


@pytest.mark.unit
def test_consume_ais_startup_attestation_rejects_expired_or_invalid_nonce(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Manager:
        def consume_nonce(self, nonce: str, *, expected_principal_id: str | None = None) -> str:
            raise AttestationNonceValidationError("expired")

    monkeypatch.setenv(entrypoints.AIS_STARTUP_NONCE_ENV, "nonce-expired")

    with pytest.raises(RuntimeError, match="invalid or already consumed"):
        entrypoints._consume_ais_startup_attestation(
            nonce_manager_factory=lambda: _Manager(),
        )


@pytest.mark.unit
def test_consume_ais_startup_attestation_passes_expected_principal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, str | None] = {}

    class _Manager:
        def consume_nonce(self, nonce: str, *, expected_principal_id: str | None = None) -> str:
            seen["nonce"] = nonce
            seen["expected"] = expected_principal_id
            return "principal-1"

    monkeypatch.setenv(entrypoints.AIS_STARTUP_NONCE_ENV, "nonce-2")
    monkeypatch.setenv(entrypoints.AIS_STARTUP_PRINCIPAL_ENV, "principal-1")

    principal_id = entrypoints._consume_ais_startup_attestation(
        nonce_manager_factory=lambda: _Manager(),
    )

    assert principal_id == "principal-1"
    assert seen == {"nonce": "nonce-2", "expected": "principal-1"}


@pytest.mark.unit
def test_run_local_caracal_routes_runtime_mcp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(entrypoints, "_run_runtime_mcp", lambda: 17)

    with pytest.raises(SystemExit) as exc_info:
        entrypoints._run_local_caracal(("runtime-mcp",))

    assert int(exc_info.value.code) == 17


@pytest.mark.unit
def test_run_local_caracal_routes_ais_serve(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(entrypoints, "_run_ais_server", lambda: 9)

    with pytest.raises(SystemExit) as exc_info:
        entrypoints._run_local_caracal(("ais-serve",))

    assert int(exc_info.value.code) == 9


@pytest.mark.unit
def test_wait_for_ais_healthy_returns_true_after_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    checks = iter([False, True])

    monkeypatch.setattr(entrypoints, "_check_ais_health", lambda *_args, **_kwargs: next(checks))
    monkeypatch.setattr(entrypoints.time, "sleep", lambda *_args, **_kwargs: None)

    assert entrypoints._wait_for_ais_healthy(object(), timeout_seconds=2, probe_timeout_seconds=0.1)


@pytest.mark.unit
def test_run_runtime_mcp_restarts_ais_when_unhealthy(monkeypatch: pytest.MonkeyPatch) -> None:
    ais_processes = [
        _FakeAisProcess([None, None, None]),
        _FakeAisProcess([None, None]),
    ]
    mcp_process = _FakeMcpProcess([None, 0])
    started: list[_FakeAisProcess] = []
    terminated: list[object] = []
    health_checks = iter([False])

    monkeypatch.setattr(entrypoints, "assert_runtime_hardcut", lambda **_kwargs: None)
    monkeypatch.setattr(entrypoints, "_bootstrap_runtime_vault_refs", lambda: None)
    monkeypatch.setattr(entrypoints, "_create_ais_server_config", lambda: object())
    monkeypatch.setattr(entrypoints, "_wait_for_ais_healthy", lambda *_args, **_kwargs: True)

    def _start_ais() -> _FakeAisProcess:
        process = ais_processes[len(started)]
        started.append(process)
        return process

    monkeypatch.setattr(entrypoints, "_start_ais_subprocess", _start_ais)
    monkeypatch.setattr(entrypoints.subprocess, "Popen", lambda *_args, **_kwargs: mcp_process)
    monkeypatch.setattr(
        entrypoints,
        "_check_ais_health",
        lambda *_args, **_kwargs: next(health_checks, True),
    )
    monkeypatch.setattr(entrypoints, "_terminate_subprocess", lambda process: terminated.append(process))
    monkeypatch.setattr(entrypoints.time, "sleep", lambda *_args, **_kwargs: None)

    exit_code = entrypoints._run_runtime_mcp()

    assert exit_code == 0
    assert len(started) == 2
    assert ais_processes[0] in terminated
    assert ais_processes[1] in terminated


@pytest.mark.unit
def test_run_runtime_mcp_bootstraps_vault_refs_before_starting_ais(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    ais_process = _FakeAisProcess([None])
    mcp_process = _FakeMcpProcess([0])

    monkeypatch.setattr(entrypoints, "assert_runtime_hardcut", lambda **_kwargs: calls.append("preflight"))
    monkeypatch.setattr(entrypoints, "_bootstrap_runtime_vault_refs", lambda: calls.append("bootstrap"))
    monkeypatch.setattr(entrypoints, "_create_ais_server_config", lambda: object())
    monkeypatch.setattr(entrypoints, "_start_ais_subprocess", lambda: ais_process)
    monkeypatch.setattr(entrypoints, "_wait_for_ais_healthy", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(entrypoints.subprocess, "Popen", lambda *_args, **_kwargs: mcp_process)
    monkeypatch.setattr(entrypoints, "_terminate_subprocess", lambda *_args, **_kwargs: None)

    exit_code = entrypoints._run_runtime_mcp()

    assert exit_code == 0
    assert calls[:2] == ["preflight", "bootstrap"]


@pytest.mark.unit
def test_create_ais_session_manager_uses_vault_reference_signer_without_loading_private_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolved_refs: list[str] = []

    monkeypatch.setenv(entrypoints.AIS_SESSION_SIGNING_KEY_REF_ENV, "keys/session-private")
    monkeypatch.setenv(entrypoints.AIS_SESSION_VERIFY_KEY_REF_ENV, "keys/session-public")
    monkeypatch.setenv(entrypoints.AIS_SESSION_CAVEAT_MODE_ENV, "jwt")
    monkeypatch.delenv(entrypoints.AIS_SESSION_CAVEAT_HMAC_KEY_ENV, raising=False)
    monkeypatch.setattr(entrypoints, "_create_ais_db_manager", lambda: object())

    def _resolve_secret(secret_ref: str) -> str:
        resolved_refs.append(secret_ref)
        return "verify-key-pem"

    monkeypatch.setattr(entrypoints, "_resolve_ais_vault_secret", _resolve_secret)

    manager = entrypoints._create_ais_session_manager()

    assert resolved_refs == ["keys/session-public"]
    assert manager._algorithm == "RS256"
    assert manager._token_signer.__class__.__name__ == "VaultReferenceJwtSigner"
    assert manager._token_signer._key_name == "keys/session-private"


@pytest.mark.unit
def test_create_ais_session_manager_requires_explicit_caveat_hmac_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(entrypoints.AIS_SESSION_SIGNING_KEY_REF_ENV, "keys/session-private")
    monkeypatch.setenv(entrypoints.AIS_SESSION_VERIFY_KEY_REF_ENV, "keys/session-public")
    monkeypatch.setenv(entrypoints.AIS_SESSION_CAVEAT_MODE_ENV, "caveat_chain")
    monkeypatch.delenv(entrypoints.AIS_SESSION_CAVEAT_HMAC_KEY_ENV, raising=False)
    monkeypatch.setattr(entrypoints, "_resolve_ais_vault_secret", lambda _ref: "verify-key-pem")

    with pytest.raises(RuntimeError, match=entrypoints.AIS_SESSION_CAVEAT_HMAC_KEY_ENV):
        entrypoints._create_ais_session_manager()


@pytest.mark.unit
def test_resolve_session_signing_algorithm_ignores_legacy_alias_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(entrypoints.AIS_SESSION_ALGORITHM_ENV, raising=False)
    monkeypatch.setenv("CARACAL_SESSION_JWT_ALGORITHM", "ES256")

    assert entrypoints._resolve_session_signing_algorithm() == "RS256"


@pytest.mark.unit
def test_resolve_session_signing_algorithm_uses_canonical_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(entrypoints.AIS_SESSION_ALGORITHM_ENV, "es256")
    monkeypatch.setenv("CARACAL_SESSION_JWT_ALGORITHM", "RS256")

    assert entrypoints._resolve_session_signing_algorithm() == "ES256"


@pytest.mark.unit
def test_host_up_runs_preflight_with_resolved_compose(monkeypatch: pytest.MonkeyPatch) -> None:
    compose_file = Path("/tmp/docker-compose.image.yml")
    captured: dict[str, object] = {}

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda _override=None: compose_file)
    monkeypatch.setattr(
        entrypoints,
        "assert_runtime_hardcut",
        lambda **kwargs: captured.update(kwargs),
    )
    monkeypatch.setattr(entrypoints, "_runtime_database_url_candidates", lambda: ["postgresql://runtime-db"])
    monkeypatch.setattr(entrypoints, "_caracal_home_dir", lambda: Path("/tmp/caracal-runtime"))
    monkeypatch.setattr(entrypoints, "_runtime_hardcut_env", lambda: {"CARACAL_HARDCUT_MODE": "1"})
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _compose: ["docker", "compose"])
    monkeypatch.setattr(entrypoints, "_service_uses_local_build", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(entrypoints.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=0))

    exit_code = entrypoints._host_up(SimpleNamespace(compose_file=None, no_pull=True))

    assert exit_code == 0
    assert captured["compose_file"] == compose_file
    assert captured["database_urls"] == ["postgresql://runtime-db"]
    assert captured["state_roots"] == [Path("/tmp/caracal-runtime")]
    assert captured["env_vars"] == {"CARACAL_HARDCUT_MODE": "1"}


@pytest.mark.unit
def test_host_flow_runs_preflight_with_resolved_compose(monkeypatch: pytest.MonkeyPatch) -> None:
    compose_file = Path("/tmp/docker-compose.image.yml")
    captured: dict[str, object] = {}
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda _override=None: compose_file)
    monkeypatch.setattr(
        entrypoints,
        "assert_runtime_hardcut",
        lambda **kwargs: captured.update(kwargs),
    )
    monkeypatch.setattr(entrypoints, "_runtime_database_url_candidates", lambda: ["postgresql://runtime-db"])
    monkeypatch.setattr(entrypoints, "_caracal_home_dir", lambda: Path("/tmp/caracal-runtime"))
    monkeypatch.setattr(entrypoints, "_runtime_hardcut_env", lambda: {"CARACAL_HARDCUT_MODE": "1"})
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _compose: ["docker", "compose"])
    monkeypatch.setattr(entrypoints, "_service_uses_local_build", lambda *_args, **_kwargs: False)

    def _run(cmd, **_kwargs):
        commands.append(cmd)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _run)

    exit_code = entrypoints._host_flow(SimpleNamespace(compose_file=None))

    assert exit_code == 0
    assert captured["compose_file"] == compose_file
    assert captured["database_urls"] == ["postgresql://runtime-db"]
    assert captured["state_roots"] == [Path("/tmp/caracal-runtime")]
    assert captured["env_vars"] == {"CARACAL_HARDCUT_MODE": "1"}
    assert ["docker", "compose", "up", "-d", "postgres", "redis", "vault"] in commands


@pytest.mark.unit
def test_build_ais_handlers_issues_and_refreshes_tokens() -> None:
    session_manager = _FakeSessionManager()
    handlers = entrypoints._build_ais_handlers(
        db_manager=_FakeDbManager(),
        session_manager=session_manager,
        redis_client=object(),
    )

    token_response = handlers.issue_token(
        TokenIssueRequest(
            principal_id="principal-1",
            organization_id="org-1",
            tenant_id="tenant-1",
            session_kind="automation",
            include_refresh=True,
        )
    )

    assert token_response["access_token"] == "access-1"
    assert token_response["refresh_token"] == "refresh-1"
    assert token_response["expires_at"] == token_response["access_expires_at"]
    assert session_manager.issue_calls
    assert str(session_manager.issue_calls[0]["session_kind"]) == "SessionKind.AUTOMATION"

    refresh_response = handlers.refresh_session(RefreshRequest(refresh_token="refresh-1"))
    assert refresh_response["access_token"] == "access-2"
    assert session_manager.refresh_calls == ["refresh-1"]


@pytest.mark.unit
def test_build_ais_handlers_rejects_unknown_session_kind() -> None:
    handlers = entrypoints._build_ais_handlers(
        db_manager=_FakeDbManager(),
        session_manager=_FakeSessionManager(),
        redis_client=object(),
    )

    with pytest.raises(HTTPException) as exc_info:
        handlers.issue_token(
            TokenIssueRequest(
                principal_id="principal-1",
                organization_id="org-1",
                tenant_id="tenant-1",
                session_kind="not-a-kind",
            )
        )

    assert exc_info.value.status_code == 400


@pytest.mark.unit
def test_build_ais_handlers_token_endpoint_returns_bundle_over_http() -> None:
    handlers = entrypoints._build_ais_handlers(
        db_manager=_FakeDbManager(),
        session_manager=_FakeSessionManager(),
        redis_client=object(),
    )
    app = create_ais_app(
        handlers,
        AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", listen_port=7079),
    )
    client = TestClient(app)

    response = client.post(
        "/v1/ais/token",
        json=TokenIssueRequest(
            principal_id="principal-1",
            organization_id="org-1",
            tenant_id="tenant-1",
            session_kind="automation",
            include_refresh=True,
        ).model_dump(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["access_token"] == "access-1"
    assert payload["refresh_token"] == "refresh-1"
    assert payload["session_id"] == "sid-1"


@pytest.mark.unit
def test_build_ais_handlers_spawn_response_includes_metadata_without_private_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FakePrincipalRegistry:
        def __init__(self, session: object) -> None:
            self.session = session

    class _FakeAttestationNonceManager:
        def __init__(self, redis_client: object) -> None:
            self.redis_client = redis_client

    class _FakeSpawnManager:
        def __init__(
            self,
            session: object,
            attestation_nonce_manager: object | None = None,
            principal_ttl_manager: object | None = None,
        ) -> None:
            self.session = session
            self.attestation_nonce_manager = attestation_nonce_manager
            self.principal_ttl_manager = principal_ttl_manager

    class _FakeIdentityService:
        def __init__(self, *, principal_registry: object, spawn_manager: object | None = None) -> None:
            self.principal_registry = principal_registry
            self.spawn_manager = spawn_manager

        def spawn_principal(self, **kwargs):
            return SimpleNamespace(
                principal_id="principal-spawned",
                principal_name=kwargs["principal_name"],
                principal_kind=kwargs["principal_kind"],
                mandate_id="mandate-1",
                attestation_bootstrap_artifact="attest-bootstrap:principal-spawned",
                attestation_nonce="nonce-1",
                idempotent_replay=False,
                private_key_pem="must-not-leak",
            )

    monkeypatch.setattr("caracal.core.identity.PrincipalRegistry", _FakePrincipalRegistry)
    monkeypatch.setattr("caracal.core.spawn.SpawnManager", _FakeSpawnManager)
    monkeypatch.setattr("caracal.identity.attestation_nonce.AttestationNonceManager", _FakeAttestationNonceManager)
    monkeypatch.setattr("caracal.identity.service.IdentityService", _FakeIdentityService)

    handlers = entrypoints._build_ais_handlers(
        db_manager=_FakeDbManager(),
        session_manager=_FakeSessionManager(),
        redis_client=object(),
    )

    response = handlers.spawn_principal(
        SpawnRequest(
            issuer_principal_id="issuer-1",
            principal_name="worker-1",
            principal_kind="worker",
            owner="ops",
            resource_scope=["provider:openai"],
            action_scope=["infer"],
            validity_seconds=300,
            idempotency_key="idemp-1",
        )
    )

    assert response["principal_id"] == "principal-spawned"
    assert response["mandate_id"] == "mandate-1"
    assert response["attestation_bootstrap_artifact"] == "attest-bootstrap:principal-spawned"
    assert response["attestation_nonce"] == "nonce-1"
    assert "private_key_pem" not in response
    assert "public_key_pem" not in response
    assert "access_token" not in response
    assert "refresh_token" not in response
    assert all("private_key" not in key for key in response.keys())


@pytest.mark.unit
def test_reconcile_principal_ttl_expiries_processes_and_acknowledges_work_items() -> None:
    work_items = [SimpleNamespace(principal_id="p-1"), SimpleNamespace(principal_id="p-2")]
    processed: list[str] = []
    acknowledged: list[str] = []

    class _FakePrincipalTTLManager:
        def reconcile_expired_principals(self):
            return list(work_items)

        def ack_expired_work_item(self, work_item: object) -> None:
            acknowledged.append(getattr(work_item, "principal_id"))

    class _FakeExpiryProcessor:
        def process(self, work_item: object) -> None:
            processed.append(getattr(work_item, "principal_id"))

    count = entrypoints._reconcile_principal_ttl_expiries(
        principal_ttl_manager=_FakePrincipalTTLManager(),
        expiry_processor=_FakeExpiryProcessor(),
    )

    assert count == 2
    assert processed == ["p-1", "p-2"]
    assert acknowledged == ["p-1", "p-2"]


@pytest.mark.unit
def test_run_principal_ttl_listener_claims_messages_and_processes_items() -> None:
    processed: list[str] = []
    acknowledged: list[str] = []
    stop_event = entrypoints.threading.Event()

    class _FakePrincipalTTLManager:
        def iter_expiry_messages(self, *, poll_timeout_seconds: float = 1.0):
            del poll_timeout_seconds
            yield {"data": "caracal:identity:principal_ttl:p-1"}

        def claim_expiry_message(self, message: dict):
            stop_event.set()
            return SimpleNamespace(principal_id=message["data"].rsplit(":", 1)[-1])

        def ack_expired_work_item(self, work_item: object) -> None:
            acknowledged.append(getattr(work_item, "principal_id"))

    class _FakeExpiryProcessor:
        def process(self, work_item: object) -> None:
            processed.append(getattr(work_item, "principal_id"))

    entrypoints._run_principal_ttl_listener(
        principal_ttl_manager=_FakePrincipalTTLManager(),
        expiry_processor=_FakeExpiryProcessor(),
        stop_event=stop_event,
    )

    assert processed == ["p-1"]
    assert acknowledged == ["p-1"]


@pytest.mark.unit
def test_complete_ais_startup_attestation_marks_attested_and_transitions_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    principal_id = str(uuid4())
    principal = SimpleNamespace(
        principal_id=principal_id,
        principal_kind="worker",
        lifecycle_status="pending_attestation",
        attestation_status="pending",
        principal_metadata={},
    )

    class _FakeSession:
        def query(self, *_args, **_kwargs):
            return _FakePrincipalQuery(principal)

        def flush(self) -> None:
            return None

    transitions: list[tuple[str, str, str | None]] = []
    activated: list[str] = []

    def _transition(self, principal_id: str, target_status: str, actor_principal_id: str | None = None):
        transitions.append((principal_id, target_status, actor_principal_id))

    monkeypatch.setattr("caracal.core.identity.PrincipalRegistry.transition_lifecycle_status", _transition)

    class _FakeDbManagerLocal:
        @contextmanager
        def session_scope(self):
            yield _FakeSession()

    class _FakePrincipalTTLManager:
        def activate_principal(self, resolved_principal_id: str) -> None:
            activated.append(resolved_principal_id)

    entrypoints._complete_ais_startup_attestation(
        principal_id,
        db_manager=_FakeDbManagerLocal(),
        principal_ttl_manager=_FakePrincipalTTLManager(),
    )

    assert principal.attestation_status == "attested"
    assert principal.principal_metadata["attestation_status"] == "attested"
    assert "attested_at" in principal.principal_metadata
    assert activated == [principal_id]
    assert transitions == [(principal_id, "active", principal_id)]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_runtime_revocation_event_publisher_uses_configured_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[tuple[str, str]] = []

    class _FakeRedis:
        def publish(self, channel: str, message: str) -> int:
            published.append((channel, message))
            return 1

    monkeypatch.setenv(entrypoints.AIS_REVOCATION_EVENTS_CHANNEL_ENV, "caracal:revocation:runtime")
    publisher = entrypoints._create_runtime_revocation_event_publisher(
        redis_client=_FakeRedis(),
        edition_manager=_OpenSourceEditionManager(),
    )

    await publisher.publish_principal_revocation_event(
        event_type="principal_revoked",
        principal_id="principal-1",
        reason="ttl_expired",
        actor_principal_id="principal-1",
        root_principal_id="principal-1",
        revoked_mandate_ids=["m-1"],
        metadata={"source": "runtime"},
    )

    assert len(published) == 1
    channel, payload = published[0]
    parsed = json.loads(payload)
    assert channel == "caracal:revocation:runtime"
    assert parsed["event_type"] == "principal_revoked"
    assert parsed["metadata"] == {"source": "runtime"}


@pytest.mark.unit
def test_create_ttl_revocation_orchestrator_factory_assigns_publisher() -> None:
    class _FakeRedis:
        def publish(self, channel: str, message: str) -> int:
            del channel, message
            return 1

    orchestrator_factory = entrypoints._create_ttl_revocation_orchestrator_factory(
        redis_client=_FakeRedis(),
        edition_manager=_OpenSourceEditionManager(),
    )
    orchestrator = orchestrator_factory(SimpleNamespace())

    assert orchestrator.revocation_event_publisher is not None


@pytest.mark.unit
def test_create_runtime_revocation_event_publisher_uses_enterprise_webhook_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        entrypoints.AIS_ENTERPRISE_REVOCATION_WEBHOOK_URL_ENV,
        "https://enterprise.example/custom-revocations",
    )
    monkeypatch.setenv(entrypoints.AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV, "sync-key-1")

    publisher = entrypoints._create_runtime_revocation_event_publisher(
        edition_manager=_EnterpriseEditionManager(),
    )

    assert publisher.__class__.__name__ == "EnterpriseWebhookRevocationEventPublisher"


@pytest.mark.unit
def test_create_runtime_revocation_event_publisher_requires_sync_key_in_enterprise_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        entrypoints.AIS_ENTERPRISE_REVOCATION_WEBHOOK_URL_ENV,
        "https://enterprise.example/custom-revocations",
    )
    monkeypatch.delenv(entrypoints.AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV, raising=False)

    with pytest.raises(RuntimeError, match=entrypoints.AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV):
        entrypoints._create_runtime_revocation_event_publisher(
            edition_manager=_EnterpriseEditionManager(),
        )


@pytest.mark.unit
def test_resolve_runtime_revocation_publisher_mode_does_not_fallback_on_adapter_errors() -> None:
    class _BrokenEditionManager:
        def resolve_revocation_publisher_mode(self, *, explicit_mode: str = "") -> str:
            del explicit_mode
            raise RuntimeError("adapter resolution failed")

    with pytest.raises(RuntimeError, match="adapter resolution failed"):
        entrypoints._resolve_runtime_revocation_publisher_mode(
            edition_manager=_BrokenEditionManager(),
        )
