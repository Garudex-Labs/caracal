"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for QueryOptimizer DB query methods.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock
from uuid import uuid4

pytestmark = pytest.mark.unit


def _make_optimizer():
    from caracal.db.query_optimizer import QueryOptimizer
    session = MagicMock()
    chain = MagicMock()
    chain.filter.return_value = chain
    chain.options.return_value = chain
    chain.order_by.return_value = chain
    chain.limit.return_value = chain
    chain.first.return_value = None
    chain.all.return_value = []
    session.query.return_value = chain
    return QueryOptimizer(db_session=session), session, chain


class TestGetMandateWithRelationships:
    def test_returns_none_when_not_found(self):
        opt, _, _ = _make_optimizer()
        result = opt.get_mandate_with_relationships(uuid4())
        assert result is None

    def test_uses_db_session_query(self):
        opt, session, _ = _make_optimizer()
        opt.get_mandate_with_relationships(uuid4())
        session.query.assert_called()

    def test_returns_none_on_db_error(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        session.query.side_effect = RuntimeError("DB fail")
        opt = QueryOptimizer(db_session=session)
        result = opt.get_mandate_with_relationships(uuid4())
        assert result is None


class TestGetActiveMandatesForSubject:
    def test_returns_empty_list_when_none(self):
        opt, _, _ = _make_optimizer()
        result = opt.get_active_mandates_for_subject(uuid4())
        assert result == []

    def test_returns_mandates_when_found(self):
        opt, _, chain = _make_optimizer()
        fake = [MagicMock(), MagicMock()]
        chain.all.return_value = fake
        result = opt.get_active_mandates_for_subject(uuid4())
        assert result == fake

    def test_uses_provided_current_time(self):
        opt, _, _ = _make_optimizer()
        ts = datetime(2026, 1, 1)
        result = opt.get_active_mandates_for_subject(uuid4(), current_time=ts)
        assert isinstance(result, list)

    def test_returns_empty_on_error(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        session.query.side_effect = RuntimeError("fail")
        opt = QueryOptimizer(db_session=session)
        result = opt.get_active_mandates_for_subject(uuid4())
        assert result == []


class TestGetMandatesExpiringSoon:
    def test_returns_empty_list_when_none(self):
        opt, _, _ = _make_optimizer()
        result = opt.get_mandates_expiring_soon()
        assert result == []

    def test_returns_mandates_when_found(self):
        opt, _, chain = _make_optimizer()
        fake = [MagicMock()]
        chain.all.return_value = fake
        result = opt.get_mandates_expiring_soon(hours=48, limit=50)
        assert result == fake

    def test_returns_empty_on_error(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        session.query.side_effect = RuntimeError("fail")
        opt = QueryOptimizer(db_session=session)
        result = opt.get_mandates_expiring_soon()
        assert result == []


class TestGetAuthorityEventsInRange:
    def test_returns_empty_list_when_none(self):
        opt, _, _ = _make_optimizer()
        start = datetime(2026, 1, 1)
        end = datetime(2026, 12, 31)
        result = opt.get_authority_events_in_range(start, end)
        assert result == []

    def test_returns_events_when_found(self):
        opt, _, chain = _make_optimizer()
        fake = [MagicMock(), MagicMock()]
        chain.all.return_value = fake
        start = datetime(2026, 1, 1)
        end = datetime(2026, 12, 31)
        result = opt.get_authority_events_in_range(start, end)
        assert result == fake

    def test_with_principal_and_event_type_filters(self):
        opt, _, chain = _make_optimizer()
        start = datetime(2026, 1, 1)
        end = datetime(2026, 12, 31)
        result = opt.get_authority_events_in_range(
            start, end,
            principal_id=uuid4(),
            event_type="issued",
        )
        assert isinstance(result, list)

    def test_returns_empty_on_error(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        session.query.side_effect = RuntimeError("fail")
        opt = QueryOptimizer(db_session=session)
        result = opt.get_authority_events_in_range(
            datetime(2026, 1, 1), datetime(2026, 12, 31)
        )
        assert result == []


class TestGetActivePolicyForPrincipal:
    def test_caches_result_on_second_call(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        chain = MagicMock()
        chain.filter.return_value = chain
        fake_policy = MagicMock()
        chain.first.return_value = fake_policy
        session.query.return_value = chain
        opt = QueryOptimizer(db_session=session)
        pid = uuid4()
        opt.get_active_policy_for_principal(pid)
        opt.get_active_policy_for_principal(pid)
        assert session.query.call_count == 1

    def test_returns_policy_when_found(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        chain = MagicMock()
        chain.filter.return_value = chain
        fake_policy = MagicMock()
        chain.first.return_value = fake_policy
        session.query.return_value = chain
        opt = QueryOptimizer(db_session=session)
        result = opt.get_active_policy_for_principal(uuid4())
        assert result is fake_policy

    def test_returns_none_on_error(self):
        from caracal.db.query_optimizer import QueryOptimizer
        session = MagicMock()
        session.query.side_effect = RuntimeError("fail")
        opt = QueryOptimizer(db_session=session)
        result = opt.get_active_policy_for_principal(uuid4())
        assert result is None
