"""Unit tests for hard-cut sync compatibility shims."""

from __future__ import annotations

from datetime import datetime

import pytest

from caracal.deployment.exceptions import SyncOperationError, SyncStateError
from caracal.deployment.sync_engine import SyncDirection, SyncEngine
from caracal.deployment.sync_state import SyncStateManager


@pytest.mark.unit
def test_sync_engine_mutating_operations_fail_closed() -> None:
    engine = SyncEngine()

    with pytest.raises(SyncOperationError, match="removed in hard-cut mode"):
        engine.connect("ws", "https://enterprise.example", "token")

    with pytest.raises(SyncOperationError, match="removed in hard-cut mode"):
        engine.disconnect("ws")

    with pytest.raises(SyncOperationError, match="removed in hard-cut mode"):
        engine.sync_now("ws", SyncDirection.BIDIRECTIONAL)

    with pytest.raises(SyncOperationError, match="removed in hard-cut mode"):
        engine.enable_auto_sync("ws", interval_seconds=120)

    with pytest.raises(SyncOperationError, match="removed in hard-cut mode"):
        engine.disable_auto_sync("ws")


@pytest.mark.unit
def test_sync_engine_read_only_compatibility_returns_safe_defaults() -> None:
    engine = SyncEngine()

    status = engine.get_sync_status("workspace-a")

    assert status.workspace == "workspace-a"
    assert status.sync_enabled is False
    assert status.pending_operations == 0
    assert status.conflicts_count == 0
    assert status.conflicts == []
    assert "removed in hard-cut mode" in (status.last_error or "")
    assert status.last_sync_timestamp is None

    assert engine.get_conflict_history("workspace-a", limit=20) == []


@pytest.mark.unit
def test_sync_state_manager_mutating_operations_fail_closed() -> None:
    manager = SyncStateManager(db_manager=object())

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.queue_operation(
            workspace="ws",
            operation_type="create",
            entity_type="item",
            entity_id="1",
            operation_data={"k": "v"},
        )

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.mark_operation_processing("op-1")

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.mark_operation_completed("op-1")

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.mark_operation_failed("op-1", error="boom")

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.record_conflict(
            workspace="ws",
            entity_type="item",
            entity_id="1",
            local_version={"v": 1},
            remote_version={"v": 2},
            local_timestamp=datetime.utcnow(),
            remote_timestamp=datetime.utcnow(),
        )

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.resolve_conflict("conflict-1", resolution_strategy="manual", resolved_version={"v": 2})

    with pytest.raises(SyncStateError, match="removed in hard-cut mode"):
        manager.update_sync_metadata("ws", sync_enabled=False)


@pytest.mark.unit
def test_sync_state_manager_read_only_compatibility_returns_safe_defaults() -> None:
    manager = SyncStateManager(db_manager=object())

    assert manager.get_pending_operations("ws", limit=10) == []
    assert manager.get_unresolved_conflicts("ws", limit=10) == []
    assert manager.get_conflict_history("ws", limit=10) == []
    assert manager.get_sync_metadata("ws") is None
    assert manager.cleanup_old_operations("ws", older_than_days=7) == 0

    stats = manager.get_operation_statistics("ws")
    assert stats == {
        "total": 0,
        "pending": 0,
        "processing": 0,
        "completed": 0,
        "failed": 0,
    }
