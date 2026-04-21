"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

End-to-end tests for the mandate lifecycle across issue, validate, revoke, expire.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from caracal.core.authority import AuthorityEvaluator, AuthorityReasonCode
from caracal.core.authority_ledger import AuthorityLedgerWriter, AuthorityLedgerQuery
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
        owner="e2e-test",
        lifecycle_status="active",
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _make_policy(principal_id, *, allow_delegation: bool = False, max_distance: int = 0):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["provider:ops-api:resource:*"],
        allowed_actions=["provider:ops-api:action:*"],
        max_validity_seconds=3600,
        allow_delegation=allow_delegation,
        max_network_distance=max_distance,
        created_by="e2e-test",
        active=True,
    )


@pytest.mark.e2e
class TestMandateLifecycle:
    """Full issue → validate → revoke → deny lifecycle."""

    def test_issue_validate_revoke_deny(self, db_session) -> None:
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
        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)

        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        allow = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert allow.allowed is True

        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="e2e test revocation",
        )
        db_session.commit()

        deny = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert deny.allowed is False
        assert deny.reason_code == AuthorityReasonCode.MANDATE_REVOKED

    def test_ledger_records_all_lifecycle_events(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _make_principal(issuer_id, "issuer-lc", "human", with_keys=True),
            _make_principal(subject_id, "subject-lc", "worker"),
            _make_policy(issuer_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)

        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()
        evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="e2e lifecycle check",
        )
        db_session.commit()

        query = AuthorityLedgerQuery(db_session)
        events = query.get_events(mandate_id=mandate.mandate_id)
        event_types = {e.event_type for e in events}
        assert "issued" in event_types
        assert "validated" in event_types
        assert "revoked" in event_types

    def test_expired_mandate_denied_without_revocation(self, db_session) -> None:
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
