"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for KeyRotationScheduler state, BackfillProgress/Result, and QueryOptimizer cache.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

pytestmark = pytest.mark.unit


class TestKeyRotationSchedulerState:
    def _config(self, enabled=True, days=90):
        cfg = MagicMock()
        cfg.key_rotation_enabled = enabled
        cfg.key_rotation_days = days
        cfg.private_key_path = "/tmp/test-key.pem"
        cfg.key_encryption_passphrase = None
        return cfg

    def _make_scheduler(self, enabled=True, days=90):
        from caracal.merkle.key_rotation_scheduler import KeyRotationScheduler
        with patch("caracal.merkle.key_rotation_scheduler.KeyManager"):
            return KeyRotationScheduler(self._config(enabled=enabled, days=days))

    def test_initially_not_running(self):
        s = self._make_scheduler()
        assert s.running is False

    def test_task_is_none_initially(self):
        s = self._make_scheduler()
        assert s._task is None

    @pytest.mark.asyncio
    async def test_start_disabled_does_nothing(self):
        s = self._make_scheduler(enabled=False)
        await s.start()
        assert s.running is False

    @pytest.mark.asyncio
    async def test_start_enabled_sets_running(self):
        s = self._make_scheduler()
        with patch.object(s, "_rotation_loop", new_callable=AsyncMock):
            import asyncio
            with patch("asyncio.create_task", return_value=MagicMock()) as mock_ct:
                await s.start()
                assert s.running is True

    @pytest.mark.asyncio
    async def test_stop_when_not_running_is_safe(self):
        s = self._make_scheduler()
        await s.stop()  # should not raise

    @pytest.mark.asyncio
    async def test_stop_cancels_task_and_clears_running(self):
        import asyncio
        s = self._make_scheduler()
        s.running = True

        async def _raise_cancelled():
            raise asyncio.CancelledError()

        loop = asyncio.get_event_loop()
        real_task = loop.create_task(_raise_cancelled())
        try:
            await asyncio.sleep(0)  # let task start
        except Exception:
            pass
        s._task = real_task
        await s.stop()
        assert s.running is False

    @pytest.mark.asyncio
    async def test_should_rotate_key_false_when_key_missing(self, tmp_path):
        s = self._make_scheduler()
        s.config.private_key_path = str(tmp_path / "nonexistent.pem")
        result = await s._should_rotate_key()
        assert result is False

    @pytest.mark.asyncio
    async def test_should_rotate_key_true_when_old(self, tmp_path):
        key = tmp_path / "old.pem"
        key.write_text("fake key")
        import os, time
        old_time = time.time() - (91 * 86400)  # 91 days ago
        os.utime(str(key), (old_time, old_time))
        s = self._make_scheduler(days=90)
        s.config.private_key_path = str(key)
        result = await s._should_rotate_key()
        assert result is True

    @pytest.mark.asyncio
    async def test_should_rotate_key_false_when_fresh(self, tmp_path):
        key = tmp_path / "fresh.pem"
        key.write_text("fake key")
        s = self._make_scheduler(days=90)
        s.config.private_key_path = str(key)
        result = await s._should_rotate_key()
        assert result is False


class TestBackfillDataclasses:
    def test_backfill_result_fields(self):
        from caracal.merkle.backfill import BackfillResult
        r = BackfillResult(
            success=True,
            total_events_processed=500,
            total_batches_created=5,
            duration_seconds=12.5,
            errors=[],
        )
        assert r.success is True
        assert r.total_events_processed == 500

    def test_backfill_result_errors_list(self):
        from caracal.merkle.backfill import BackfillResult
        r = BackfillResult(
            success=False,
            total_events_processed=0,
            total_batches_created=0,
            duration_seconds=0.1,
            errors=["something failed"],
        )
        assert len(r.errors) == 1


class TestBackfillComputeEventHash:
    def _make_manager(self):
        from caracal.merkle.backfill import LedgerBackfillManager
        session = MagicMock()
        signer = MagicMock()
        m = LedgerBackfillManager.__new__(LedgerBackfillManager)
        m.db_session = session
        m.merkle_signer = signer
        m.batch_size = 1000
        m.dry_run = False
        m._progress = None
        m._start_time = None
        return m

    def _make_event(self, eid="e-1", pid="p-1", ts=None, rtype="compute", qty=1):
        event = MagicMock()
        event.event_id = eid
        event.principal_id = pid
        event.timestamp = ts or datetime(2026, 1, 1, 0, 0, 0)
        event.resource_type = rtype
        event.quantity = qty
        return event

    def test_returns_bytes(self):
        m = self._make_manager()
        event = self._make_event()
        result = m._compute_event_hash(event)
        assert isinstance(result, bytes)
        assert len(result) == 32  # SHA-256 digest size

    def test_same_event_same_hash(self):
        m = self._make_manager()
        event = self._make_event()
        assert m._compute_event_hash(event) == m._compute_event_hash(event)

    def test_different_events_different_hash(self):
        m = self._make_manager()
        e1 = self._make_event(eid="e-1", qty=1)
        e2 = self._make_event(eid="e-2", qty=2)
        assert m._compute_event_hash(e1) != m._compute_event_hash(e2)


class TestQueryOptimizerCache:
    def _make_optimizer(self, ttl=60):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        opt = QueryOptimizer.__new__(QueryOptimizer)
        opt.db_session = session
        opt._query_cache = {}
        opt._cache_ttl_seconds = ttl
        return opt

    def test_get_cached_result_miss_returns_none(self):
        opt = self._make_optimizer()
        assert opt._get_cached_result("missing-key") is None

    def test_get_cached_result_hit_returns_value(self):
        opt = self._make_optimizer()
        opt._cache_result("k", "result-data")
        assert opt._get_cached_result("k") == "result-data"

    def test_get_cached_result_expired_returns_none(self):
        opt = self._make_optimizer(ttl=0)
        opt._cache_result("k", "stale")
        import time
        time.sleep(0.01)
        assert opt._get_cached_result("k") is None

    def test_cache_result_stores_value(self):
        opt = self._make_optimizer()
        opt._cache_result("mykey", [1, 2, 3])
        assert "mykey" in opt._query_cache

    def test_clear_cache_empties_all(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        opt = QueryOptimizer(session)
        opt._cache_result("a", "v")
        opt._cache_result("b", "u")
        opt.clear_cache()
        assert opt._query_cache == {}

    def test_invalidate_policy_cache_removes_entry(self):
        from uuid import uuid4
        opt = self._make_optimizer()
        pid = uuid4()
        opt._cache_result(f"policy:{pid}", "policy-data")
        opt.invalidate_policy_cache(pid)
        assert opt._get_cached_result(f"policy:{pid}") is None
