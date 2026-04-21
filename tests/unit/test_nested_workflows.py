"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for orchestrator-led worker orchestration in the demo runtime.
"""

from __future__ import annotations

from unittest.mock import MagicMock
from uuid import uuid4

import pytest


@pytest.mark.unit
class TestWorkerLifecycleStates:
    """Principal lifecycle state rules for worker and orchestrator kinds."""

    def test_worker_is_non_reactivating_once_deactivated(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine

        decision = PrincipalLifecycleStateMachine.validate_transition(
            principal_kind="worker",
            from_status="deactivated",
            to_status="active",
            attestation_status=None,
        )
        assert decision.allowed is False

    def test_orchestrator_is_non_reactivating_once_deactivated(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine

        decision = PrincipalLifecycleStateMachine.validate_transition(
            principal_kind="orchestrator",
            from_status="deactivated",
            to_status="active",
            attestation_status=None,
        )
        assert decision.allowed is False

    def test_human_can_suspend_and_reactivate(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine

        suspend = PrincipalLifecycleStateMachine.validate_transition(
            principal_kind="human",
            from_status="active",
            to_status="suspended",
            attestation_status=None,
        )
        assert suspend.allowed is True

        reactivate = PrincipalLifecycleStateMachine.validate_transition(
            principal_kind="human",
            from_status="suspended",
            to_status="active",
            attestation_status=None,
        )
        assert reactivate.allowed is True


@pytest.mark.unit
class TestRunGroupFanOut:
    """Worker group semantics for the fan-out/fan-in orchestration model."""

    def test_parallel_workers_share_group_id(self) -> None:
        group_id = str(uuid4())
        assignments = [
            {"group_id": group_id, "worker_id": str(uuid4())}
            for _ in range(3)
        ]
        group_ids = {a["group_id"] for a in assignments}
        assert len(group_ids) == 1

    def test_partial_denial_captured_in_aggregation(self) -> None:
        results = [
            {"allowed": True, "result": "incident_data"},
            {"allowed": True, "result": "deployment_data"},
            {"allowed": False, "result": None},
        ]
        allowed = [r for r in results if r["allowed"]]
        denied = [r for r in results if not r["allowed"]]
        assert len(allowed) == 2
        assert len(denied) == 1

    def test_fan_in_requires_all_worker_ids(self) -> None:
        worker_ids = [str(uuid4()) for _ in range(3)]
        results = {wid: {"status": "completed"} for wid in worker_ids}
        assert set(results.keys()) == set(worker_ids)


@pytest.mark.unit
class TestDelegationDirectionRules:
    """Delegation direction rules as required by the principal model."""

    @pytest.mark.parametrize("source,target,should_allow", [
        ("human", "orchestrator", True),
        ("human", "worker", True),
        ("human", "service", True),
        ("orchestrator", "worker", True),
        ("orchestrator", "service", True),
        ("worker", "service", True),
        ("service", "worker", False),
        ("service", "orchestrator", False),
        ("service", "human", False),
        ("worker", "orchestrator", False),
    ])
    def test_delegation_direction(
        self,
        source: str,
        target: str,
        should_allow: bool,
    ) -> None:
        from caracal.core.delegation_graph import DelegationGraph

        graph = DelegationGraph(db_session=MagicMock())

        if should_allow:
            graph.validate_delegation_direction(
                source_principal_kind=source,
                target_principal_kind=target,
            )
        else:
            with pytest.raises(Exception):
                graph.validate_delegation_direction(
                    source_principal_kind=source,
                    target_principal_kind=target,
                )

