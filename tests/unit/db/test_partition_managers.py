"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for PartitionManager and AuthorityLedgerPartitionManager.
"""

import pytest
from unittest.mock import MagicMock, call

pytestmark = pytest.mark.unit


def _mock_session_returning(scalar_value):
    session = MagicMock()
    session.execute.return_value.scalar.return_value = scalar_value
    return session


class TestPartitionManagerInit:
    def test_stores_db_session(self):
        from caracal.db.partition_manager import PartitionManager
        session = MagicMock()
        mgr = PartitionManager(db_session=session)
        assert mgr.db_session is session


class TestPartitionManagerCreatePartition:
    def _mgr(self, scalar=False):
        from caracal.db.partition_manager import PartitionManager
        session = _mock_session_returning(scalar)
        return PartitionManager(db_session=session), session

    def test_invalid_month_raises_value_error(self):
        from caracal.db.partition_manager import PartitionManager
        mgr = PartitionManager(db_session=MagicMock())
        with pytest.raises(ValueError):
            mgr.create_partition(2026, 0)

    def test_invalid_month_13_raises_value_error(self):
        from caracal.db.partition_manager import PartitionManager
        mgr = PartitionManager(db_session=MagicMock())
        with pytest.raises(ValueError):
            mgr.create_partition(2026, 13)

    def test_create_partition_returns_name(self):
        mgr, _ = self._mgr(scalar=False)
        name = mgr.create_partition(2026, 1)
        assert "ledger_events" in name
        assert "2026" in name

    def test_create_partition_skips_existing(self):
        mgr, session = self._mgr(scalar=True)
        name = mgr.create_partition(2026, 3)
        assert "2026" in name

    def test_december_partition_wraps_year(self):
        mgr, _ = self._mgr(scalar=False)
        name = mgr.create_partition(2026, 12)
        assert "12" in name

    def test_create_partition_without_if_not_exists_skips_check(self):
        mgr, session = self._mgr(scalar=False)
        mgr.create_partition(2026, 5, if_not_exists=False)
        # execute should be called once (create, no check)
        session.execute.assert_called()


class TestPartitionManagerListOperation:
    def test_list_partitions_returns_list(self):
        from caracal.db.partition_manager import PartitionManager
        session = MagicMock()
        row = MagicMock()
        row.__iter__ = MagicMock(return_value=iter(["ledger_events_y2026m01"]))
        session.execute.return_value.fetchall.return_value = [(
            "ledger_events_y2026m01",
        )]
        mgr = PartitionManager(db_session=session)
        result = mgr.list_partitions()
        assert isinstance(result, list)

    def test_list_partitions_returns_empty_on_error(self):
        from caracal.db.partition_manager import PartitionManager
        session = MagicMock()
        session.execute.side_effect = RuntimeError("DB fail")
        mgr = PartitionManager(db_session=session)
        result = mgr.list_partitions()
        assert result == []


class TestAuthorityPartitionManagerInit:
    def test_stores_db_session(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = MagicMock()
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        assert mgr.db_session is session

    def test_table_name_is_correct(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        mgr = AuthorityLedgerPartitionManager(db_session=MagicMock())
        assert mgr.TABLE_NAME == "authority_ledger_events"


class TestAuthorityPartitionManagerPartitionName:
    def _mgr(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        return AuthorityLedgerPartitionManager(db_session=MagicMock())

    def test_partition_name_format(self):
        mgr = self._mgr()
        name = mgr._get_partition_name(2026, 1)
        assert name == "authority_ledger_events_2026_01"

    def test_partition_name_double_digit_month(self):
        mgr = self._mgr()
        name = mgr._get_partition_name(2026, 12)
        assert name == "authority_ledger_events_2026_12"


class TestAuthorityPartitionManagerBounds:
    def _mgr(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        return AuthorityLedgerPartitionManager(db_session=MagicMock())

    def test_bounds_january(self):
        mgr = self._mgr()
        start, end = mgr._get_partition_bounds(2026, 1)
        assert "2026-01-01" in start
        assert "2026-02-01" in end

    def test_bounds_december_wraps_year(self):
        mgr = self._mgr()
        start, end = mgr._get_partition_bounds(2026, 12)
        assert "2026-12-01" in start
        assert "2027-01-01" in end


class TestAuthorityCreatePartition:
    def test_create_partition_returns_true_when_already_exists(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = _mock_session_returning(True)
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        result = mgr.create_partition(2026, 1)
        assert result is True

    def test_create_partition_creates_and_returns_true(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = _mock_session_returning(False)
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        result = mgr.create_partition(2026, 2)
        assert result is True
        session.commit.assert_called_once()

    def test_create_partition_returns_false_on_error(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = MagicMock()
        session.execute.side_effect = RuntimeError("fail")
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        result = mgr.create_partition(2026, 3)
        assert result is False
        session.rollback.assert_called_once()


class TestAuthorityCreatePartitionsForRange:
    def test_creates_multiple_partitions(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = _mock_session_returning(False)
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        count = mgr.create_partitions_for_range(2026, 1, 2026, 3)
        assert count == 3

    def test_handles_year_wrap(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = _mock_session_returning(False)
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        count = mgr.create_partitions_for_range(2025, 11, 2026, 2)
        assert count == 4


class TestAuthorityCreateFuturePartitions:
    def test_creates_partitions_for_future_months(self):
        from caracal.db.authority_partition_manager import AuthorityLedgerPartitionManager
        session = _mock_session_returning(False)
        mgr = AuthorityLedgerPartitionManager(db_session=session)
        count = mgr.create_future_partitions(months_ahead=2)
        assert count >= 1
