"""Unit tests for principal lifecycle state-machine transitions."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.identity import PrincipalRegistry
from caracal.core.lifecycle import (
    LifecycleTransitionError,
    PrincipalLifecycleStateMachine,
)


@pytest.mark.unit
class TestPrincipalLifecycleStateMachine:
    def setup_method(self) -> None:
        self.state_machine = PrincipalLifecycleStateMachine()

    def test_human_can_reactivate_from_deactivated(self) -> None:
        decision = self.state_machine.validate_transition(
            principal_kind="human",
            from_status="deactivated",
            to_status="active",
        )
        assert decision.allowed is True

    def test_worker_cannot_reactivate_after_deactivation(self) -> None:
        decision = self.state_machine.validate_transition(
            principal_kind="worker",
            from_status="deactivated",
            to_status="active",
        )
        assert decision.allowed is False
        assert "non-reactivating" in decision.reason

    def test_orchestrator_cannot_resume_from_suspended(self) -> None:
        decision = self.state_machine.validate_transition(
            principal_kind="orchestrator",
            from_status="suspended",
            to_status="active",
        )
        assert decision.allowed is False

    def test_revoked_is_terminal_for_all_kinds(self) -> None:
        with pytest.raises(LifecycleTransitionError):
            self.state_machine.assert_transition_allowed(
                principal_kind="human",
                from_status="revoked",
                to_status="active",
            )


@pytest.mark.unit
class TestPrincipalRegistryLifecycleTransition:
    def setup_method(self) -> None:
        self.mock_session = Mock()
        self.registry = PrincipalRegistry(self.mock_session)

    def test_transition_lifecycle_status_updates_principal(self) -> None:
        principal_id = uuid4()
        row = SimpleNamespace(
            principal_id=principal_id,
            principal_kind="worker",
            lifecycle_status="active",
            principal_metadata={},
            name="worker-a",
            owner="tenant-a",
            created_at=datetime.utcnow(),
            public_key_pem=None,
            source_principal_id=None,
            attestation_status="pending",
        )

        self.registry._get_row = Mock(return_value=row)

        result = self.registry.transition_lifecycle_status(
            str(principal_id),
            "suspended",
            actor_principal_id="human-1",
        )

        assert row.lifecycle_status == "suspended"
        assert row.principal_metadata["lifecycle_status"] == "suspended"
        assert row.principal_metadata["lifecycle_transitioned_by"] == "human-1"
        self.mock_session.commit.assert_called_once()
        assert result.lifecycle_status == "suspended"

    def test_transition_lifecycle_status_blocks_worker_reactivation(self) -> None:
        principal_id = uuid4()
        row = SimpleNamespace(
            principal_id=principal_id,
            principal_kind="worker",
            lifecycle_status="deactivated",
            principal_metadata={},
            name="worker-b",
            owner="tenant-a",
            created_at=datetime.utcnow(),
            public_key_pem=None,
            source_principal_id=None,
            attestation_status="pending",
        )

        self.registry._get_row = Mock(return_value=row)

        with pytest.raises(LifecycleTransitionError):
            self.registry.transition_lifecycle_status(str(principal_id), "active")
