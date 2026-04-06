"""
Unit tests for DelegationGraph lineage parity rules.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import Mock
from uuid import uuid4

from caracal.core.delegation_graph import DelegationGraph
from caracal.db.models import DelegationEdgeModel, ExecutionMandate, Principal


@pytest.mark.unit
class TestDelegationGraphLineageParity:
    """Test strict parity between mandate.source_mandate_id and graph edges."""

    def setup_method(self):
        self.mock_db_session = Mock()
        self.graph = DelegationGraph(self.mock_db_session)

    def test_add_edge_backfills_target_source_mandate_id_when_missing(self):
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
            source_mandate_id=None,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
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

        edge = self.graph.add_edge(
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            context_tags=["test"],
        )

        assert target_mandate.source_mandate_id == source_mandate_id
        assert edge.source_mandate_id == source_mandate_id
        assert edge.target_mandate_id == target_mandate_id
        self.mock_db_session.add.assert_called_once()

    def test_add_edge_rejects_mismatched_target_lineage(self):
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
            source_mandate_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
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

        with pytest.raises(ValueError, match="lineage mismatch"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )

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

    def test_add_edge_rejects_multiple_active_inbound_edges(self):
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=uuid4(),
            revoked=False,
            source_mandate_id=None,
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
            network_distance=1,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")
        existing_inbound = Mock(source_mandate_id=uuid4(), revoked=False)

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

        with pytest.raises(ValueError, match="Single-lineage violation"):
            self.graph.add_edge(
                source_mandate_id=source_mandate_id,
                target_mandate_id=target_mandate_id,
            )
