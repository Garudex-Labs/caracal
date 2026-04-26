"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Regression tests for fixed mandate validation bugs.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from caracal.core.authority import AuthorityEvaluator, AuthorityReasonCode
from tests.mock.builders import mandate as build_mandate


@pytest.mark.regression
class TestRevocationRegression:
    """Regression: revoked mandates must always be denied regardless of scope."""

    def setup_method(self) -> None:
        self.db = Mock()
        self.evaluator = AuthorityEvaluator(self.db)

    def test_revoked_with_valid_scope_denied(self) -> None:
        m = build_mandate(
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            revoked=True,
        )
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read:secrets",
            requested_resource="secret/test",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_REVOKED

    def test_revoked_with_active_time_window_denied(self) -> None:
        now = datetime.utcnow()
        m = build_mandate(
            valid_from=now - timedelta(minutes=5),
            valid_until=now + timedelta(hours=1),
            revoked=True,
        )
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:resource",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_REVOKED


@pytest.mark.regression
class TestSubjectBindingRegression:
    """Regression: caller ID mismatch must deny even with valid mandate data."""

    def setup_method(self) -> None:
        self.db = Mock()
        self.evaluator = AuthorityEvaluator(self.db)

    def test_caller_mismatch_denied(self) -> None:
        subject_id = uuid4()
        other_id = uuid4()
        m = build_mandate(subject_id=subject_id)
        active_principal = Mock(lifecycle_status="active")
        with patch.object(self.evaluator, "_get_principal", return_value=active_principal):
            decision = self.evaluator.validate_mandate(
                mandate=m,
                requested_action="read",
                requested_resource="test:resource",
                caller_principal_id=str(other_id),
            )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.SUBJECT_BINDING_DENIED

    def test_caller_match_advances_evaluation(self) -> None:
        subject_id = uuid4()
        m = build_mandate(subject_id=subject_id)
        active_principal = Mock(lifecycle_status="active")
        with patch.object(self.evaluator, "_get_principal", return_value=active_principal):
            decision = self.evaluator.validate_mandate(
                mandate=m,
                requested_action="read",
                requested_resource="test:resource",
                caller_principal_id=str(subject_id),
            )
        assert decision.reason_code != AuthorityReasonCode.SUBJECT_BINDING_DENIED


@pytest.mark.regression
class TestLifecycleRegression:
    """Regression: non-reactivating principal kinds must not be reactivated."""

    def test_worker_cannot_reactivate_after_deactivation(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine
        sm = PrincipalLifecycleStateMachine()
        decision = sm.validate_transition(
            principal_kind="worker",
            from_status="deactivated",
            to_status="active",
            attestation_status=None,
        )
        assert decision.allowed is False

    def test_orchestrator_cannot_reactivate_after_deactivation(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine
        sm = PrincipalLifecycleStateMachine()
        decision = sm.validate_transition(
            principal_kind="orchestrator",
            from_status="deactivated",
            to_status="active",
            attestation_status=None,
        )
        assert decision.allowed is False

    def test_human_can_reactivate_from_suspended(self) -> None:
        from caracal.core.lifecycle import PrincipalLifecycleStateMachine
        sm = PrincipalLifecycleStateMachine()
        decision = sm.validate_transition(
            principal_kind="human",
            from_status="suspended",
            to_status="active",
            attestation_status=None,
        )
        assert decision.allowed is True
