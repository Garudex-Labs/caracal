"""Unit tests for unified session manager flows."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
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


class _InMemoryDenylist:
    """Simple deny-list backend for unit tests."""

    def __init__(self) -> None:
        self._blocked: set[str] = set()

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        del expires_at
        self._blocked.add(token_jti)

    async def contains(self, token_jti: str) -> bool:
        return token_jti in self._blocked


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
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-1",
        organization_id="org-1",
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
    manager = SessionManager(signing_key=TEST_SIGNING_KEY, verify_key=TEST_VERIFY_KEY)

    issued = manager.issue_session(
        subject_id="user-2",
        organization_id="org-2",
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
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-3",
        organization_id="org-3",
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
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    issued = manager.issue_session(
        subject_id="user-4",
        organization_id="org-4",
        tenant_id="tenant-4",
        session_kind=SessionKind.INTERACTIVE,
    )

    await manager.revoke_token(issued.access_token)

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(issued.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_issue_task_token_is_short_lived_and_has_no_refresh_token() -> None:
    manager = SessionManager(signing_key=TEST_SIGNING_KEY, verify_key=TEST_VERIFY_KEY)
    parent = manager.issue_session(
        subject_id="user-5",
        organization_id="org-5",
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
    manager = SessionManager(signing_key=TEST_SIGNING_KEY, verify_key=TEST_VERIFY_KEY)
    parent = manager.issue_session(
        subject_id="user-6",
        organization_id="org-6",
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
    manager = SessionManager(signing_key=TEST_SIGNING_KEY, verify_key=TEST_VERIFY_KEY)
    parent = manager.issue_session(
        subject_id="user-7",
        organization_id="org-7",
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
async def test_handoff_token_is_one_time_and_transfers_task_scope() -> None:
    denylist = _InMemoryDenylist()
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    source = manager.issue_session(
        subject_id="worker-a",
        organization_id="org-8",
        tenant_id="tenant-8",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["provider:openai"]},
    )

    handoff = manager.issue_handoff_token(
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
async def test_handoff_consumption_revokes_source_token_jti() -> None:
    denylist = _InMemoryDenylist()
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
    )

    source = manager.issue_session(
        subject_id="worker-c",
        organization_id="org-9",
        tenant_id="tenant-9",
        session_kind=SessionKind.TASK,
        include_refresh=False,
        extra_claims={"task_token": True, "task_caveats": ["action:infer"]},
    )

    handoff = manager.issue_handoff_token(
        source_access_token=source.access_token,
        target_subject_id="worker-d",
        caveats=["action:infer"],
    )

    await manager.consume_handoff_token(handoff)

    with pytest.raises(SessionRevokedError):
        await manager.validate_access_token(source.access_token)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_task_and_handoff_emit_audit_events() -> None:
    denylist = _InMemoryDenylist()
    audit_sink = _RecordingAuditSink()
    manager = SessionManager(
        signing_key=TEST_SIGNING_KEY,
        verify_key=TEST_VERIFY_KEY,
        denylist_backend=denylist,
        audit_sink=audit_sink,
    )

    source = manager.issue_session(
        subject_id="worker-e",
        organization_id="org-10",
        tenant_id="tenant-10",
        session_kind=SessionKind.AUTOMATION,
    )
    task = manager.issue_task_token(
        parent_access_token=source.access_token,
        task_id="task-audit-1",
        caveats=["provider:openai"],
    )
    handoff = manager.issue_handoff_token(
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
def test_session_manager_rejects_symmetric_algorithms() -> None:
    with pytest.raises(SessionError, match="Symmetric session signing algorithms"):
        SessionManager(signing_key=TEST_SIGNING_KEY, algorithm="HS256")