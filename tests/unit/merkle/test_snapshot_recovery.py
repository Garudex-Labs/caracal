"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SnapshotScheduler state, SnapshotData/RecoveryResult dataclasses.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch
from uuid import uuid4

pytestmark = pytest.mark.unit


class TestSnapshotDataclasses:
    def test_snapshot_data_fields(self):
        from caracal.merkle.snapshot import SnapshotData
        sd = SnapshotData(
            total_events=1000,
            merkle_root="abc123",
            snapshot_timestamp=datetime(2026, 1, 1),
        )
        assert sd.total_events == 1000
        assert sd.merkle_root == "abc123"

    def test_recovery_result_fields(self):
        from caracal.merkle.snapshot import RecoveryResult
        ref = datetime(2026, 1, 1, 12, 0)
        rr = RecoveryResult(
            snapshot_id=uuid4(),
            snapshot_timestamp=ref,
            replay_from_timestamp=ref,
        )
        assert rr.snapshot_timestamp == ref


class TestSnapshotManagerInit:
    def test_initializes_without_error(self):
        from caracal.merkle.snapshot import SnapshotManager
        session = MagicMock()
        manager = SnapshotManager(db_session=session)
        assert manager.db_session is session
        assert manager.ledger_query is None
        assert manager.merkle_verifier is None


class TestSnapshotSchedulerState:
    @pytest.fixture(autouse=True)
    def _mock_apscheduler(self):
        import sys
        mods = {
            "apscheduler": MagicMock(),
            "apscheduler.schedulers": MagicMock(),
            "apscheduler.schedulers.asyncio": MagicMock(),
            "apscheduler.triggers": MagicMock(),
            "apscheduler.triggers.cron": MagicMock(),
        }
        with patch.dict(sys.modules, mods):
            yield

    def _make_scheduler(self, schedule="0 0 * * *", retention=90, cleanup=True):
        import importlib
        import sys
        if "caracal.merkle.snapshot_scheduler" in sys.modules:
            del sys.modules["caracal.merkle.snapshot_scheduler"]
        from caracal.merkle.snapshot_scheduler import SnapshotScheduler
        mgr = MagicMock()
        return SnapshotScheduler(
            snapshot_manager=mgr,
            schedule=schedule,
            retention_days=retention,
            cleanup_enabled=cleanup,
        )

    def test_not_running_initially(self):
        s = self._make_scheduler()
        assert s._running is False

    def test_is_running_false_initially(self):
        s = self._make_scheduler()
        assert s.is_running() is False

    def test_get_next_run_time_returns_none_when_not_running(self):
        s = self._make_scheduler()
        assert s.get_next_run_time() is None

    def test_retention_days_stored(self):
        s = self._make_scheduler(retention=30)
        assert s.retention_days == 30

    def test_cleanup_enabled_stored(self):
        s = self._make_scheduler(cleanup=False)
        assert s.cleanup_enabled is False

    def test_schedule_stored(self):
        s = self._make_scheduler(schedule="0 6 * * *")
        assert s.schedule == "0 6 * * *"


class TestRecoveryManagerInit:
    def test_initializes_without_error(self):
        from caracal.merkle.recovery import RecoveryManager
        session = MagicMock()
        snap_mgr = MagicMock()
        mgr = RecoveryManager(
            db_session=session,
            snapshot_manager=snap_mgr,
        )
        assert mgr.db_session is session
        assert mgr.snapshot_manager is snap_mgr
        assert mgr.merkle_verifier is None

    def test_get_recovery_status_no_snapshots(self):
        from caracal.merkle.recovery import RecoveryManager
        session = MagicMock()
        snap_mgr = MagicMock()
        snap_mgr.get_latest_snapshot.return_value = None
        mgr = RecoveryManager(db_session=session, snapshot_manager=snap_mgr)
        status = mgr.get_recovery_status()
        assert status["snapshot_available"] is False

    def test_get_recovery_status_with_snapshot(self):
        from caracal.merkle.recovery import RecoveryManager
        session = MagicMock()
        snap_mgr = MagicMock()

        snap = MagicMock()
        snap.snapshot_id = uuid4()
        snap.snapshot_timestamp = datetime(2026, 1, 1)
        snap.total_events = 500
        snap_mgr.get_latest_snapshot.return_value = snap
        session.execute.return_value.scalars.return_value.all.return_value = []

        mgr = RecoveryManager(db_session=session, snapshot_manager=snap_mgr)
        status = mgr.get_recovery_status()
        assert status["snapshot_available"] is True
        assert status["snapshot_events"] == 500
        assert status["events_after_snapshot"] == 0
