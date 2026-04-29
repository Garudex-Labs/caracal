"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for the AuthorityLedgerWriter and AuthorityLedgerQuery classes.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, call
from uuid import uuid4

pytestmark = pytest.mark.unit


def _mock_query_chain():
    q = MagicMock()
    q.filter.return_value = q
    q.order_by.return_value = q
    q.limit.return_value = q
    q.all.return_value = []
    q.group_by.return_value = q
    return q


class TestAuthorityLedgerWriterInit:
    def test_stores_db_session(self):
        from caracal.core.authority_ledger import AuthorityLedgerWriter
        session = MagicMock()
        writer = AuthorityLedgerWriter(db_session=session)
        assert writer.db_session is session


class TestAuthorityLedgerWriterRecordIssuance:
    def _make_writer(self):
        from caracal.core.authority_ledger import AuthorityLedgerWriter
        session = MagicMock()
        return AuthorityLedgerWriter(db_session=session), session

    def test_adds_event_to_session(self):
        writer, session = self._make_writer()
        event = writer.record_issuance(
            mandate_id=uuid4(),
            principal_id=uuid4(),
        )
        session.add.assert_called_once()
        session.flush.assert_called_once()

    def test_returns_event_with_correct_type(self):
        writer, session = self._make_writer()
        event = writer.record_issuance(
            mandate_id=uuid4(),
            principal_id=uuid4(),
        )
        assert event.event_type == "issued"

    def test_uses_provided_timestamp(self):
        writer, session = self._make_writer()
        ts = datetime(2026, 6, 1, 12, 0)
        event = writer.record_issuance(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            timestamp=ts,
        )
        assert event.timestamp == ts

    def test_uses_current_time_when_no_timestamp(self):
        writer, session = self._make_writer()
        before = datetime.utcnow()
        event = writer.record_issuance(
            mandate_id=uuid4(),
            principal_id=uuid4(),
        )
        after = datetime.utcnow()
        assert before <= event.timestamp <= after

    def test_rollback_and_raise_on_flush_failure(self):
        writer, session = self._make_writer()
        session.flush.side_effect = RuntimeError("DB error")
        with pytest.raises(RuntimeError, match="Failed to record issuance"):
            writer.record_issuance(mandate_id=uuid4(), principal_id=uuid4())
        session.rollback.assert_called_once()

    def test_stores_metadata_and_correlation_id(self):
        writer, session = self._make_writer()
        # Sanitizer keeps allowlisted structural keys and drops everything else.
        meta = {"reason_code": "AUTH_ALLOW", "key": "val"}
        cid = "cid_abc"
        event = writer.record_issuance(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            metadata=meta,
            correlation_id=cid,
        )
        assert event.event_metadata == {"reason_code": "AUTH_ALLOW"}
        assert event.correlation_id == cid


class TestAuthorityLedgerWriterRecordValidation:
    def _make_writer(self):
        from caracal.core.authority_ledger import AuthorityLedgerWriter
        session = MagicMock()
        return AuthorityLedgerWriter(db_session=session), session

    def test_allowed_creates_validated_event(self):
        writer, _ = self._make_writer()
        event = writer.record_validation(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            decision="allowed",
            denial_reason=None,
            requested_action="read",
            requested_resource="resource://data",
        )
        assert event.event_type == "validated"
        assert event.decision == "allowed"

    def test_denied_creates_denied_event(self):
        writer, _ = self._make_writer()
        event = writer.record_validation(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            decision="denied",
            denial_reason="policy violation",
            requested_action="write",
            requested_resource="resource://secret",
        )
        assert event.event_type == "denied"
        assert event.denial_reason == "policy violation"

    def test_invalid_decision_raises_value_error(self):
        writer, _ = self._make_writer()
        with pytest.raises(ValueError, match="Invalid decision"):
            writer.record_validation(
                mandate_id=uuid4(),
                principal_id=uuid4(),
                decision="maybe",
                denial_reason=None,
                requested_action="read",
                requested_resource="resource://x",
            )

    def test_denied_without_reason_raises_value_error(self):
        writer, _ = self._make_writer()
        with pytest.raises(ValueError, match="denial_reason is required"):
            writer.record_validation(
                mandate_id=uuid4(),
                principal_id=uuid4(),
                decision="denied",
                denial_reason=None,
                requested_action="read",
                requested_resource="resource://x",
            )

    def test_rollback_on_flush_failure(self):
        writer, session = self._make_writer()
        session.flush.side_effect = RuntimeError("DB fail")
        with pytest.raises(RuntimeError):
            writer.record_validation(
                mandate_id=uuid4(),
                principal_id=uuid4(),
                decision="allowed",
                denial_reason=None,
                requested_action="read",
                requested_resource="resource://x",
            )
        session.rollback.assert_called_once()


class TestAuthorityLedgerWriterRecordRevocation:
    def _make_writer(self):
        from caracal.core.authority_ledger import AuthorityLedgerWriter
        session = MagicMock()
        return AuthorityLedgerWriter(db_session=session), session

    def test_adds_revoked_event(self):
        writer, session = self._make_writer()
        event = writer.record_revocation(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            reason="expired",
        )
        assert event.event_type == "revoked"
        session.add.assert_called_once()
        session.flush.assert_called_once()

    def test_stores_revocation_reason(self):
        writer, _ = self._make_writer()
        event = writer.record_revocation(
            mandate_id=uuid4(),
            principal_id=uuid4(),
            reason="policy_change",
        )
        assert event.denial_reason == "policy_change"

    def test_rollback_on_failure(self):
        writer, session = self._make_writer()
        session.flush.side_effect = RuntimeError("DB crash")
        with pytest.raises(RuntimeError):
            writer.record_revocation(
                mandate_id=uuid4(),
                principal_id=uuid4(),
                reason="manual",
            )
        session.rollback.assert_called_once()


class TestAuthorityLedgerQueryInit:
    def test_stores_db_session(self):
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        session = MagicMock()
        query_obj = AuthorityLedgerQuery(db_session=session)
        assert query_obj.db_session is session


class TestAuthorityLedgerQueryGetEvents:
    def _make_query(self):
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        session = MagicMock()
        session.query.return_value = _mock_query_chain()
        return AuthorityLedgerQuery(db_session=session), session

    def test_get_events_returns_list(self):
        q, _ = self._make_query()
        result = q.get_events()
        assert isinstance(result, list)

    def test_get_events_with_principal_filter_applies_filter(self):
        q, session = self._make_query()
        pid = uuid4()
        q.get_events(principal_id=pid)
        chain = session.query.return_value
        chain.filter.assert_called()

    def test_get_events_with_limit_applies_limit(self):
        q, session = self._make_query()
        q.get_events(limit=5)
        chain = session.query.return_value
        chain.limit.assert_called_with(5)

    def test_get_events_raises_on_db_error(self):
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        session = MagicMock()
        session.query.side_effect = RuntimeError("DB down")
        q = AuthorityLedgerQuery(db_session=session)
        with pytest.raises(RuntimeError, match="Failed to query"):
            q.get_events()


class TestAuthorityLedgerQueryAggregateByPrincipal:
    def test_returns_dict(self):
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        session = MagicMock()
        q_chain = _mock_query_chain()
        pid = uuid4()
        row = MagicMock()
        row.principal_id = pid
        row.event_count = 3
        q_chain.group_by.return_value.all.return_value = [row]
        session.query.return_value = q_chain
        q = AuthorityLedgerQuery(db_session=session)
        result = q.aggregate_by_principal(
            start_time=datetime(2026, 1, 1),
            end_time=datetime(2026, 12, 31),
        )
        assert result[pid] == 3
