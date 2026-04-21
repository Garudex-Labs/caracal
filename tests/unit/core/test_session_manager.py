"""Unit tests for unified session manager flows."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from caracal.core.session_manager import (
    SessionKind,
    SessionError,
    SessionManager,
    SessionRevokedError,
    SessionValidationError,
)


def _generate_rsa_key_pair() -> tuple[str, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return private_pem, public_pem


TEST_SIGNING_KEY, TEST_VERIFY_KEY = _generate_rsa_key_pair()


class _StaticJwtSigner:
    def __init__(self, signing_key: str) -> None:
        self._signing_key = signing_key

    def sign_token(self, *, claims: dict, algorithm: str) -> str:
        return jwt.encode(claims, self._signing_key, algorithm=algorithm)


def _create_manager(**kwargs) -> SessionManager:
    signing_key = kwargs.pop("signing_key", TEST_SIGNING_KEY)
    if "verify_key" not in kwargs and "verify_key_provider" not in kwargs:
        kwargs["verify_key"] = TEST_VERIFY_KEY
    return SessionManager(
        token_signer=_StaticJwtSigner(signing_key),
        **kwargs,
    )


class _InMemoryDenylist:
    """Simple deny-list backend for unit tests."""

    def __init__(self) -> None:
        self._blocked: set[str] = set()
        self._principal_revoked_after: dict[str, int] = {}

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        del expires_at
        self._blocked.add(token_jti)

    async def contains(self, token_jti: str) -> bool:
        return token_jti in self._blocked

    async def mark_principal_revoked(self, principal_id: str, revoked_at: datetime) -> None:
        revoked_value = revoked_at if revoked_at.tzinfo else revoked_at.replace(tzinfo=timezone.utc)
        self._principal_revoked_after[principal_id] = int(revoked_value.timestamp())

    async def is_principal_revoked(
        self,
        principal_id: str,
        token_auth_time: datetime | int | float | str | None,
    ) -> bool:
        if principal_id not in self._principal_revoked_after:
            return False
        if token_auth_time is None:
            return False
        if isinstance(token_auth_time, datetime):
            token_auth_ts = int(
                (
                    token_auth_time
                    if token_auth_time.tzinfo
                    else token_auth_time.replace(tzinfo=timezone.utc)
                ).timestamp()
            )
        elif isinstance(token_auth_time, str):
            token_auth_ts = int(float(token_auth_time))
        else:
            token_auth_ts = int(token_auth_time)
        return token_auth_ts <= self._principal_revoked_after[principal_id]


class _RecordingAuditSink:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def record_event(self, *, event_type: str, principal_id: str, metadata: dict | None = None) -> None:
        self.events.append(
            {
                "event_type": event_type,
                "principal_id": principal_id,
                "metadata": metadata or {},
            }
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_issue_and_validate_access_token() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-1",
        workspace_id="org-1",
        tenant_id="tenant-1",
        session_kind=SessionKind.INTERACTIVE,
        extra_claims={"role": "admin"},
    )

    claims = await manager.validate_access_token(issued.access_token)
    assert claims["sub"] == "user-1"
    assert claims["org"] == "org-1"
    assert claims["tenant"] == "tenant-1"
    assert claims["kind"] == SessionKind.INTERACTIVE.value
    assert claims["typ"] == "access"
    assert claims["sid"] == issued.session_id
    assert claims["jti"] == issued.token_jti
    assert claims["role"] == "admin"
    assert issued.refresh_token is not None
    assert issued.refresh_jti is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_validate_access_token_enforces_session_kind() -> None:
    manager = _create_manager()

    issued = manager.issue_session(
        subject_id="user-2",
        workspace_id="org-2",
        tenant_id="tenant-2",
        session_kind=SessionKind.TASK,
    )

    with pytest.raises(SessionValidationError):
        await manager.validate_access_token(
            issued.access_token,
            required_kinds={SessionKind.INTERACTIVE, SessionKind.AUTOMATION},
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_refresh_session_rotates_refresh_token_and_revokes_old() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-3",
        workspace_id="org-3",
        tenant_id="tenant-3",
        session_kind=SessionKind.AUTOMATION,
    )
    assert issued.refresh_token is not None

    refreshed = await manager.refresh_session(issued.refresh_token)

    assert refreshed.access_token != issued.access_token
    assert refreshed.refresh_token is not None
    assert refreshed.refresh_token != issued.refresh_token

    with pytest.raises(SessionRevokedError):
        await manager.validate_refresh_token(issued.refresh_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_access_token_blocks_future_validation() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-4",
        workspace_id="org-4",
        tenant_id="tenant-4",
        session_kind=SessionKind.INTERACTIVE,
    )

    await manager.revoke_token(issued.access_token)

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_validate_access_token_rejects_principal_revoked_session() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="principal-1",
        workspace_id="org-principal-1",
        tenant_id="tenant-principal-1",
        session_kind=SessionKind.INTERACTIVE,
    )

    await denylist.mark_principal_revoked("principal-1", datetime.now(timezone.utc))

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_issue_session_ignores_reserved_principal_id_extra_claim() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="subject-canonical",
        workspace_id="org-canonical",
        tenant_id="tenant-canonical",
        session_kind=SessionKind.INTERACTIVE,
        extra_claims={"principal_id": "spoofed-subject", "role": "operator"},
    )

    claims = await manager.validate_access_token(issued.access_token)
    assert claims["sub"] == "subject-canonical"
    assert claims["principal_id"] == "subject-canonical"
    assert claims["role"] == "operator"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_validate_access_token_uses_subject_when_principal_id_claim_missing() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-subject-fallback",
        workspace_id="org-subject-fallback",
        tenant_id="tenant-subject-fallback",
        session_kind=SessionKind.INTERACTIVE,
    )

    await denylist.mark_principal_revoked("user-subject-fallback", datetime.now(timezone.utc))

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_access_token_blocks_validation_without_denylist_backend() -> None:
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
    )

    issued = manager.issue_session(
        subject_id="user-4b",
        workspace_id="org-4b",
        tenant_id="tenant-4b",
        session_kind=SessionKind.INTERACTIVE,
    )

    await manager.revoke_token(issued.access_token)

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_issue_task_token_is_short_lived_and_has_no_refresh_token() -> None:
    manager = _create_manager()
    parent = manager.issue_session(
        subject_id="user-5",
        workspace_id="org-5",
        tenant_id="tenant-5",
        session_kind=SessionKind.AUTOMATION,
    )

    task = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-1",
        caveats=["provider:openai", "action:infer"],
        ttl=timedelta(minutes=30),
    )

    assert task.refresh_token is None
    assert (task.access_expires_at - datetime.now(task.access_expires_at.tzinfo)).total_seconds() <= 300

    claims = await manager.validate_task_token(task.access_token)
    assert claims["kind"] == SessionKind.TASK.value
    assert claims["task_token"] is True
    assert claims["can_delegate_task_tokens"] is False
    assert claims["task_id"] == "task-1"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_task_token_holder_cannot_issue_new_task_token() -> None:
    manager = _create_manager()
    parent = manager.issue_session(
        subject_id="user-6",
        workspace_id="org-6",
        tenant_id="tenant-6",
        session_kind=SessionKind.AUTOMATION,
    )
    task = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-2",
        caveats=["provider:openai"],
    )

    with pytest.raises(SessionValidationError, match="not allowed to issue"):
        manager.issue_task_token(
            parent_access_token=task.access_token,
            task_id="task-3",
            caveats=["provider:openai"],
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_task_token_caveats_must_be_attenuated_subset() -> None:
    manager = _create_manager()
    parent = manager.issue_session(
        subject_id="user-7",
        workspace_id="org-7",
        tenant_id="tenant-7",
        session_kind=SessionKind.AUTOMATION,
        extra_claims={"task_caveats": ["provider:openai", "action:infer"]},
    )

    child = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-4",
        caveats=["provider:openai"],
    )
    claims = await manager.validate_task_token(
        child.access_token,
        required_caveats=["provider:openai"],
    )
    assert claims["task_caveats"] == ["provider:openai"]

    with pytest.raises(SessionValidationError, match="attenuated subset"):
        manager.issue_task_token(
            parent_access_token=parent.access_token,
            task_id="task-5",
            caveats=["provider:openai", "action:infer", "resource:admin"],
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_issue_task_token_caveat_chain_mode_enforces_typed_constraints() -> None:
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        caveat_mode="caveat_chain",
        caveat_chain_hmac_key="test-caveat-chain-key",
    )
    parent = manager.issue_session(
        subject_id="user-chain-1",
        workspace_id="org-chain-1",
        tenant_id="tenant-chain-1",
        session_kind=SessionKind.AUTOMATION,
    )

    task = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-chain-1",
        caveats=["action:infer", "resource:model/*", "task-binding:task-chain-1"],
    )

    claims = await manager.validate_task_token(
        task.access_token,
        required_caveats=["action:infer"],
        required_action="infer",
        required_resource="model/gpt-4o",
        required_task_id="task-chain-1",
    )
    assert claims["task_caveats"] == [
        "action:infer",
        "resource:model/*",
        "task-binding:task-chain-1",
    ]
    assert isinstance(claims.get("task_caveat_chain"), list)
    assert len(claims["task_caveat_chain"]) == 3


@pytest.mark.unit
@pytest.mark.asyncio
async def test_validate_task_token_rejects_tampered_caveat_chain() -> None:
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        caveat_mode="caveat_chain",
        caveat_chain_hmac_key="test-caveat-chain-key",
    )
    parent = manager.issue_session(
        subject_id="user-chain-2",
        workspace_id="org-chain-2",
        tenant_id="tenant-chain-2",
        session_kind=SessionKind.AUTOMATION,
    )
    task = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-chain-2",
        caveats=["action:infer"],
    )

    tampered_claims = manager.decode_unverified(task.access_token)
    tampered_claims["task_caveat_chain"][0]["value"] = "delete"
    tampered_token = jwt.encode(tampered_claims, TEST_SIGNING_KEY, algorithm="RS256")

    with pytest.raises(SessionValidationError, match="integrity validation failed"):
        await manager.validate_task_token(tampered_token)


@pytest.mark.unit
def test_issue_task_token_jwt_caveat_mode_omits_chain_claim() -> None:
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        caveat_mode="jwt",
    )
    parent = manager.issue_session(
        subject_id="user-jwt-1",
        workspace_id="org-jwt-1",
        tenant_id="tenant-jwt-1",
        session_kind=SessionKind.AUTOMATION,
    )
    task = manager.issue_task_token(
        parent_access_token=parent.access_token,
        task_id="task-jwt-1",
        caveats=["provider:openai"],
    )

    claims = manager.decode_unverified(task.access_token)
    assert "task_caveat_chain" not in claims


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_token_is_one_time_and_transfers_task_scope() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    source = manager.issue_session(
        subject_id="worker-a",
        workspace_id="org-8",
        tenant_id="tenant-8",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["provider:openai"]},
    )

    handoff = await manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-b",
        caveats=["provider:openai"],
    )

    transferred = await manager.consume_handoff_token(handoff)
    transferred_claims = await manager.validate_task_token(transferred.access_token)
    assert transferred_claims["sub"] == "worker-b"
    assert transferred_claims["task_caveats"] == ["provider:openai"]

    with pytest.raises(SessionRevokedError):
        await manager.consume_handoff_token(handoff)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_issuance_revokes_source_token_jti_immediately() -> None:
    denylist = _InMemoryDenylist()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    source = manager.issue_session(
        subject_id="worker-c",
        workspace_id="org-9",
        tenant_id="tenant-9",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["action:infer"]},
    )

    handoff = await manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-d",
        caveats=["action:infer"],
    )

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(source.access_token)

    # Handoff consumption still succeeds once for the target principal.
    await manager.consume_handoff_token(handoff)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_revocation_check_uses_local_cache_before_db_lookup() -> None:
    denylist = _InMemoryDenylist()

    class _Session:
        def add(self, _row: object) -> None:
            return None

        def flush(self) -> None:
            return None

        def query(self, _model):
            class _Query:
                def filter(self, *_args, **_kwargs):
                    return self

                def first(self):
                    return None

            return _Query()

    class _DbManager:
        @contextmanager
        def session_scope(self):
            yield _Session()

    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
        db_session_manager=_DbManager(),
    )

    source = manager.issue_session(
        subject_id="worker-local-cache",
        workspace_id="org-local-cache",
        tenant_id="tenant-local-cache",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["action:infer"]},
    )

    await manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-target-cache",
        caveats=["action:infer"],
    )

    def _should_not_hit_db(_token_jti: str) -> bool:
        raise AssertionError("revocation DB lookup should not run when local revoked cache has the token")

    manager._is_token_revoked_by_handoff_store = _should_not_hit_db  # type: ignore[method-assign]

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(source.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_task_and_handoff_emit_audit_events() -> None:
    denylist = _InMemoryDenylist()
    audit_sink = _RecordingAuditSink()
    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
        audit_sink=audit_sink,
    )

    source = manager.issue_session(
        subject_id="worker-e",
        workspace_id="org-10",
        tenant_id="tenant-10",
        session_kind=SessionKind.AUTOMATION,
    )
    task = manager.issue_task_token(
        parent_access_token=source.access_token,
        task_id="task-audit-1",
        caveats=["provider:openai"],
    )
    handoff = await manager.issue_handoff_token(
        source_access_token=task.access_token,
        target_subject_id="worker-f",
        caveats=["provider:openai"],
    )
    await manager.consume_handoff_token(handoff)

    event_types = [item["event_type"] for item in audit_sink.events]
    assert "task_token_issued" in event_types
    assert "handoff_token_issued" in event_types
    assert "handoff_token_consumed" in event_types


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_issuance_persists_transactional_transfer_state() -> None:
    denylist = _InMemoryDenylist()
    added_rows: list[object] = []

    class _Session:
        def add(self, row: object) -> None:
            added_rows.append(row)

        def flush(self) -> None:
            return None

    class _DbManager:
        @contextmanager
        def session_scope(self):
            yield _Session()

    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
        db_session_manager=_DbManager(),
    )

    # This test targets transactional issuance persistence directly; query-based
    # revocation checks are covered by runtime integration paths.
    manager._is_token_revoked_by_handoff_store = lambda _jti: False  # type: ignore[method-assign]

    source = manager.issue_session(
        subject_id="worker-g",
        workspace_id="org-11",
        tenant_id="tenant-11",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["provider:openai", "action:infer"]},
    )

    handoff = await manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-h",
        caveats=["provider:openai"],
    )

    assert handoff
    assert len(added_rows) == 1
    row = added_rows[0]
    assert getattr(row, "source_subject_id") == "worker-g"
    assert getattr(row, "target_subject_id") == "worker-h"
    assert getattr(row, "transferred_caveats") == ["provider:openai"]
    assert getattr(row, "source_remaining_caveats") == ["action:infer"]
    assert getattr(row, "source_token_revoked_at") is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_transaction_failure_leaves_source_scope_unchanged() -> None:
    denylist = _InMemoryDenylist()

    class _FailingSession:
        def add(self, _row: object) -> None:
            raise RuntimeError("transaction failed")

        def flush(self) -> None:
            return None

    class _DbManager:
        @contextmanager
        def session_scope(self):
            yield _FailingSession()

    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
        db_session_manager=_DbManager(),
    )
    manager._is_token_revoked_by_handoff_store = lambda _jti: False  # type: ignore[method-assign]

    source = manager.issue_session(
        subject_id="worker-i",
        workspace_id="org-12",
        tenant_id="tenant-12",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["provider:openai"]},
    )

    with pytest.raises(RuntimeError, match="transaction failed"):
        await manager.issue_handoff_token(
            source_access_token=source.access_token,
            target_subject_id="worker-j",
            caveats=["provider:openai"],
        )

    claims = await manager.validate_access_token(source.access_token)
    assert claims["sub"] == "worker-i"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_handoff_denylist_failure_does_not_leave_partial_revocation_state() -> None:
    class _FailingDenylist(_InMemoryDenylist):
        async def add(self, token_jti: str, expires_at: datetime) -> None:
            raise AssertionError("handoff flow should not depend on denylist writes")

    added_rows: list[object] = []

    class _Session:
        def add(self, row: object) -> None:
            added_rows.append(row)

        def flush(self) -> None:
            return None

        def query(self, _model):
            class _Query:
                def filter(self, *_args, **_kwargs):
                    return self

                def first(self):
                    return None

            return _Query()

    class _DbManager:
        @contextmanager
        def session_scope(self):
            yield _Session()

    manager = _create_manager(
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=_FailingDenylist(),
        db_session_manager=_DbManager(),
    )
    manager._is_token_revoked_by_handoff_store = lambda _jti: False  # type: ignore[method-assign]

    source = manager.issue_session(
        subject_id="worker-k",
        workspace_id="org-13",
        tenant_id="tenant-13",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["provider:openai"]},
    )

    handoff = await manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-l",
        caveats=["provider:openai"],
    )

    assert handoff
    assert len(added_rows) == 1


@pytest.mark.unit
def test_session_manager_rejects_symmetric_algorithms() -> None:
    with pytest.raises(SessionError, match="Symmetric session signing algorithms"):
        _create_manager(algorithm="HS256")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_verify_key_cache_reuses_and_refreshes_provider_value() -> None:
    signing_key, verify_key = _generate_rsa_key_pair()
    provider_calls = {"count": 0}

    def provider() -> str:
        provider_calls["count"] += 1
        return verify_key

    manager = _create_manager(
        signing_key=signing_key,
        verify_key_provider=provider,
        verify_key_cache_ttl=timedelta(milliseconds=50),
    )
    issued = manager.issue_session(
        subject_id="cache-user",
        workspace_id="cache-org",
        tenant_id="cache-tenant",
        session_kind=SessionKind.INTERACTIVE,
    )

    await manager.validate_access_token(issued.access_token)
    await manager.validate_access_token(issued.access_token)
    assert provider_calls["count"] == 1

    await asyncio.sleep(0.07)
    await manager.validate_access_token(issued.access_token)
    assert provider_calls["count"] == 2


@pytest.mark.unit
@pytest.mark.asyncio
async def test_verify_key_refresh_failure_after_cache_expiry_fails_closed() -> None:
    signing_key, verify_key = _generate_rsa_key_pair()
    provider_calls = {"count": 0}

    def provider() -> str:
        provider_calls["count"] += 1
        if provider_calls["count"] == 1:
            return verify_key
        raise RuntimeError("provider unavailable")

    manager = _create_manager(
        signing_key=signing_key,
        verify_key_provider=provider,
        verify_key_cache_ttl=timedelta(milliseconds=50),
    )
    issued = manager.issue_session(
        subject_id="refresh-user",
        workspace_id="refresh-org",
        tenant_id="refresh-tenant",
        session_kind=SessionKind.INTERACTIVE,
    )

    await manager.validate_access_token(issued.access_token)
    await asyncio.sleep(0.07)

    with pytest.raises(SessionValidationError, match="refresh failed"):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_validate_access_token_rejects_mismatched_verify_key() -> None:
    signing_key, verify_key = _generate_rsa_key_pair()
    other_signing_key, other_verify_key = _generate_rsa_key_pair()

    issuing_manager = _create_manager(
        signing_key=signing_key,
        verify_key=verify_key,
    )
    validating_manager = _create_manager(
        signing_key=other_signing_key,
        verify_key=other_verify_key,
    )

    issued = issuing_manager.issue_session(
        subject_id="mismatch-user",
        workspace_id="mismatch-org",
        tenant_id="mismatch-tenant",
        session_kind=SessionKind.INTERACTIVE,
    )

    with pytest.raises(SessionValidationError, match="Session token is invalid"):
        await validating_manager.validate_access_token(issued.access_token)


@pytest.mark.unit
def test_refresh_verify_key_cache_forces_provider_reload() -> None:
    provider_calls = {"count": 0}

    def provider() -> str:
        provider_calls["count"] += 1
        return TEST_VERIFY_KEY

    manager = _create_manager(
        verify_key_provider=provider,
        verify_key_cache_ttl=timedelta(minutes=1),
    )

    manager.refresh_verify_key_cache()
    assert provider_calls["count"] == 1
