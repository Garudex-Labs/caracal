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

        principal_id=principal_id,
        name=name,
        principal_kind=kind,
        owner="test",
        lifecycle_status="active",
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _policy(principal_id, *, allow_delegation: bool = False, max_distance: int = 0):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["provider:ops-api:resource:*"],
        allowed_actions=["provider:ops-api:action:*"],
        max_validity_seconds=3600,
        allow_delegation=allow_delegation,
        max_network_distance=max_distance,
        created_by="test",
        active=True,
    )


@pytest.mark.integration
class TestMandateIssuanceAndValidation:
    """Mandate creation, retrieval, and authority evaluation."""

    def test_issued_mandate_passes_validation(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        issuer = _principal(issuer_id, "issuer", "human")
        subject = _principal(subject_id, "subject", "worker")
        policy = _policy(issuer_id)
        db_session.add_all([issuer, subject, policy])
        db_session.flush()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.flush()

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
            _principal(issuer_id, "issuer", "human"),
            _principal(subject_id, "subject", "worker"),
            _policy(issuer_id),
        ])
        db_session.flush()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.flush()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:write_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False


@pytest.mark.integration
class TestMandateRevocation:
    """Mandate revocation produces authoritative denial."""

    def test_revoked_mandate_is_denied(self, db_session) -> None:
        issuer_id = uuid4()
        subject_id = uuid4()
        db_session.add_all([
            _principal(issuer_id, "issuer", "human"),
            _principal(subject_id, "subject", "worker"),
            _policy(issuer_id),
        ])
        db_session.flush()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.flush()

        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            actor_id=issuer_id,
            reason="integration test",
        )
        db_session.flush()

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
        from tests.helpers.crypto_signing import sign_mandate_for_test
        from caracal.db.models import ExecutionMandate

        issuer_id = uuid4()
        subject_id = uuid4()
        issuer = _principal(issuer_id, "issuer-exp", "human")
        subject = _principal(subject_id, "subject-exp", "worker")
        db_session.add_all([issuer, subject])
        db_session.flush()

        mandate_data = {
            "mandate_id": str(uuid4()),
            "issuer_id": str(issuer_id),
            "subject_id": str(subject_id),
            "valid_from": (datetime.utcnow() - timedelta(hours=2)).isoformat(),
            "valid_until": (datetime.utcnow() - timedelta(hours=1)).isoformat(),
            "resource_scope": ["provider:ops-api:resource:incident"],
            "action_scope": ["provider:ops-api:action:read_incident"],
            "delegation_type": "directed",
            "intent_hash": None,
        }
        sig = sign_mandate_for_test(mandate_data, issuer.public_key_pem)
        expired_mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=subject_id,
            valid_from=datetime.utcnow() - timedelta(hours=2),
            valid_until=datetime.utcnow() - timedelta(hours=1),
            signature=sig,
            revoked=False,
            delegation_type="directed",
            network_distance=0,
        )
        expired_mandate.resource_scope = ["provider:ops-api:resource:incident"]
        expired_mandate.action_scope = ["provider:ops-api:action:read_incident"]
        db_session.add(expired_mandate)
        db_session.flush()

        ledger = AuthorityLedgerWriter(db_session)
        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=expired_mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False
        assert decision.reason_code == AuthorityReasonCode.MANDATE_EXPIRED



@pytest.mark.integration
class TestMandateFlow:
    """Test complete mandate workflows."""
    
    @pytest.fixture(autouse=True)
    def setup(self, db_session):
        """Set up test database and dependencies."""
        # self.db = db_session
        # Setup will be implemented when components are available
        pass
    
    async def test_create_and_verify_mandate(self):
        """Test creating and verifying a mandate end-to-end."""
        # from caracal.core.authority import Authority
        # from caracal.core.mandate import Mandate
        
        # Arrange - Create authority
        # authority = await Authority.create(
        #     name="test-authority",
        #     scope="read:secrets"
        # )
        
        # Act - Create mandate
        # mandate = await Mandate.create(
        #     authority_id=authority.id,
        #     principal_id="user-123",
        #     scope="read:secrets"
        # )
        
        # Assert - Verify mandate
        # is_valid = await mandate.verify()
        # assert is_valid is True
        # assert mandate.authority_id == authority.id
        pass
    
    async def test_mandate_revocation_flow(self):
        """Test mandate revocation workflow."""
        # from caracal.core.authority import Authority
        # from caracal.core.mandate import Mandate
        
        # Arrange - Create authority and mandate
        # authority = await Authority.create(name="test-auth", scope="read:secrets")
        # mandate = await Mandate.create(
        #     authority_id=authority.id,
        #     principal_id="user-123",
        #     scope="read:secrets"
        # )
        
        # Act - Revoke mandate
        # await mandate.revoke()
        
        # Assert - Verify mandate is revoked
        # assert mandate.status == "revoked"
        # is_valid = await mandate.verify()
        # assert is_valid is False
        pass
    
    async def test_mandate_expiration_flow(self):
        """Test mandate expiration workflow."""
        # from caracal.core.mandate import Mandate
        # from datetime import datetime, timedelta
        
        # Arrange - Create mandate with short expiration
        # expires_at = datetime.utcnow() + timedelta(seconds=1)
        # mandate = await Mandate.create(
        #     authority_id="auth-123",
        #     principal_id="user-123",
        #     scope="read:secrets",
        #     expires_at=expires_at
        # )
        
        # Act - Wait for expiration
        # import asyncio
        # await asyncio.sleep(2)
        
        # Assert - Verify mandate is expired
        # assert mandate.is_expired() is True
        pass
