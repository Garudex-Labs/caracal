"""Unit tests for DelegationGraph graph-safe authority rules."""

import pytest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from caracal.core.delegation_graph import DelegationGraph
from caracal.db.models import DelegationEdgeModel, ExecutionMandate, Principal


@pytest.mark.unit
class TestDelegationGraphLineageParity:
    """Test graph-safe delegation semantics after single-lineage removal."""

    def setup_method(self):
        self.mock_db_session = Mock()
        self.graph = DelegationGraph(self.mock_db_session)

    def test_add_edge_allows_target_without_denormalized_lineage(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=None,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:openai:models"],
            action_scope=["infer"],
            network_distance=1,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")

        mandate_query_count = {"count": 0}
        principal_query_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                else:
                    query.filter.return_value.first.return_value = target_mandate
            elif model == Principal:
                principal_query_count["count"] += 1
                if principal_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_principal
                else:
                    query.filter.return_value.first.return_value = target_principal
            elif model == DelegationEdgeModel:
                query.filter.return_value.first.return_value = None
            return query

        self.mock_db_session.query.side_effect = query_side_effect
        self.graph.get_authority_sources = Mock(return_value=[])

        edge = self.graph.add_edge(
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            context_tags=["test"],
        )

        assert target_mandate.source_mandate_id is None
        assert edge.source_mandate_id == source_mandate_id
        assert edge.target_mandate_id == target_mandate_id
        self.mock_db_session.add.assert_called_once()

    def test_add_edge_ignores_stale_denormalized_target_lineage(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:openai:models"],
            action_scope=["infer"],
            network_distance=1,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")

        mandate_query_count = {"count": 0}
        principal_query_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                else:
                    query.filter.return_value.first.return_value = target_mandate
            elif model == Principal:
                principal_query_count["count"] += 1
                if principal_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_principal
                else:
                    query.filter.return_value.first.return_value = target_principal
            elif model == DelegationEdgeModel:
                query.filter.return_value.first.return_value = None
            return query

        self.mock_db_session.query.side_effect = query_side_effect
        self.graph.get_authority_sources = Mock(return_value=[])

        edge = self.graph.add_edge(
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
        )

        assert edge.source_mandate_id == source_mandate_id
        assert edge.target_mandate_id == target_mandate_id

    def test_add_edge_rejects_expired_source_mandate(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(hours=2),
            valid_until=datetime.utcnow() - timedelta(minutes=1),
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=source_mandate_id,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            network_distance=1,
        )

        mandate_query_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                else:
                    query.filter.return_value.first.return_value = target_mandate
            return query

        self.mock_db_session.query.side_effect = query_side_effect

        with pytest.raises(ValueError, match="is not active"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )

    def test_add_edge_rejects_network_distance_mismatch(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=source_mandate_id,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            network_distance=2,
        )

        mandate_query_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                else:
                    query.filter.return_value.first.return_value = target_mandate
            return query

        self.mock_db_session.query.side_effect = query_side_effect

        with pytest.raises(ValueError, match="network_distance mismatch"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )

    def test_validate_authority_path_fails_closed_for_inactive_target(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            network_distance=2,
        )
        inactive_target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(hours=2),
            valid_until=datetime.utcnow() - timedelta(minutes=1),
            network_distance=1,
        )

        self.graph._get_mandate = Mock(
            side_effect=lambda mandate_id: (
                source_mandate
                if mandate_id == source_mandate_id
                else inactive_target_mandate
                if mandate_id == target_mandate_id
                else None
            )
        )
        self.graph.get_delegated_targets = Mock(return_value=[])

        assert self.graph.validate_authority_path(source_mandate_id, target_mandate_id) is False

    def test_add_edge_rejects_cycle_when_reverse_path_exists(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=None,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=source_mandate_id,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:openai:models"],
            action_scope=["infer"],
            network_distance=1,
        )

        self.graph._get_mandate = Mock(
            side_effect=lambda mandate_id: (
                source_mandate
                if mandate_id == source_mandate_id
                else target_mandate
                if mandate_id == target_mandate_id
                else None
            )
        )
        self.graph._is_mandate_active = Mock(return_value=True)
        self.graph.validate_authority_path = Mock(return_value=True)

        with pytest.raises(ValueError, match="cycle detected"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )

        self.graph.validate_authority_path.assert_called_once_with(
            target_mandate_id,
            source_mandate_id,
        )

    def test_add_edge_allows_multiple_active_inbound_edges(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=None,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=source_mandate_id,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:openai:models"],
            action_scope=["infer"],
            network_distance=1,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")
        existing_inbound = Mock(source_mandate_id=uuid4(), revoked=False)
        existing_source_mandate = Mock(
            mandate_id=existing_inbound.source_mandate_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:*"],
            action_scope=["infer"],
            network_distance=3,
        )

        mandate_query_count = {"count": 0}
        principal_query_count = {"count": 0}
        edge_first_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                else:
                    query.filter.return_value.first.return_value = target_mandate
            elif model == Principal:
                principal_query_count["count"] += 1
                if principal_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_principal
                else:
                    query.filter.return_value.first.return_value = target_principal
            elif model == DelegationEdgeModel:
                edge_first_count["count"] += 1
                # 1) reverse-path seed check, 2) duplicate source-target check, 3) active inbound check
                if edge_first_count["count"] in (1, 2):
                    query.filter.return_value.first.return_value = None
                else:
                    query.filter.return_value.first.return_value = existing_inbound
            return query

        self.mock_db_session.query.side_effect = query_side_effect
        self.graph.get_authority_sources = Mock(
            return_value=[SimpleNamespace(source_mandate_id=existing_inbound.source_mandate_id)]
        )
        self.graph._get_mandate = Mock(
            side_effect=lambda mandate_id: (
                source_mandate
                if mandate_id == source_mandate_id
                else target_mandate
                if mandate_id == target_mandate_id
                else existing_source_mandate
            )
        )

        edge = self.graph.add_edge(
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
        )

        assert edge.source_mandate_id == source_mandate_id
        assert edge.target_mandate_id == target_mandate_id

    def test_add_edge_rejects_scope_amplification_beyond_source_union(self):
        source_mandate_id = uuid4()
        other_source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:openai:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        other_source_mandate = Mock(
            mandate_id=other_source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=["provider:anthropic:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        target_mandate = Mock(
            mandate_id=target_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
            resource_scope=[
                "provider:openai:models",
                "provider:anthropic:models",
                "provider:google:models",
            ],
            action_scope=["infer"],
            network_distance=1,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")

        mandate_lookup = {
            source_mandate_id: source_mandate,
            other_source_mandate_id: other_source_mandate,
            target_mandate_id: target_mandate,
        }

        mandate_query_count = {"count": 0}
        principal_query_count = {"count": 0}
        edge_query_count = {"count": 0}

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                mandate_query_count["count"] += 1
                if mandate_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_mandate
                elif mandate_query_count["count"] == 2:
                    query.filter.return_value.first.return_value = target_mandate
                else:
                    predicate = query.filter.call_args
                    query.filter.return_value.first.side_effect = lambda: None
            elif model == Principal:
                principal_query_count["count"] += 1
                if principal_query_count["count"] == 1:
                    query.filter.return_value.first.return_value = source_principal
                else:
                    query.filter.return_value.first.return_value = target_principal
            elif model == DelegationEdgeModel:
                edge_query_count["count"] += 1
                query.filter.return_value.first.return_value = None
                query.filter.return_value.all.return_value = []
            return query

        self.mock_db_session.query.side_effect = query_side_effect
        self.graph.get_authority_sources = Mock(
            return_value=[SimpleNamespace(source_mandate_id=other_source_mandate_id)]
        )
        self.graph._get_mandate = Mock(side_effect=lambda mandate_id: mandate_lookup.get(mandate_id))

        with pytest.raises(ValueError, match="source union"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )

    def test_get_effective_scope_uses_union_of_active_sources(self):
        target_mandate_id = uuid4()
        source_one_id = uuid4()
        source_two_id = uuid4()

        target_mandate = SimpleNamespace(
            mandate_id=target_mandate_id,
            revoked=False,
            resource_scope=["provider:openai:models", "provider:anthropic:models"],
            action_scope=["infer", "embed"],
        )
        source_one = SimpleNamespace(
            mandate_id=source_one_id,
            revoked=False,
            resource_scope=["provider:openai:*"],
            action_scope=["infer"],
        )
        source_two = SimpleNamespace(
            mandate_id=source_two_id,
            revoked=False,
            resource_scope=["provider:anthropic:*"],
            action_scope=["embed"],
        )

        mandate_lookup = {
            target_mandate_id: target_mandate,
            source_one_id: source_one,
            source_two_id: source_two,
        }
        self.graph.get_authority_sources = Mock(
            return_value=[
                SimpleNamespace(source_mandate_id=source_one_id),
                SimpleNamespace(source_mandate_id=source_two_id),
            ]
        )

        def query_side_effect(model):
            query = Mock()
            if model == ExecutionMandate:
                query.filter.return_value.first.side_effect = lambda: mandate_lookup.popitem()[1]
            return query

        self.mock_db_session.query.side_effect = query_side_effect
        self.graph._get_mandate = Mock(side_effect=lambda mandate_id: {
            target_mandate_id: target_mandate,
            source_one_id: source_one,
            source_two_id: source_two,
        }.get(mandate_id))

        mandate_sequence = iter([target_mandate, source_one, source_two])

        def _execution_query(_model):
            query = Mock()
            query.filter.return_value.first.side_effect = lambda: next(mandate_sequence)
            return query

        self.mock_db_session.query.side_effect = _execution_query

        effective_scope = self.graph.get_effective_scope(target_mandate_id)

        assert effective_scope == {
            "resource_scope": ["provider:anthropic:models", "provider:openai:models"],
            "action_scope": ["embed", "infer"],
        }

    def test_validate_authority_path_supports_one_to_many_graphs(self):
        source_mandate_id = uuid4()
        target_one_id = uuid4()
        target_two_id = uuid4()

        source_mandate = SimpleNamespace(
            mandate_id=source_mandate_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )
        target_one = SimpleNamespace(
            mandate_id=target_one_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )
        target_two = SimpleNamespace(
            mandate_id=target_two_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )

        self.graph._get_mandate = Mock(
            side_effect=lambda mandate_id: {
                source_mandate_id: source_mandate,
                target_one_id: target_one,
                target_two_id: target_two,
            }.get(mandate_id)
        )
        self.graph.get_delegated_targets = Mock(
            side_effect=lambda mandate_id, active_only=True: (
                [
                    SimpleNamespace(target_mandate_id=target_one_id),
                    SimpleNamespace(target_mandate_id=target_two_id),
                ]
                if mandate_id == source_mandate_id and active_only
                else []
            )
        )

        assert self.graph.validate_authority_path(source_mandate_id, target_one_id) is True
        assert self.graph.validate_authority_path(source_mandate_id, target_two_id) is True

    def test_validate_authority_path_supports_many_to_many_graphs(self):
        source_a_id = uuid4()
        source_b_id = uuid4()
        target_a_id = uuid4()
        target_b_id = uuid4()

        active_mandates = {
            source_a_id: SimpleNamespace(
                mandate_id=source_a_id,
                revoked=False,
                valid_from=datetime.utcnow() - timedelta(minutes=5),
                valid_until=datetime.utcnow() + timedelta(minutes=30),
            ),
            source_b_id: SimpleNamespace(
                mandate_id=source_b_id,
                revoked=False,
                valid_from=datetime.utcnow() - timedelta(minutes=5),
                valid_until=datetime.utcnow() + timedelta(minutes=30),
            ),
            target_a_id: SimpleNamespace(
                mandate_id=target_a_id,
                revoked=False,
                valid_from=datetime.utcnow() - timedelta(minutes=5),
                valid_until=datetime.utcnow() + timedelta(minutes=30),
            ),
            target_b_id: SimpleNamespace(
                mandate_id=target_b_id,
                revoked=False,
                valid_from=datetime.utcnow() - timedelta(minutes=5),
                valid_until=datetime.utcnow() + timedelta(minutes=30),
            ),
        }

        edges_by_source = {
            source_a_id: [
                SimpleNamespace(target_mandate_id=target_a_id),
                SimpleNamespace(target_mandate_id=target_b_id),
            ],
            source_b_id: [
                SimpleNamespace(target_mandate_id=target_a_id),
                SimpleNamespace(target_mandate_id=target_b_id),
            ],
        }

        self.graph._get_mandate = Mock(side_effect=lambda mandate_id: active_mandates.get(mandate_id))
        self.graph.get_delegated_targets = Mock(
            side_effect=lambda mandate_id, active_only=True: edges_by_source.get(mandate_id, [])
            if active_only
            else []
        )

        assert self.graph.validate_authority_path(source_a_id, target_b_id) is True
        assert self.graph.validate_authority_path(source_b_id, target_a_id) is True


@pytest.mark.unit
class TestDelegationGraphStaticMethods:
    """Tests for static/pure methods that require no DB."""

    # ------------------------------------------------------------------ #
    # _is_mandate_active
    # ------------------------------------------------------------------ #

    def test_active_mandate_returns_true(self):
        m = Mock(
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )
        assert DelegationGraph._is_mandate_active(m) is True

    def test_none_mandate_returns_false(self):
        assert DelegationGraph._is_mandate_active(None) is False

    def test_revoked_mandate_returns_false(self):
        m = Mock(
            revoked=True,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )
        assert DelegationGraph._is_mandate_active(m) is False

    def test_not_yet_valid_returns_false(self):
        m = Mock(
            revoked=False,
            valid_from=datetime.utcnow() + timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )
        assert DelegationGraph._is_mandate_active(m) is False

    def test_expired_mandate_returns_false(self):
        m = Mock(
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(hours=2),
            valid_until=datetime.utcnow() - timedelta(minutes=1),
        )
        assert DelegationGraph._is_mandate_active(m) is False

    def test_no_time_bounds_active(self):
        m = Mock(revoked=False, valid_from=None, valid_until=None)
        assert DelegationGraph._is_mandate_active(m) is True

    def test_custom_now_parameter(self):
        now = datetime(2025, 1, 1, 12, 0, 0)
        m = Mock(
            revoked=False,
            valid_from=datetime(2024, 1, 1),
            valid_until=datetime(2026, 1, 1),
        )
        assert DelegationGraph._is_mandate_active(m, now=now) is True

    # ------------------------------------------------------------------ #
    # _scope_is_covered_by_union
    # ------------------------------------------------------------------ #

    def test_empty_requested_scope_denied(self):
        # Empty scope is deny-all: a mandate with no scopes grants nothing.
        assert DelegationGraph._scope_is_covered_by_union([], [["*"]]) is False

    def test_none_requested_scope_denied(self):
        assert DelegationGraph._scope_is_covered_by_union(None, [["*"]]) is False

    def test_exact_match_covered(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["infer"], [["infer"]]
        ) is True

    def test_wildcard_covers_entry(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["infer"], [["*"]]
        ) is True

    def test_partial_coverage_fails(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["infer", "embed"], [["infer"]]
        ) is False

    def test_union_of_two_scopes_covers_both(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["infer", "embed"],
            [["infer"], ["embed"]],
        ) is True

    def test_empty_source_scopes_fails_for_non_empty_request(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["infer"], []
        ) is False

    def test_prefix_wildcard_covers(self):
        assert DelegationGraph._scope_is_covered_by_union(
            ["read:docs"], [["read:*"]]
        ) is True

    # ------------------------------------------------------------------ #
    # _resolve_edge_expiration
    # ------------------------------------------------------------------ #

    def test_all_none_returns_none(self):
        src = Mock(valid_until=None)
        tgt = Mock(valid_until=None)
        result = DelegationGraph._resolve_edge_expiration(
            source_mandate=src,
            target_mandate=tgt,
            requested_expires_at=None,
        )
        assert result is None

    def test_picks_min_of_all_three(self):
        soon = datetime.utcnow() + timedelta(minutes=10)
        later = datetime.utcnow() + timedelta(hours=1)
        latest = datetime.utcnow() + timedelta(hours=2)
        src = Mock(valid_until=later)
        tgt = Mock(valid_until=latest)
        result = DelegationGraph._resolve_edge_expiration(
            source_mandate=src,
            target_mandate=tgt,
            requested_expires_at=soon,
        )
        assert result == soon

    def test_source_mandate_limits_edge(self):
        early = datetime.utcnow() + timedelta(hours=1)
        src = Mock(valid_until=early)
        tgt = Mock(valid_until=None)
        result = DelegationGraph._resolve_edge_expiration(
            source_mandate=src,
            target_mandate=tgt,
            requested_expires_at=None,
        )
        assert result == early

    def test_requested_beyond_mandate_capped(self):
        mandate_end = datetime.utcnow() + timedelta(hours=1)
        far_future = datetime.utcnow() + timedelta(days=365)
        src = Mock(valid_until=mandate_end)
        tgt = Mock(valid_until=None)
        result = DelegationGraph._resolve_edge_expiration(
            source_mandate=src,
            target_mandate=tgt,
            requested_expires_at=far_future,
        )
        assert result == mandate_end

    # ------------------------------------------------------------------ #
    # validate_delegation_direction
    # ------------------------------------------------------------------ #

    def test_human_to_orchestrator_allowed(self):
        assert DelegationGraph.validate_delegation_direction("human", "orchestrator") is True

    def test_human_to_worker_allowed(self):
        assert DelegationGraph.validate_delegation_direction("human", "worker") is True

    def test_human_to_service_allowed(self):
        assert DelegationGraph.validate_delegation_direction("human", "service") is True

    def test_orchestrator_to_worker_allowed(self):
        assert DelegationGraph.validate_delegation_direction("orchestrator", "worker") is True

    def test_orchestrator_to_service_allowed(self):
        assert DelegationGraph.validate_delegation_direction("orchestrator", "service") is True

    def test_worker_to_service_allowed(self):
        assert DelegationGraph.validate_delegation_direction("worker", "service") is True

    def test_peer_human_allowed(self):
        assert DelegationGraph.validate_delegation_direction("human", "human") is True

    def test_peer_orchestrator_allowed(self):
        assert DelegationGraph.validate_delegation_direction("orchestrator", "orchestrator") is True

    def test_peer_worker_allowed(self):
        assert DelegationGraph.validate_delegation_direction("worker", "worker") is True

    def test_service_to_service_blocked(self):
        with pytest.raises(ValueError, match="terminal"):
            DelegationGraph.validate_delegation_direction("service", "service")

    def test_service_to_human_blocked(self):
        with pytest.raises(ValueError):
            DelegationGraph.validate_delegation_direction("service", "human")

    def test_worker_to_human_blocked(self):
        with pytest.raises(ValueError):
            DelegationGraph.validate_delegation_direction("worker", "human")

    def test_orchestrator_to_human_blocked(self):
        with pytest.raises(ValueError):
            DelegationGraph.validate_delegation_direction("orchestrator", "human")

    def test_invalid_source_raises(self):
        with pytest.raises(ValueError, match="Invalid source"):
            DelegationGraph.validate_delegation_direction("alien", "human")

    def test_invalid_target_raises(self):
        with pytest.raises(ValueError, match="Invalid target"):
            DelegationGraph.validate_delegation_direction("human", "alien")

    # ------------------------------------------------------------------ #
    # get_delegation_type
    # ------------------------------------------------------------------ #

    def test_same_kind_returns_peer(self):
        assert DelegationGraph.get_delegation_type("human", "human") == "peer"
        assert DelegationGraph.get_delegation_type("worker", "worker") == "peer"

    def test_different_kind_returns_directed(self):
        assert DelegationGraph.get_delegation_type("human", "worker") == "directed"
        assert DelegationGraph.get_delegation_type("orchestrator", "service") == "directed"
