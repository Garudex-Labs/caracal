"""Unit tests for principal TTL registration, reconciliation, and expiry handling."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.db.models import PrincipalAttestationStatus, PrincipalLifecycleStatus
from caracal.identity.principal_ttl import (
    PrincipalTTLExpiryProcessor,
    PrincipalTTLLeaseExpiredError,
    PrincipalTTLManager,
)


class _FakeRedisClient:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expiry: dict[str, datetime] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.sorted_sets: dict[str, dict[str, float]] = {}

    def _purge_if_expired(self, key: str) -> None:
        expires_at = self.expiry.get(key)
        if expires_at is not None and datetime.now(timezone.utc) >= expires_at:
            self.values.pop(key, None)
            self.expiry.pop(key, None)

    def set(self, key: str, value: str, ex: int | None = None, nx: bool = False, **_kwargs) -> bool:
        self._purge_if_expired(key)
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.expiry[key] = datetime.now(timezone.utc) + timedelta(seconds=ex)
        return True

    def ttl(self, key: str) -> int:
        self._purge_if_expired(key)
        if key not in self.values:
            return -2
        expires_at = self.expiry.get(key)
        if expires_at is None:
            return -1
        return max(int((expires_at - datetime.now(timezone.utc)).total_seconds()), 0)

    def delete(self, *keys: str) -> int:
        deleted = 0
        for key in keys:
            if key in self.values or key in self.hashes:
                deleted += 1
            self.values.pop(key, None)
            self.hashes.pop(key, None)
            self.expiry.pop(key, None)
        return deleted

    def hset(self, name: str, key: str, value: str) -> int:
        self.hashes.setdefault(name, {})[key] = value
        return 1

    def hgetall(self, name: str) -> dict[str, str]:
        return dict(self.hashes.get(name, {}))

    def zadd(self, name: str, mapping: dict[str, float], **_kwargs) -> int:
        bucket = self.sorted_sets.setdefault(name, {})
        for member, score in mapping.items():
            bucket[member] = score
        return len(mapping)

    def zrangebyscore(self, name: str, min_score: float, max_score: float, **_kwargs):
        bucket = self.sorted_sets.get(name, {})
        return [
            member
            for member, score in bucket.items()
            if float(min_score) <= score <= float(max_score)
        ]

    def zremrangebyscore(self, name: str, min_score: float, max_score: float) -> int:
        bucket = self.sorted_sets.get(name, {})
        to_delete = [
            member
            for member, score in bucket.items()
            if float(min_score) <= score <= float(max_score)
        ]
        for member in to_delete:
            del bucket[member]
        return len(to_delete)


@pytest.mark.unit
def test_constrain_child_ttl_uses_parent_remaining_lifetime() -> None:
    redis_client = _FakeRedisClient()
    manager = PrincipalTTLManager(redis_client)
    redis_client.set(manager.lease_key("parent-1"), "active", ex=45)

    decision = manager.constrain_child_ttl(
        requested_ttl_seconds=120,
        parent_principal_id="parent-1",
    )

    assert decision.truncated is True
    assert 0 < decision.effective_ttl_seconds <= 45


@pytest.mark.unit
def test_register_pending_then_activate_principal_updates_lease() -> None:
    redis_client = _FakeRedisClient()
    manager = PrincipalTTLManager(redis_client)

    lease = manager.register_pending_principal(
        principal_id="principal-1",
        pending_ttl_seconds=30,
        active_ttl_seconds=120,
        parent_principal_id="parent-1",
    )

    assert lease.lease_kind == "pending_attestation"
    assert redis_client.ttl(manager.lease_key("principal-1")) > 0

    activated = manager.activate_principal("principal-1")

    assert activated.lease_kind == "active"
    assert 0 < activated.ttl_seconds <= 120


@pytest.mark.unit
def test_activate_principal_raises_when_full_ttl_elapsed() -> None:
    redis_client = _FakeRedisClient()
    manager = PrincipalTTLManager(redis_client)
    stale_now = datetime.now(timezone.utc) - timedelta(seconds=90)
    manager.register_pending_principal(
        principal_id="principal-2",
        pending_ttl_seconds=120,
        active_ttl_seconds=60,
        now=stale_now,
    )

    with pytest.raises(PrincipalTTLLeaseExpiredError):
        manager.activate_principal("principal-2")


@pytest.mark.unit
def test_reconcile_expired_principals_claims_due_work_items() -> None:
    redis_client = _FakeRedisClient()
    manager = PrincipalTTLManager(redis_client)
    expired_now = datetime.now(timezone.utc) - timedelta(seconds=5)
    manager.register_pending_principal(
        principal_id="principal-3",
        pending_ttl_seconds=2,
        active_ttl_seconds=30,
        now=expired_now,
    )
    redis_client.values.pop(manager.lease_key("principal-3"), None)
    redis_client.expiry.pop(manager.lease_key("principal-3"), None)

    work_items = manager.reconcile_expired_principals()

    assert [item.principal_id for item in work_items] == ["principal-3"]
    assert work_items[0].lease_kind == "pending_attestation"


@pytest.mark.unit
def test_expiry_processor_moves_pending_principal_to_expired_and_revokes_mandates() -> None:
    principal_id = uuid4()
    principal = SimpleNamespace(
        principal_id=principal_id,
        principal_kind="worker",
        lifecycle_status=PrincipalLifecycleStatus.PENDING_ATTESTATION.value,
        attestation_status=PrincipalAttestationStatus.PENDING.value,
        principal_metadata={},
    )
    mandate = SimpleNamespace(revoked=False, revoked_at=None, revocation_reason=None)

    principal_query = Mock()
    principal_query.filter.return_value.first.return_value = principal
    mandate_query = Mock()
    mandate_query.filter.return_value.filter.return_value.all.return_value = [mandate]

    session = Mock()
    session.query.side_effect = [principal_query, mandate_query]

    class _FakeDbManager:
        @contextmanager
        def session_scope(self):
            yield session

    processor = PrincipalTTLExpiryProcessor(db_manager=_FakeDbManager())
    work_item = manager_work_item = SimpleNamespace(
        principal_id=str(principal_id),
        lease_kind="pending_attestation",
        lease_token="pending:1",
        active_ttl_seconds=60,
        expired_at=datetime.now(timezone.utc),
        parent_principal_id=None,
    )

    result = processor.process(manager_work_item)

    assert result == "expired"
    assert principal.lifecycle_status == PrincipalLifecycleStatus.EXPIRED.value
    assert principal.attestation_status == PrincipalAttestationStatus.FAILED.value
    assert mandate.revoked is True
    assert mandate.revocation_reason == "attestation_nonce_timeout"


@pytest.mark.unit
def test_expiry_processor_revokes_active_principal_through_orchestrator() -> None:
    orchestrator = Mock()
    orchestrator.revoke_principal = Mock()

    class _FakeDbManager:
        @contextmanager
        def session_scope(self):
            yield object()

    processor = PrincipalTTLExpiryProcessor(
        db_manager=_FakeDbManager(),
        revocation_orchestrator_factory=lambda _session: orchestrator,
    )
    work_item = SimpleNamespace(
        principal_id=str(uuid4()),
        lease_kind="active",
        lease_token="active:1",
        active_ttl_seconds=60,
        expired_at=datetime.now(timezone.utc),
        parent_principal_id=None,
    )

    result = processor.process(work_item)

    assert result == "revoked"
    orchestrator.revoke_principal.assert_called_once()
