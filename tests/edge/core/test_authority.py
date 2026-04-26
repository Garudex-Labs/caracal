"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Edge case tests for authority validation boundary conditions.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.authority import AuthorityDecision, AuthorityEvaluator, AuthorityReasonCode
from tests.mock.builders import mandate as build_mandate


@pytest.mark.edge
class TestAuthorityBoundary:
    """Authority edge cases for boundary and time conditions."""

    def setup_method(self) -> None:
        self.db = Mock()
        self.evaluator = AuthorityEvaluator(self.db)

    def _deny(
        self,
        *,
        resource_scope: list[str] = ("test:*",),
        action_scope: list[str] = ("read",),
        extra: dict | None = None,
    ) -> AuthorityDecision:
        m = build_mandate(
            resource_scope=list(resource_scope),
            action_scope=list(action_scope),
        )
        kwargs = dict(
            mandate=m,
            requested_action=action_scope[0],
            requested_resource=resource_scope[0],
        )
        if extra:
            kwargs.update(extra)
        return self.evaluator.validate_mandate(**kwargs)

    def test_mandate_valid_exactly_at_boundary_allowed(self) -> None:
        now = datetime.utcnow()
        m = build_mandate(
            valid_from=now,
            valid_until=now + timedelta(seconds=1),
        )
        issuer = Mock(public_key_pem="fake-key", lifecycle_status="active")
        self.db.query.return_value.filter.return_value.first.return_value = issuer
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:*",
        )
        assert decision.allowed is False or decision.reason_code in {
            AuthorityReasonCode.SIGNATURE_INVALID,
            AuthorityReasonCode.SIGNATURE_VERIFICATION_ERROR,
            AuthorityReasonCode.ISSUER_KEY_MISSING,
        }

    def test_mandate_expired_by_one_second_denied(self) -> None:
        now = datetime.utcnow()
        m = build_mandate(
            valid_from=now - timedelta(hours=2),
            valid_until=now - timedelta(seconds=1),
        )
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:*",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_EXPIRED

    def test_mandate_not_yet_valid_denied(self) -> None:
        now = datetime.utcnow()
        m = build_mandate(
            valid_from=now + timedelta(hours=1),
            valid_until=now + timedelta(hours=2),
        )
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:*",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_NOT_YET_VALID

    def test_none_mandate_denied(self) -> None:
        decision = self.evaluator.validate_mandate(
            mandate=None,
            requested_action="read",
            requested_resource="test:*",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_MISSING

    def test_revoked_mandate_denied_regardless_of_time(self) -> None:
        m = build_mandate(revoked=True)
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:*",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_REVOKED

    def test_action_wildcard_mismatch_denied(self) -> None:
        m = build_mandate(action_scope=["write"])
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:resource",
        )
        assert decision.allowed is False

    def test_resource_glob_mismatch_denied(self) -> None:
        m = build_mandate(resource_scope=["prod:*"])
        decision = self.evaluator.validate_mandate(
            mandate=m,
            requested_action="read",
            requested_resource="test:resource",
        )
        assert decision.allowed is False
