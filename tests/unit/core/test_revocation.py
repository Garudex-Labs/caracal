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


class _RecordingPublisher:
    def __init__(self, *, commit_probe=None, fail: bool = False) -> None:
        self.events: list[dict[str, object]] = []
        self._commit_probe = commit_probe
        self._fail = fail

    async def publish_principal_revocation_event(
        self,
        *,
        event_type: str,
        principal_id: str,
        reason: str,
        actor_principal_id: str | None,
        root_principal_id: str | None,
        revoked_mandate_ids: list[str] | None = None,
        metadata: dict | None = None,
    ) -> None:
        self.events.append(
            {
                "event_type": event_type,
                "principal_id": principal_id,
                "reason": reason,
                "actor_principal_id": actor_principal_id,
                "root_principal_id": root_principal_id,
                "revoked_mandate_ids": revoked_mandate_ids or [],
                "metadata": metadata or {},
                "commit_seen": self._commit_probe() if self._commit_probe is not None else None,
            }
        )
        if self._fail:
            raise RuntimeError("publisher unavailable")


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
    orchestrator._list_active_mandates_for_principal = Mock(
        side_effect=[
            [SimpleNamespace(mandate_id=uuid4())],
            [SimpleNamespace(mandate_id=uuid4())],
        ]
    )
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
    assert result.revoked_edge_ids == []

    assert cache.invalidate_mandate.call_count == 2
    assert cache.invalidate_mandates_by_subject.call_count == 2
    session.commit.assert_called_once()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_enqueues_large_cascade_jobs() -> None:
    session = Mock()
    dispatcher = _RecordingDispatcher()

    child_1 = uuid4()
    child_2 = uuid4()
    grandchild = uuid4()
    root_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        cascade_job_dispatcher=dispatcher,
    )
    orchestrator._resolve_leaves_first_order = Mock(return_value=[grandchild, child_1, child_2, root_id])
    orchestrator._resolve_breadth_first_descendants = Mock(return_value=[child_1, child_2, grandchild])
    orchestrator._revoke_single_principal = Mock(
        return_value=SimpleNamespace(principal_id=root_id, mandate_ids=[])
    )

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="tenant_shutdown",
        actor_principal_id="human-2",
        cascade_async_threshold=2,
    )

    assert result.cascade_jobs_enqueued == 3
    assert len(dispatcher.jobs) == 3
    assert [job["principal_id"] for job in dispatcher.jobs] == [
        str(child_1),
        str(child_2),
        str(grandchild),
    ]
    orchestrator._revoke_single_principal.assert_called_once()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_publishes_per_principal_events_after_commit() -> None:
    session = Mock()
    publisher = _RecordingPublisher(commit_probe=lambda: session.commit.called)

    leaf_id = uuid4()
    root_id = uuid4()
    leaf_mandate = uuid4()
    root_mandate = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        revocation_event_publisher=publisher,
    )
    orchestrator._resolve_leaves_first_order = Mock(return_value=[leaf_id, root_id])
    orchestrator._revoke_single_principal = Mock(
        side_effect=[
            SimpleNamespace(principal_id=leaf_id, mandate_ids=[leaf_mandate]),
            SimpleNamespace(principal_id=root_id, mandate_ids=[root_mandate]),
        ]
    )

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="policy_violation",
        actor_principal_id="admin-2",
    )

    assert result.revoked_principal_ids == [str(leaf_id), str(root_id)]
    assert result.revoked_edge_ids == []
    assert len(publisher.events) == 2
    assert [event["principal_id"] for event in publisher.events] == [str(leaf_id), str(root_id)]
    assert all(event["event_type"] == "principal_revoked" for event in publisher.events)
    assert all(event["commit_seen"] is True for event in publisher.events)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_publisher_failure_is_non_fatal() -> None:
    session = Mock()
    publisher = _RecordingPublisher(fail=True)
    root_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        revocation_event_publisher=publisher,
    )
    orchestrator._resolve_leaves_first_order = Mock(return_value=[root_id])
    orchestrator._revoke_single_principal = Mock(
        return_value=SimpleNamespace(principal_id=root_id, mandate_ids=[])
    )

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="security_event",
        actor_principal_id="admin-3",
    )

    assert result.revoked_principal_ids == [str(root_id)]
    assert result.revoked_edge_ids == []
    assert session.commit.call_count == 1
    assert len(publisher.events) == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_orders_denylist_cache_revoke_commit_publish() -> None:
    order: list[str] = []

    class _OrderedDenylist:
        async def add(self, token_jti: str, expires_at: datetime) -> None:
            del token_jti, expires_at
            order.append("denylist")

    session = Mock()
    publisher = _RecordingPublisher(commit_probe=lambda: session.commit.called)
    cache = Mock()

    def _invalidate_mandate(_mandate_id):
        order.append("cache")

    def _invalidate_subject(_principal_id):
        order.append("cache")
        return 0

    cache.invalidate_mandate.side_effect = _invalidate_mandate
    cache.invalidate_mandates_by_subject.side_effect = _invalidate_subject

    root_id = uuid4()
    mandate_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(
        db_session=session,
        denylist_backend=_OrderedDenylist(),
        mandate_cache=cache,
        revocation_event_publisher=publisher,
    )
    orchestrator._resolve_leaves_first_order = Mock(return_value=[root_id])
    orchestrator._list_active_mandates_for_principal = Mock(
        return_value=[SimpleNamespace(mandate_id=mandate_id)]
    )

    def _revoke_single(*, principal_id, reason, actor_principal_id):
        del reason, actor_principal_id
        order.append("durable_revoke")
        return SimpleNamespace(principal_id=principal_id, mandate_ids=[mandate_id])

    orchestrator._revoke_single_principal = Mock(side_effect=_revoke_single)

    await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="security_event",
        actor_principal_id="admin-9",
        session_token_jtis=["jti-1"],
    )

    assert order[0] == "denylist"
    assert "durable_revoke" in order
    assert "cache" in order
    assert order.index("denylist") < order.index("cache")
    assert order.index("cache") < order.index("durable_revoke")
    assert publisher.events[0]["commit_seen"] is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_revoke_principal_collects_revoked_graph_edges() -> None:
    session = Mock()
    root_id = uuid4()
    mandate_id = uuid4()
    edge_id = uuid4()

    orchestrator = PrincipalRevocationOrchestrator(db_session=session)
    orchestrator._resolve_leaves_first_order = Mock(return_value=[root_id])
    orchestrator._revoke_single_principal = Mock(
        return_value=SimpleNamespace(
            principal_id=root_id,
            mandate_ids=[mandate_id],
            edge_ids=[edge_id],
        )
    )

    result = await orchestrator.revoke_principal(
        principal_id=str(root_id),
        reason="merged_source_revocation",
        actor_principal_id="admin-7",
    )

    assert result.revoked_mandate_ids == [str(mandate_id)]
    assert result.revoked_edge_ids == [str(edge_id)]


@pytest.mark.unit
def test_build_child_map_uses_delegation_edges_for_shared_upstream_graphs() -> None:
    session = Mock()
    orchestrator = PrincipalRevocationOrchestrator(db_session=session)

    root_principal = uuid4()
    sibling_principal = uuid4()
    shared_principal = uuid4()
    root_mandate = uuid4()
    sibling_mandate = uuid4()
    shared_mandate = uuid4()

    mandate_query = Mock()
    mandate_query.filter.return_value.all.return_value = [
        SimpleNamespace(mandate_id=root_mandate, subject_id=root_principal),
        SimpleNamespace(mandate_id=sibling_mandate, subject_id=sibling_principal),
        SimpleNamespace(mandate_id=shared_mandate, subject_id=shared_principal),
    ]
    edge_query = Mock()
    edge_query.filter.return_value.all.return_value = [
        SimpleNamespace(source_mandate_id=root_mandate, target_mandate_id=shared_mandate),
        SimpleNamespace(source_mandate_id=sibling_mandate, target_mandate_id=shared_mandate),
    ]

    def _query_side_effect(model):
        if model.__name__ == "ExecutionMandate":
            return mandate_query
        return edge_query

    session.query.side_effect = _query_side_effect

    children = orchestrator._build_child_map()

    assert children[root_principal] == [shared_principal]
    assert children[sibling_principal] == [shared_principal]


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
    orchestrator._revoke_edges_for_mandates = Mock(return_value=[])

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
