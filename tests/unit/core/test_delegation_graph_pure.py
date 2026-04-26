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

    def test_none_requested_is_covered(self):
        assert self.covered(None, [["res:*"]]) is True

    def test_empty_requested_is_covered(self):
        assert self.covered([], [["res:*"]]) is True

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
