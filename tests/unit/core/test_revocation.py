"""Unit tests for principal-centric revocation orchestration."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.revocation import PrincipalRevocationOrchestrator
from caracal.db.models import PrincipalLifecycleStatus


class _InMemoryDenylist:
    def __init__(self) -> None:
        self.entries: list[tuple[str, datetime]] = []

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        self.entries.append((token_jti, expires_at))


class _RecordingDispatcher:
    def __init__(self) -> None:
        self.jobs: list[dict[str, str | None]] = []

    async def enqueue_principal_revocation(
        self,
        *,
        principal_id: str,
        reason: str,
        actor_principal_id: str | None,
    ) -> None:
        self.jobs.append(
            {
                "principal_id": principal_id,
                "reason": reason,
                "actor_principal_id": actor_principal_id,
            }
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_processes_leaves_first_and_flushes_cache() -> None:
    session = Mock()
    denylist = _InMemoryDenylist()
    cache = Mock()
    cache.invalidate_mandates_by_subject.return_value = 1

    leaf_id = uuid4()
    root_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        denylist_backend=denylist,
        mandate_cache=cache,
    )

    call_order: list[str] = []

    def _revoke_single(*, principal_id, reason, actor_principal_id):
        del reason, actor_principal_id
        call_order.append(str(principal_id))
        mandate_id = uuid4()
        return SimpleNamespace(principal_id=principal_id, mandate_ids=[mandate_id])

    orchestrator._resolve_leaves_first_order = Mock(return_value=[leaf_id, root_id])
    orchestrator._revoke_single_principal = Mock(side_effect=_revoke_single)

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="security_event",
        actor_principal_id="human-1",
        session_token_jtis=["jti-1", "jti-2"],
    )

    assert call_order == [str(leaf_id), str(root_id)]
    assert result.denylisted_session_jtis == 2
    assert result.cache_invalidations == 4
    assert result.leaves_first_order is True
    assert len(result.revoked_principal_ids) == 2

    assert cache.invalidate_mandate.call_count == 2
    assert cache.invalidate_mandates_by_subject.call_count == 2
    session.commit.assert_called_once()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_enqueues_large_cascade_jobs() -> None:
    session = Mock()
    dispatcher = _RecordingDispatcher()

    leaf_1 = uuid4()
    leaf_2 = uuid4()
    root_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        cascade_job_dispatcher=dispatcher,
    )
    orchestrator._resolve_leaves_first_order = Mock(return_value=[leaf_1, leaf_2, root_id])
    orchestrator._revoke_single_principal = Mock(
        return_value=SimpleNamespace(principal_id=root_id, mandate_ids=[])
    )

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="tenant_shutdown",
        actor_principal_id="human-2",
        cascade_async_threshold=2,
    )

    assert result.cascade_jobs_enqueued == 2
    assert len(dispatcher.jobs) == 2
    assert {job["principal_id"] for job in dispatcher.jobs} == {str(leaf_1), str(leaf_2)}
    orchestrator._revoke_single_principal.assert_called_once()


@pytest.mark.unit
def test_revoke_single_principal_updates_status_and_mandates() -> None:
    session = Mock()
    orchestrator = PrincipalRevocationOrchestrator(db_session=session)

    principal_id = uuid4()
    principal = SimpleNamespace(
        principal_id=principal_id,
        principal_kind="worker",
        lifecycle_status="active",
        principal_metadata={},
    )
    mandate_a = SimpleNamespace(mandate_id=uuid4(), revoked=False, revoked_at=None, revocation_reason=None)
    mandate_b = SimpleNamespace(mandate_id=uuid4(), revoked=False, revoked_at=None, revocation_reason=None)

    orchestrator._get_principal_row = Mock(return_value=principal)
    orchestrator._list_active_mandates_for_principal = Mock(return_value=[mandate_a, mandate_b])

    unit = orchestrator._revoke_single_principal(
        principal_id=principal_id,
        reason="policy_violation",
        actor_principal_id="admin-1",
    )

    assert principal.lifecycle_status == PrincipalLifecycleStatus.REVOKED.value
    assert principal.principal_metadata["lifecycle_status"] == PrincipalLifecycleStatus.REVOKED.value
    assert principal.principal_metadata["revocation_reason"] == "policy_violation"
    assert principal.principal_metadata["revoked_by"] == "admin-1"
    assert mandate_a.revoked is True
    assert mandate_b.revoked is True
    assert len(unit.mandate_ids) == 2
