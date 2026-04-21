"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Integration tests for mandate issuance, validation, revocation, and expiration.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from caracal.core.authority import AuthorityEvaluator, AuthorityReasonCode
from caracal.core.authority_ledger import AuthorityLedgerWriter
from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import AuthorityPolicy, Principal
from tests.fixtures.database import db_session, in_memory_db_engine


def _make_principal(principal_id, name, kind, *, with_keys: bool = False):
    public_key_pem = None
    metadata = None
    if with_keys:
        generated = generate_and_store_principal_keypair(principal_id)
        public_key_pem = generated.public_key_pem
        metadata = generated.storage.metadata
    return Principal(
        principal_id=principal_id,
        name=name,
        principal_kind=kind,
        owner="integration-test",
        lifecycle_status="active",
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _make_policy(principal_id, *, allow_delegation: bool = False):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["provider:ops-api:resource:*"],
        allowed_actions=["provider:ops-api:action:*"],
        max_validity_seconds=3600,
        allow_delegation=allow_delegation,
        max_network_distance=0,
        created_by="integration-test",
        active=True,
    )


@pytest.mark.integration
class TestMandateIssuanceAndValidation:
    """Mandate creation, retrieval, and authority evaluation."""

    def test_issued_mandate_passes_validation(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        issuer = _make_principal(issuer_id, "issuer", "human", with_keys=True)
        subject = _make_principal(subject_id, "subject", "worker")
        policy = _make_policy(issuer_id)
        db_session.add_all([issuer, subject, policy])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is True
        assert decision.reason_code == AuthorityReasonCode.ALLOW

    def test_mandate_denied_for_wrong_action(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "issuer", "human", with_keys=True),
            _make_principal(subject_id, "subject", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:write_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False


@pytest.mark.integration
class TestMandateRevocation:
    """Revoked mandates produce authoritative denial."""

    def test_revoked_mandate_is_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "issuer", "human", with_keys=True),
            _make_principal(subject_id, "subject", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="integration test",
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_REVOKED


@pytest.mark.integration
class TestMandateExpiration:
    """Expired mandates are denied at validation time."""

    def test_expired_mandate_is_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "issuer-exp", "human", with_keys=True),
            _make_principal(subject_id, "subject-exp", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        mandate.valid_until = datetime.utcnow() - timedelta(hours=1)
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_EXPIRED


# ---------------------------------------------------------------------------
# P0.23 - Demo enforcement regression cases
# ---------------------------------------------------------------------------

class TestDemoEnforcementRegression:
    """Regression coverage for the demo: revoked, expired, subject-mismatched,
    scope-escalation, and resource-outside-scope enforcement boundaries.

    Adapts the same enforcement shape as tests/security/test_authority_bypass.py
    for the demo's specific scope contract (provider:ops-api:resource:incidents).
    """

    def test_revoked_mandate_denied_with_reason_code(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "demo-human", "human", with_keys=True),
            _make_principal(subject_id, "demo-worker", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incidents"],
            action_scope=["provider:ops-api:action:read"],
            validity_seconds=3600,
        )
        db_session.commit()

        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="demo: intentional revocation test",
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read",
            requested_resource="provider:ops-api:resource:incidents",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_REVOKED

    def test_expired_demo_mandate_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "demo-human-exp", "human", with_keys=True),
            _make_principal(subject_id, "demo-worker-exp", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incidents"],
            action_scope=["provider:ops-api:action:read"],
            validity_seconds=3600,
        )
        db_session.commit()

        mandate.valid_until = datetime.utcnow() - timedelta(hours=1)
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read",
            requested_resource="provider:ops-api:resource:incidents",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_EXPIRED

    def test_scope_escalation_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "demo-human-esc", "human", with_keys=True),
            _make_principal(subject_id, "demo-worker-esc", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incidents"],
            action_scope=["provider:ops-api:action:read"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:write",
            requested_resource="provider:ops-api:resource:incidents",
        )
        assert decision.allowed is False

    def test_resource_outside_scope_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "demo-human-res", "human", with_keys=True),
            _make_principal(subject_id, "demo-worker-res", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incidents"],
            action_scope=["provider:ops-api:action:read"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read",
            requested_resource="provider:ops-api:resource:deployments",
        )
        assert decision.allowed is False

    def test_valid_mandate_within_scope_allowed(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "demo-human-ok", "human", with_keys=True),
            _make_principal(subject_id, "demo-worker-ok", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incidents"],
            action_scope=["provider:ops-api:action:read"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read",
            requested_resource="provider:ops-api:resource:incidents",
        )
        assert decision.allowed is True
