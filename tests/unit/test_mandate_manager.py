"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for MandateManager.

Tests the mandate management functionality including issuance, revocation,
and delegation.
"""

import pytest
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.core.mandate import MandateManager
from caracal.core.intent import Intent
from caracal.db.models import ExecutionMandate, AuthorityPolicy, Principal
from caracal.db.connection import get_session


@pytest.fixture
def db_session():
    """Create a test database session."""
    session = get_session()
    yield session
    session.rollback()
    session.close()


@pytest.fixture
def test_principal(db_session):
    """Create a test principal with keys."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.backends import default_backend
    
    # Generate ECDSA P-256 key pair
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()
    
    # Serialize keys to PEM format
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    
    principal = Principal(
        principal_id=uuid4(),
        name=f"test_principal_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner",
        private_key_pem=private_pem,
        public_key_pem=public_pem
    )
    
    db_session.add(principal)
    db_session.flush()
    
    return principal


@pytest.fixture
def test_policy(db_session, test_principal):
    """Create a test authority policy."""
    policy = AuthorityPolicy(
        policy_id=uuid4(),
        principal_id=test_principal.principal_id,
        max_validity_seconds=3600,
        allowed_resource_patterns=["api:*", "database:*"],
        allowed_actions=["api_call", "database_query"],
        allow_delegation=True,
        max_delegation_depth=2,
        created_by="test",
        active=True
    )
    
    db_session.add(policy)
    db_session.flush()
    
    return policy


def test_mandate_manager_initialization(db_session):
    """Test MandateManager initialization."""
    manager = MandateManager(db_session)
    assert manager.db_session == db_session
    assert manager.ledger_writer is None


def test_issue_mandate_success(db_session, test_principal, test_policy):
    """Test successful mandate issuance."""
    manager = MandateManager(db_session)
    
    # Create a subject principal
    subject = Principal(
        principal_id=uuid4(),
        name=f"subject_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(subject)
    db_session.flush()
    
    # Issue mandate
    mandate = manager.issue_mandate(
        issuer_id=test_principal.principal_id,
        subject_id=subject.principal_id,
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        validity_seconds=1800
    )
    
    # Verify mandate properties
    assert mandate.mandate_id is not None
    assert mandate.issuer_id == test_principal.principal_id
    assert mandate.subject_id == subject.principal_id
    assert mandate.resource_scope == ["api:openai:gpt-4"]
    assert mandate.action_scope == ["api_call"]
    assert mandate.signature is not None
    assert mandate.revoked is False
    assert mandate.delegation_depth == 0


def test_issue_mandate_no_policy(db_session, test_principal):
    """Test mandate issuance fails without active policy."""
    manager = MandateManager(db_session)
    
    # Create a principal without policy
    issuer = Principal(
        principal_id=uuid4(),
        name=f"no_policy_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(issuer)
    db_session.flush()
    
    subject = Principal(
        principal_id=uuid4(),
        name=f"subject_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(subject)
    db_session.flush()
    
    # Attempt to issue mandate should fail
    with pytest.raises(ValueError, match="does not have an active authority policy"):
        manager.issue_mandate(
            issuer_id=issuer.principal_id,
            subject_id=subject.principal_id,
            resource_scope=["api:openai:gpt-4"],
            action_scope=["api_call"],
            validity_seconds=1800
        )


def test_revoke_mandate_success(db_session, test_principal, test_policy):
    """Test successful mandate revocation."""
    manager = MandateManager(db_session)
    
    # Create subject
    subject = Principal(
        principal_id=uuid4(),
        name=f"subject_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(subject)
    db_session.flush()
    
    # Issue mandate
    mandate = manager.issue_mandate(
        issuer_id=test_principal.principal_id,
        subject_id=subject.principal_id,
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        validity_seconds=1800
    )
    
    # Revoke mandate
    manager.revoke_mandate(
        mandate_id=mandate.mandate_id,
        revoker_id=test_principal.principal_id,
        reason="Test revocation",
        cascade=False
    )
    
    # Verify revocation
    db_session.refresh(mandate)
    assert mandate.revoked is True
    assert mandate.revoked_at is not None
    assert mandate.revocation_reason == "Test revocation"


def test_revoke_mandate_already_revoked(db_session, test_principal, test_policy):
    """Test revoking an already revoked mandate fails."""
    manager = MandateManager(db_session)
    
    # Create subject
    subject = Principal(
        principal_id=uuid4(),
        name=f"subject_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(subject)
    db_session.flush()
    
    # Issue and revoke mandate
    mandate = manager.issue_mandate(
        issuer_id=test_principal.principal_id,
        subject_id=subject.principal_id,
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        validity_seconds=1800
    )
    
    manager.revoke_mandate(
        mandate_id=mandate.mandate_id,
        revoker_id=test_principal.principal_id,
        reason="First revocation",
        cascade=False
    )
    
    # Attempt to revoke again should fail
    with pytest.raises(ValueError, match="is already revoked"):
        manager.revoke_mandate(
            mandate_id=mandate.mandate_id,
            revoker_id=test_principal.principal_id,
            reason="Second revocation",
            cascade=False
        )


def test_delegate_mandate_success(db_session, test_principal, test_policy):
    """Test successful mandate delegation."""
    manager = MandateManager(db_session)
    
    # Create subject with policy for delegation
    subject = Principal(
        principal_id=uuid4(),
        name=f"subject_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(subject)
    db_session.flush()
    
    # Create policy for subject (allows delegation)
    subject_policy = AuthorityPolicy(
        policy_id=uuid4(),
        principal_id=subject.principal_id,
        max_validity_seconds=3600,
        allowed_resource_patterns=["api:*"],
        allowed_actions=["api_call"],
        allow_delegation=True,
        max_delegation_depth=2,
        created_by="test",
        active=True
    )
    db_session.add(subject_policy)
    db_session.flush()
    
    # Issue parent mandate
    parent_mandate = manager.issue_mandate(
        issuer_id=test_principal.principal_id,
        subject_id=subject.principal_id,
        resource_scope=["api:openai:*"],
        action_scope=["api_call"],
        validity_seconds=3600
    )
    
    # Create child subject
    child_subject = Principal(
        principal_id=uuid4(),
        name=f"child_{uuid4().hex[:8]}",
        principal_type="agent",
        owner="test_owner"
    )
    db_session.add(child_subject)
    db_session.flush()
    
    # Delegate mandate
    child_mandate = manager.delegate_mandate(
        parent_mandate_id=parent_mandate.mandate_id,
        child_subject_id=child_subject.principal_id,
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        validity_seconds=1800
    )
    
    # Verify delegation
    assert child_mandate.parent_mandate_id == parent_mandate.mandate_id
    assert child_mandate.delegation_depth == 1
    assert child_mandate.subject_id == child_subject.principal_id
    assert child_mandate.resource_scope == ["api:openai:gpt-4"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
