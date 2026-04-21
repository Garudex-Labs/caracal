"""
Integration tests for authority-ledger interactions.

Tests the integration between authority evaluation and ledger recording,
ensuring that authority operations are properly logged to the ledger.
"""
import pytest
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.core.authority import AuthorityEvaluator
from caracal.core.authority_ledger import AuthorityLedgerWriter, AuthorityLedgerQuery
from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import Principal, ExecutionMandate, AuthorityPolicy
from tests.fixtures.database import db_session, in_memory_db_engine


def _make_principal(
    principal_id,
    name,
    principal_kind,
    *,
    owner="integration-test",
    with_keys=False,
):
    metadata = None
    public_key_pem = None
    if with_keys:
        generated = generate_and_store_principal_keypair(principal_id)
        metadata = generated.storage.metadata
        public_key_pem = generated.public_key_pem

    return Principal(
        principal_id=principal_id,
        name=name,
        principal_kind=principal_kind,
        owner=owner,
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _make_policy(principal_id):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["test:*"],
        allowed_actions=["read", "write"],
        max_validity_seconds=3600,
        allow_delegation=False,
        max_network_distance=0,
        created_by="integration-test",
        active=True,
    )


@pytest.mark.integration
class TestAuthorityLedgerIntegration:
    """Test authority-ledger integration."""
    
    def test_authority_creation_writes_to_ledger(self, db_session):
        """Test that authority creation writes to ledger."""
        # Arrange: Create ledger writer and mandate manager
        ledger_writer = AuthorityLedgerWriter(db_session)
        mandate_manager = MandateManager(db_session, ledger_writer=ledger_writer)
        
        # Create issuer principal with keys
        issuer_id = uuid4()
        issuer = _make_principal(issuer_id, "test-issuer", "human", with_keys=True)
        db_session.add(issuer)

        # Create authority policy for issuer
        policy = _make_policy(issuer_id)
        db_session.add(policy)

        # Create subject principal
        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-subject", "worker")
        db_session.add(subject)
        db_session.commit()
        
        # Act: Issue a mandate (which should write to ledger)
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Assert: Check that ledger event was created
        ledger_query = AuthorityLedgerQuery(db_session)
        events = ledger_query.get_events(mandate_id=mandate.mandate_id)
        
        assert len(events) == 1
        assert events[0].event_type == "issued"
        assert events[0].mandate_id == mandate.mandate_id
        assert events[0].principal_id == subject_id
    
    def test_authority_updates_are_logged(self, db_session):
        """Test that authority updates are logged."""
        # Arrange: Create components
        ledger_writer = AuthorityLedgerWriter(db_session)
        mandate_manager = MandateManager(db_session, ledger_writer=ledger_writer)
        
        # Create principals
        issuer_id = uuid4()
        issuer = _make_principal(issuer_id, "test-issuer", "human", with_keys=True)
        db_session.add(issuer)

        policy = _make_policy(issuer_id)
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-subject", "worker")
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Act: Revoke the mandate (update operation)
        mandate_manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=issuer_id,
            reason="Test revocation",
            cascade=False
        )
        db_session.commit()
        
        # Assert: Check that both issuance and revocation are logged
        ledger_query = AuthorityLedgerQuery(db_session)
        events = ledger_query.get_events(mandate_id=mandate.mandate_id)
        
        assert len(events) == 2
        event_types = {event.event_type for event in events}
        assert "issued" in event_types
        assert "revoked" in event_types
    
    def test_authority_queries_use_ledger(self, db_session):
        """Test that authority queries use ledger."""
        # Arrange: Create components
        ledger_writer = AuthorityLedgerWriter(db_session)
        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger_writer)
        mandate_manager = MandateManager(db_session, ledger_writer=ledger_writer)
        
        # Create principals with keys
        issuer_id = uuid4()
        issuer = _make_principal(issuer_id, "test-issuer", "human", with_keys=True)
        db_session.add(issuer)

        policy = _make_policy(issuer_id)
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-subject", "worker")
        db_session.add(subject)
        db_session.commit()
        
        # Issue mandate
        mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600
        )
        db_session.commit()
        
        # Act: Validate the mandate (should write validation event to ledger)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        db_session.commit()
        
        # Assert: Check that validation event was logged
        ledger_query = AuthorityLedgerQuery(db_session)
        events = ledger_query.get_events(mandate_id=mandate.mandate_id)
        
        # Should have issuance and validation events
        assert len(events) >= 2
        event_types = {event.event_type for event in events}
        assert "issued" in event_types
        assert "validated" in event_types
        
        # Check validation event details
        validation_events = [e for e in events if e.event_type == "validated"]
        assert len(validation_events) == 1
        assert validation_events[0].decision == "allowed"
        assert validation_events[0].requested_action == "read"
        assert validation_events[0].requested_resource == "test:resource"
