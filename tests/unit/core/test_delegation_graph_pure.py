"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for DelegationGraph pure static methods and dataclasses.
"""

import pytest
from datetime import datetime, timedelta
from uuid import uuid4
from unittest.mock import MagicMock

pytestmark = pytest.mark.unit


def _make_mandate(
    revoked=False,
    valid_from=None,
    valid_until=None,
    resource_scope=None,
    action_scope=None,
):
    m = MagicMock()
    m.revoked = revoked
    m.valid_from = valid_from
    m.valid_until = valid_until
    m.resource_scope = resource_scope
    m.action_scope = action_scope
    return m


class TestIsMandateActive:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.is_active = DelegationGraph._is_mandate_active

    def test_none_mandate_returns_false(self):
        assert self.is_active(None) is False

    def test_revoked_mandate_is_inactive(self):
        m = _make_mandate(revoked=True)
        assert self.is_active(m) is False

    def test_valid_from_in_future_is_inactive(self):
        future = datetime.utcnow() + timedelta(hours=1)
        m = _make_mandate(valid_from=future)
        assert self.is_active(m) is False

    def test_valid_until_in_past_is_inactive(self):
        past = datetime.utcnow() - timedelta(seconds=1)
        m = _make_mandate(valid_until=past)
        assert self.is_active(m) is False

    def test_active_no_time_bounds(self):
        m = _make_mandate()
        assert self.is_active(m) is True

    def test_active_within_time_bounds(self):
        past = datetime.utcnow() - timedelta(hours=1)
        future = datetime.utcnow() + timedelta(hours=1)
        m = _make_mandate(valid_from=past, valid_until=future)
        assert self.is_active(m) is True

    def test_uses_provided_now(self):
        ref = datetime(2026, 6, 1, 12, 0, 0)
        before = datetime(2026, 6, 1, 10, 0, 0)
        after = datetime(2026, 6, 1, 14, 0, 0)
        m = _make_mandate(valid_from=before, valid_until=after)
        assert self.is_active(m, now=ref) is True

    def test_valid_until_exactly_now_is_inactive(self):
        ref = datetime(2026, 6, 1, 12, 0, 0)
        m = _make_mandate(valid_until=ref)
        assert self.is_active(m, now=ref) is False


class TestValidateDelegationDirection:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.validate = DelegationGraph.validate_delegation_direction

    def test_valid_human_to_orchestrator(self):
        assert self.validate("human", "orchestrator") is True

    def test_valid_human_to_worker(self):
        assert self.validate("human", "worker") is True

    def test_valid_human_to_service(self):
        assert self.validate("human", "service") is True

    def test_valid_orchestrator_to_worker(self):
        assert self.validate("orchestrator", "worker") is True

    def test_valid_orchestrator_to_service(self):
        assert self.validate("orchestrator", "service") is True

    def test_valid_worker_to_service(self):
        assert self.validate("worker", "service") is True

    def test_valid_peer_human_human(self):
        assert self.validate("human", "human") is True

    def test_valid_peer_orchestrator_orchestrator(self):
        assert self.validate("orchestrator", "orchestrator") is True

    def test_valid_peer_worker_worker(self):
        assert self.validate("worker", "worker") is True

    def test_invalid_service_to_any_raises(self):
        with pytest.raises(ValueError):
            self.validate("service", "human")

    def test_invalid_worker_to_human_raises(self):
        with pytest.raises(ValueError):
            self.validate("worker", "human")

    def test_invalid_orchestrator_to_human_raises(self):
        with pytest.raises(ValueError):
            self.validate("orchestrator", "human")

    def test_invalid_source_kind_raises(self):
        with pytest.raises(ValueError, match="Invalid source"):
            self.validate("robot", "human")

    def test_invalid_target_kind_raises(self):
        with pytest.raises(ValueError, match="Invalid target"):
            self.validate("human", "bot")


class TestGetDelegationType:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.get_type = DelegationGraph.get_delegation_type

    def test_same_type_is_peer(self):
        assert self.get_type("human", "human") == "peer"
        assert self.get_type("worker", "worker") == "peer"

    def test_different_type_is_directed(self):
        assert self.get_type("human", "service") == "directed"
        assert self.get_type("orchestrator", "worker") == "directed"


class TestScopeIsCoveredByUnion:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.covered = DelegationGraph._scope_is_covered_by_union

    def test_none_requested_is_denied(self):
        # Empty scope is deny-all.
        assert self.covered(None, [["res:*"]]) is False

    def test_empty_requested_is_denied(self):
        assert self.covered([], [["res:*"]]) is False

    def test_exact_match_covered(self):
        assert self.covered(["res:foo"], [["res:foo"]]) is True

    def test_wildcard_covers(self):
        assert self.covered(["res:foo"], [["res:*"]]) is True

    def test_unmatched_entry_not_covered(self):
        assert self.covered(["db:table"], [["res:*"]]) is False

    def test_multiple_sources_union_covers(self):
        assert self.covered(["res:a", "db:b"], [["res:*"], ["db:*"]]) is True

    def test_partial_coverage_fails(self):
        assert self.covered(["res:a", "db:b"], [["res:*"]]) is False


class TestResolveEdgeExpiration:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.resolve = DelegationGraph._resolve_edge_expiration

    def _mandate_with_expiry(self, valid_until):
        m = MagicMock(spec=["valid_until"])
        m.valid_until = valid_until
        return m

    def test_no_expiry_returns_none(self):
        src = self._mandate_with_expiry(None)
        tgt = self._mandate_with_expiry(None)
        result = self.resolve(source_mandate=src, target_mandate=tgt, requested_expires_at=None)
        assert result is None

    def test_min_of_all_expiries(self):
        t1 = datetime(2026, 12, 1)
        t2 = datetime(2026, 6, 1)
        t3 = datetime(2026, 9, 1)
        src = self._mandate_with_expiry(t1)
        tgt = self._mandate_with_expiry(t3)
        result = self.resolve(source_mandate=src, target_mandate=tgt, requested_expires_at=t2)
        assert result == t2

    def test_mandate_cap_applied(self):
        t1 = datetime(2026, 6, 1)
        src = self._mandate_with_expiry(t1)
        tgt = self._mandate_with_expiry(None)
        result = self.resolve(source_mandate=src, target_mandate=tgt, requested_expires_at=None)
        assert result == t1


class TestDelegationEdge:
    def test_from_model(self):
        from caracal.core.delegation_graph import DelegationEdge
        m = MagicMock()
        m.edge_id = uuid4()
        m.source_mandate_id = uuid4()
        m.target_mandate_id = uuid4()
        m.source_principal_kind = "human"
        m.target_principal_kind = "worker"
        m.delegation_type = "directed"
        m.context_tags = ["tag:a"]
        m.granted_at = datetime.utcnow()
        m.expires_at = None
        m.revoked = False
        m.revoked_at = None
        m.edge_metadata = {"note": "test"}
        edge = DelegationEdge.from_model(m)
        assert edge.edge_id == m.edge_id
        assert edge.source_principal_kind == "human"
        assert edge.target_principal_kind == "worker"
        assert edge.delegation_type == "directed"
        assert edge.context_tags == ["tag:a"]
        assert edge.metadata == {"note": "test"}

    def test_from_model_no_context_tags(self):
        from caracal.core.delegation_graph import DelegationEdge
        m = MagicMock()
        m.edge_id = uuid4()
        m.source_mandate_id = uuid4()
        m.target_mandate_id = uuid4()
        m.source_principal_kind = "orchestrator"
        m.target_principal_kind = "service"
        m.delegation_type = "directed"
        m.context_tags = None
        m.granted_at = datetime.utcnow()
        m.expires_at = None
        m.revoked = False
        m.revoked_at = None
        m.edge_metadata = None
        edge = DelegationEdge.from_model(m)
        assert edge.context_tags == []


def _mock_session_with_edge(edge_model=None):
    """Create a minimal session mock that returns a single edge or None."""
    session = MagicMock()
    query_result = MagicMock()
    filter_result = MagicMock()
    filter_result.all.return_value = [edge_model] if edge_model else []
    filter_result.first.return_value = edge_model
    query_result.filter.return_value = filter_result
    filter_result.filter.return_value = filter_result
    session.query.return_value = query_result
    return session


def _make_edge_model(
    edge_id=None,
    source_mandate_id=None,
    target_mandate_id=None,
    revoked=False,
    expires_at=None,
    source_principal_kind="human",
    target_principal_kind="worker",
    delegation_type="directed",
    context_tags=None,
    granted_at=None,
    edge_metadata=None,
):
    from datetime import datetime
    m = MagicMock()
    m.edge_id = edge_id or uuid4()
    m.source_mandate_id = source_mandate_id or uuid4()
    m.target_mandate_id = target_mandate_id or uuid4()
    m.revoked = revoked
    m.revoked_at = None
    m.expires_at = expires_at
    m.source_principal_kind = source_principal_kind
    m.target_principal_kind = target_principal_kind
    m.delegation_type = delegation_type
    m.context_tags = context_tags or []
    m.granted_at = granted_at or datetime.utcnow()
    m.edge_metadata = edge_metadata
    return m


class TestDelegationGraphMocked:
    def setup_method(self):
        from caracal.core.delegation_graph import DelegationGraph
        self.graph_cls = DelegationGraph

    def _make_graph(self, session=None):
        sess = session or MagicMock()
        return self.graph_cls(sess)

    def test_revoke_edge_not_found_raises(self):
        session = _mock_session_with_edge(None)
        graph = self._make_graph(session)
        with pytest.raises(ValueError, match="not found"):
            graph.revoke_edge(uuid4())

    def test_revoke_edge_already_revoked_raises(self):
        edge = _make_edge_model(revoked=True)
        session = _mock_session_with_edge(edge)
        graph = self._make_graph(session)
        with pytest.raises(ValueError, match="already revoked"):
            graph.revoke_edge(edge.edge_id)

    def test_revoke_edge_sets_revoked(self):
        edge = _make_edge_model(revoked=False)
        session = _mock_session_with_edge(edge)
        graph = self._make_graph(session)
        graph.revoke_edge(edge.edge_id, reason="test")
        assert edge.revoked is True

    def test_get_authority_sources_empty(self):
        session = _mock_session_with_edge(None)
        graph = self._make_graph(session)
        result = graph.get_authority_sources(uuid4())
        assert result == []

    def test_get_authority_sources_returns_edges(self):
        edge = _make_edge_model()
        session = _mock_session_with_edge(edge)
        graph = self._make_graph(session)
        result = graph.get_authority_sources(uuid4())
        assert len(result) == 1

    def test_get_delegated_targets_empty(self):
        session = _mock_session_with_edge(None)
        graph = self._make_graph(session)
        result = graph.get_delegated_targets(uuid4())
        assert result == []

    def test_validate_authority_path_same_id_active(self):
        mandate_id = uuid4()
        session = MagicMock()
        mandate = _make_mandate()
        session.query.return_value.filter.return_value.first.return_value = mandate
        graph = self._make_graph(session)
        assert graph.validate_authority_path(mandate_id, mandate_id) is True

    def test_validate_authority_path_same_id_inactive(self):
        mandate_id = uuid4()
        session = MagicMock()
        mandate = _make_mandate(revoked=True)
        session.query.return_value.filter.return_value.first.return_value = mandate
        graph = self._make_graph(session)
        assert graph.validate_authority_path(mandate_id, mandate_id) is False

    def test_get_effective_scope_missing_mandate(self):
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = None
        graph = self._make_graph(session)
        result = graph.get_effective_scope(uuid4())
        assert result == {"resource_scope": [], "action_scope": []}

    def test_check_delegation_path_returns_bool(self):
        mandate_id = uuid4()
        session = MagicMock()
        mandate = _make_mandate()
        session.query.return_value.filter.return_value.first.return_value = mandate
        graph = self._make_graph(session)
        result = graph.check_delegation_path(mandate_id)
        assert isinstance(result, bool)
