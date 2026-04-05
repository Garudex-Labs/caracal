"""
Security tests for authority bypass attempts.

Tests that invalid authorities are rejected, expired mandates are rejected,
and revoked delegations are rejected to prevent security bypasses.
"""

import pytest
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.db.models import ExecutionMandate, Principal, AuthorityPolicy
from tests.helpers.crypto_signing import sign_mandate_for_test


@pytest.mark.security
class TestAuthorityBypassAttempts:
    """Security tests for authority bypass attempts."""
    
    def test_invalid_authority_rejected(self, db_session):
        """Test that mandates with invalid authorities are rejected."""
        evaluator = AuthorityEvaluator(db_session)
        
        # Create a mandate with no signature (invalid)
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow(),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["test:*"],
            action_scope=["read"],
            signature="",  # Invalid empty signature
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        # Validation should fail due to missing issuer
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "not found" in decision.reason.lower()
    
    def test_expired_mandate_rejected(self, db_session, crypto_fixtures):
        """Test that expired mandates are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        
        # Create an expired mandate
        mandate_data = {
            "mandate_id": str(uuid4()),
            "issuer_id": str(issuer.principal_id),
            "subject_id": str(subject.principal_id),
            "valid_from": (datetime.utcnow() - timedelta(hours=2)).isoformat(),
            "valid_until": (datetime.utcnow() - timedelta(hours=1)).isoformat(),
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        signature = sign_mandate_for_test(mandate_data, issuer.private_key_pem)
        
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=datetime.utcnow() - timedelta(hours=2),
            valid_until=datetime.utcnow() - timedelta(hours=1),  # Expired
            resource_scope=["test:*"],
            action_scope=["read"],
            signature=signature,
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Validation should fail due to expiration
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "expired" in decision.reason.lower()
    
    def test_not_yet_valid_mandate_rejected(self, db_session, crypto_fixtures):
        """Test that mandates not yet valid are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        
        # Create a mandate that's not yet valid
        mandate_data = {
            "mandate_id": str(uuid4()),
            "issuer_id": str(issuer.principal_id),
            "subject_id": str(subject.principal_id),
            "valid_from": (datetime.utcnow() + timedelta(hours=1)).isoformat(),
            "valid_until": (datetime.utcnow() + timedelta(hours=2)).isoformat(),
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        signature = sign_mandate_for_test(mandate_data, issuer.private_key_pem)
        
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=datetime.utcnow() + timedelta(hours=1),  # Not yet valid
            valid_until=datetime.utcnow() + timedelta(hours=2),
            resource_scope=["test:*"],
            action_scope=["read"],
            signature=signature,
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Validation should fail because mandate is not yet valid
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "not yet valid" in decision.reason.lower()
    
    def test_revoked_mandate_rejected(self, db_session, crypto_fixtures):
        """Test that revoked mandates are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        
        # Create a valid mandate
        mandate_data = {
            "mandate_id": str(uuid4()),
            "issuer_id": str(issuer.principal_id),
            "subject_id": str(subject.principal_id),
            "valid_from": datetime.utcnow().isoformat(),
            "valid_until": (datetime.utcnow() + timedelta(hours=1)).isoformat(),
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        signature = sign_mandate_for_test(mandate_data, issuer.private_key_pem)
        
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=datetime.utcnow(),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["test:*"],
            action_scope=["read"],
            signature=signature,
            revoked=True,  # Revoked
            revocation_reason="Security test",
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Validation should fail due to revocation
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "revoked" in decision.reason.lower()
    
    def test_scope_escalation_rejected(self, db_session, crypto_fixtures):
        """Test that scope escalation attempts are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        mandate_id = uuid4()
        valid_from = datetime.utcnow()
        valid_until = valid_from + timedelta(hours=1)
        
        # Create a mandate with limited scope
        mandate_data = {
            "mandate_id": str(mandate_id),
            "issuer_id": str(issuer.principal_id),
            "subject_id": str(subject.principal_id),
            "valid_from": valid_from.isoformat(),
            "valid_until": valid_until.isoformat(),
            "resource_scope": ["test:read-only"],  # Limited scope
            "action_scope": ["read"],  # Only read action
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        signature = sign_mandate_for_test(mandate_data, issuer.private_key_pem)
        
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=valid_from,
            valid_until=valid_until,
            resource_scope=["test:read-only"],
            action_scope=["read"],
            signature=signature,
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Attempt to use mandate for write action (escalation)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="write",  # Not in scope
            requested_resource="test:read-only"
        )
        
        assert decision.allowed is False
        assert "not in mandate scope" in decision.reason.lower()
    
    def test_resource_escalation_rejected(self, db_session, crypto_fixtures):
        """Test that resource escalation attempts are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        mandate_id = uuid4()
        valid_from = datetime.utcnow()
        valid_until = valid_from + timedelta(hours=1)
        
        # Create a mandate with limited resource scope
        mandate_data = {
            "mandate_id": str(mandate_id),
            "issuer_id": str(issuer.principal_id),
            "subject_id": str(subject.principal_id),
            "valid_from": valid_from.isoformat(),
            "valid_until": valid_until.isoformat(),
            "resource_scope": ["test:specific-resource"],  # Specific resource only
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        signature = sign_mandate_for_test(mandate_data, issuer.private_key_pem)
        
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=valid_from,
            valid_until=valid_until,
            resource_scope=["test:specific-resource"],
            action_scope=["read"],
            signature=signature,
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Attempt to access different resource (escalation)
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:admin-resource"  # Not in scope
        )
        
        assert decision.allowed is False
        assert "not in mandate scope" in decision.reason.lower()
    
    def test_invalid_signature_rejected(self, db_session, crypto_fixtures):
        """Test that mandates with invalid signatures are rejected."""
        issuer = crypto_fixtures["issuer"]
        subject = crypto_fixtures["subject"]
        
        # Create a mandate with invalid signature
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            valid_from=datetime.utcnow(),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["test:*"],
            action_scope=["read"],
            signature="invalid_signature_12345",  # Invalid signature
            revoked=False,
            delegation_type="directed",
            network_distance=0
        )
        
        db_session.add(mandate)
        db_session.flush()
        
        evaluator = AuthorityEvaluator(db_session)
        
        # Validation should fail due to invalid signature
        decision = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "signature" in decision.reason.lower() or "invalid" in decision.reason.lower()
    
    def test_null_mandate_rejected(self, db_session):
        """Test that null/None mandates are rejected."""
        evaluator = AuthorityEvaluator(db_session)
        
        # Validation with None mandate should fail
        decision = evaluator.validate_mandate(
            mandate=None,
            requested_action="read",
            requested_resource="test:resource"
        )
        
        assert decision.allowed is False
        assert "no mandate" in decision.reason.lower()
