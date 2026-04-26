"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for db/circuit_breaker_integration.py and db/materialized_views.py.
"""

import pytest
from unittest.mock import MagicMock, call

pytestmark = pytest.mark.unit


class TestDatabaseCircuitBreakerManagerInit:
    def _make_manager(self, config=None):
        from caracal.db.circuit_breaker_integration import DatabaseCircuitBreakerManager
        conn_mgr = MagicMock()
        return DatabaseCircuitBreakerManager(connection_manager=conn_mgr, circuit_breaker_config=config)

    def test_stores_connection_manager(self):
        from caracal.db.circuit_breaker_integration import DatabaseCircuitBreakerManager
        conn_mgr = MagicMock()
        mgr = DatabaseCircuitBreakerManager(connection_manager=conn_mgr)
        assert mgr.connection_manager is conn_mgr

    def test_circuit_breaker_is_none_initially(self):
        mgr = self._make_manager()
        assert mgr._circuit_breaker is None

    def test_default_config_failure_threshold(self):
        mgr = self._make_manager()
        assert mgr._config.failure_threshold == 5

    def test_default_config_success_threshold(self):
        mgr = self._make_manager()
        assert mgr._config.success_threshold == 2

    def test_default_config_timeout_seconds(self):
        mgr = self._make_manager()
        assert mgr._config.timeout_seconds == 60.0

    def test_custom_config_stored(self):
        from caracal.core.circuit_breaker import CircuitBreakerConfig
        custom = CircuitBreakerConfig(
            failure_threshold=10,
            success_threshold=3,
            timeout_seconds=30.0,
        )
        mgr = self._make_manager(config=custom)
        assert mgr._config.failure_threshold == 10
        assert mgr._config.timeout_seconds == 30.0


class TestMaterializedViewManagerInit:
    def test_stores_db_session(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        mgr = MaterializedViewManager(db_session=session)
        assert mgr.db_session is session

    def test_refresh_usage_by_principal_executes_sql(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        mgr = MaterializedViewManager(db_session=session)
        mgr.refresh_usage_by_principal(concurrent=True)
        session.execute.assert_called_once()
        session.commit.assert_called_once()

    def test_refresh_usage_by_principal_non_concurrent(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        mgr = MaterializedViewManager(db_session=session)
        mgr.refresh_usage_by_principal(concurrent=False)
        session.execute.assert_called_once()
        session.commit.assert_called_once()

    def test_refresh_usage_by_principal_raises_database_error_on_failure(self):
        from caracal.db.materialized_views import MaterializedViewManager
        from caracal.exceptions import DatabaseError
        session = MagicMock()
        session.execute.side_effect = RuntimeError("DB down")
        mgr = MaterializedViewManager(db_session=session)
        with pytest.raises(DatabaseError):
            mgr.refresh_usage_by_principal()
        session.rollback.assert_called_once()

    def test_refresh_usage_by_time_window_executes_sql(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        mgr = MaterializedViewManager(db_session=session)
        mgr.refresh_usage_by_time_window(concurrent=True)
        session.execute.assert_called_once()
        session.commit.assert_called_once()

    def test_refresh_usage_by_time_window_raises_on_failure(self):
        from caracal.db.materialized_views import MaterializedViewManager
        from caracal.exceptions import DatabaseError
        session = MagicMock()
        session.execute.side_effect = RuntimeError("DB fail")
        mgr = MaterializedViewManager(db_session=session)
        with pytest.raises(DatabaseError):
            mgr.refresh_usage_by_time_window()

    def test_refresh_all_calls_both_refresh_methods(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        mgr = MaterializedViewManager(db_session=session)
        mgr.refresh_all(concurrent=False)
        assert session.execute.call_count == 2
        assert session.commit.call_count == 2

    def test_get_view_refresh_time_returns_timestamp(self):
        from caracal.db.materialized_views import MaterializedViewManager
        from datetime import datetime
        session = MagicMock()
        ts = datetime(2026, 1, 1)
        session.execute.return_value.fetchone.return_value = (ts,)
        mgr = MaterializedViewManager(db_session=session)
        result = mgr.get_view_refresh_time("some_view")
        assert result == ts

    def test_get_view_refresh_time_returns_none_when_no_rows(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        session.execute.return_value.fetchone.return_value = None
        mgr = MaterializedViewManager(db_session=session)
        result = mgr.get_view_refresh_time("some_view")
        assert result is None

    def test_get_view_refresh_time_returns_none_on_exception(self):
        from caracal.db.materialized_views import MaterializedViewManager
        session = MagicMock()
        session.execute.side_effect = RuntimeError("Bad query")
        mgr = MaterializedViewManager(db_session=session)
        result = mgr.get_view_refresh_time("some_view")
        assert result is None
