"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for AuthorityEvaluator.

Tests the authority evaluation logic including mandate validation,
delegation chain checking, and fail-closed semantics.
"""

import pytest
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.db.models import ExecutionMandate, Principal, AuthorityPolicy
from caracal.core.crypto import sign_mandate


@pytest.fixture
def db_session(tmp_path):
    """Create a test database session."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from caracal.db.models import Base
    
    # Use in-memory SQLite for testing
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    
    yield session
    
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
        name="test_principal",
        principal_type="agent",
        owner="test_owner",
        public_key_pem=public_pem,
        private_key_pem=private_pem
    )
    
    db_session.add(principal)
    db_session.commit()
    
    return principal


@pytest.fixture
def test_subject(db_session):
    """Create a test subject principal."""
    subject = Principal(
        principal_id=uuid4(),
        name="test_subject",
        principal_type="agent",
        owner="test_owner"
    )
    
    db_session.add(subject)
    db_session.commit()
    
    return subject


@pytest.fixture
def valid_mandate(db_session, test_principal, test_subject):
    """Create a valid test mandate."""
    valid_from = datetime.utcnow()
    valid_until = valid_from + timedelta(hours=1)
    
    mandate_data = {
        "mandate_id": str(uuid4()),
        "issuer_id": str(test_principal.principal_id),
        "subject_id": str(test_subject.principal_id),
        "valid_from": valid_from.isoformat(),
        "valid_until": valid_until.isoformat(),
        "resource_scope": ["api:openai:*", "database:users:read"],
        "action_scope": ["api_call", "database_query"],
        "delegation_depth": 0,
        "parent_mandate_id": None,
        "intent_hash": None
    }
    
    signature = sign_mandate(mandate_data, test_principal.private_key_pem)
    
    mandate = ExecutionMandate(
        mandate_id=mandate_data["mandate_id"],
        issuer_id=test_principal.principal_id,
        subject_id=test_subject.principal_id,
        valid_from=valid_from,
        valid_until=valid_until,
        resource_scope=["api:openai:*", "database:users:read"],
        action_scope=["api_call", "database_query"],
        signature=signature,
        revoked=False,
        delegation_depth=0
    )
    
    db_session.add(mandate)
    db_session.commit()
    
    return mandate


def test_validate_mandate_success(db_session, valid_mandate):
    """Test successful mandate validation."""
    evaluator = AuthorityEvaluator(db_session)
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    assert decision.allowed is True
    assert decision.mandate_id == valid_mandate.mandate_id
    assert decision.principal_id == valid_mandate.subject_id
    assert "valid" in decision.reason.lower()


def test_validate_mandate_revoked(db_session, valid_mandate):
    """Test validation fails for revoked mandate."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Revoke the mandate
    valid_mandate.revoked = True
    valid_mandate.revocation_reason = "Test revocation"
    db_session.commit()
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    assert decision.allowed is False
    assert "revoked" in decision.reason.lower()


def test_validate_mandate_expired(db_session, valid_mandate):
    """Test validation fails for expired mandate."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Use a time after expiration
    future_time = valid_mandate.valid_until + timedelta(hours=1)
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4",
        current_time=future_time
    )
    
    assert decision.allowed is False
    assert "expired" in decision.reason.lower()


def test_validate_mandate_not_yet_valid(db_session, valid_mandate):
    """Test validation fails for mandate not yet valid."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Use a time before valid_from
    past_time = valid_mandate.valid_from - timedelta(hours=1)
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4",
        current_time=past_time
    )
    
    assert decision.allowed is False
    assert "not yet valid" in decision.reason.lower()


def test_validate_mandate_action_not_in_scope(db_session, valid_mandate):
    """Test validation fails when action is not in scope."""
    evaluator = AuthorityEvaluator(db_session)
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="file_write",  # Not in action_scope
        requested_resource="api:openai:gpt-4"
    )
    
    assert decision.allowed is False
    assert "action" in decision.reason.lower()
    assert "not in mandate scope" in decision.reason.lower()


def test_validate_mandate_resource_not_in_scope(db_session, valid_mandate):
    """Test validation fails when resource is not in scope."""
    evaluator = AuthorityEvaluator(db_session)
    
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:anthropic:claude"  # Not in resource_scope
    )
    
    assert decision.allowed is False
    assert "resource" in decision.reason.lower()
    assert "not in mandate scope" in decision.reason.lower()


def test_validate_mandate_wildcard_matching(db_session, valid_mandate):
    """Test wildcard pattern matching in scope validation."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Should match "api:openai:*" pattern
    decision = evaluator.validate_mandate(
        mandate=valid_mandate,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4-turbo"
    )
    
    assert decision.allowed is True


def test_validate_mandate_none(db_session):
    """Test validation fails when mandate is None (fail-closed)."""
    evaluator = AuthorityEvaluator(db_session)
    
    decision = evaluator.validate_mandate(
        mandate=None,
        requested_action="api_call",
        requested_resource="api:openai:gpt-4"
    )
    
    assert decision.allowed is False
    assert "no mandate provided" in decision.reason.lower()


def test_check_delegation_chain_root_mandate(db_session, valid_mandate):
    """Test delegation chain check for root mandate (no parent)."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Root mandate should have valid chain
    chain_valid = evaluator.check_delegation_chain(valid_mandate)
    
    assert chain_valid is True


def test_check_delegation_chain_with_valid_parent(db_session, test_principal, test_subject):
    """Test delegation chain check with valid parent mandate."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Create parent mandate
    parent_valid_from = datetime.utcnow()
    parent_valid_until = parent_valid_from + timedelta(hours=2)
    
    parent_mandate_data = {
        "mandate_id": str(uuid4()),
        "issuer_id": str(test_principal.principal_id),
        "subject_id": str(test_subject.principal_id),
        "valid_from": parent_valid_from.isoformat(),
        "valid_until": parent_valid_until.isoformat(),
        "resource_scope": ["api:openai:*"],
        "action_scope": ["api_call"],
        "delegation_depth": 0,
        "parent_mandate_id": None,
        "intent_hash": None
    }
    
    parent_signature = sign_mandate(parent_mandate_data, test_principal.private_key_pem)
    
    parent_mandate = ExecutionMandate(
        mandate_id=parent_mandate_data["mandate_id"],
        issuer_id=test_principal.principal_id,
        subject_id=test_subject.principal_id,
        valid_from=parent_valid_from,
        valid_until=parent_valid_until,
        resource_scope=["api:openai:*"],
        action_scope=["api_call"],
        signature=parent_signature,
        revoked=False,
        delegation_depth=0
    )
    
    db_session.add(parent_mandate)
    db_session.commit()
    
    # Create child mandate with narrower scope
    child_valid_from = datetime.utcnow()
    child_valid_until = child_valid_from + timedelta(hours=1)
    
    child_mandate_data = {
        "mandate_id": str(uuid4()),
        "issuer_id": str(test_subject.principal_id),
        "subject_id": str(uuid4()),
        "valid_from": child_valid_from.isoformat(),
        "valid_until": child_valid_until.isoformat(),
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"],
        "delegation_depth": 1,
        "parent_mandate_id": str(parent_mandate.mandate_id),
        "intent_hash": None
    }
    
    child_signature = sign_mandate(child_mandate_data, test_principal.private_key_pem)
    
    child_mandate = ExecutionMandate(
        mandate_id=child_mandate_data["mandate_id"],
        issuer_id=test_subject.principal_id,
        subject_id=uuid4(),
        valid_from=child_valid_from,
        valid_until=child_valid_until,
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        signature=child_signature,
        revoked=False,
        delegation_depth=1,
        parent_mandate_id=parent_mandate.mandate_id
    )
    
    db_session.add(child_mandate)
    db_session.commit()
    
    # Check delegation chain
    chain_valid = evaluator.check_delegation_chain(child_mandate)
    
    assert chain_valid is True


def test_check_delegation_chain_revoked_parent(db_session, test_principal, test_subject):
    """Test delegation chain check fails when parent is revoked."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Create parent mandate
    parent_valid_from = datetime.utcnow()
    parent_valid_until = parent_valid_from + timedelta(hours=2)
    
    parent_mandate_data = {
        "mandate_id": str(uuid4()),
        "issuer_id": str(test_principal.principal_id),
        "subject_id": str(test_subject.principal_id),
        "valid_from": parent_valid_from.isoformat(),
        "valid_until": parent_valid_until.isoformat(),
        "resource_scope": ["api:openai:*"],
        "action_scope": ["api_call"],
        "delegation_depth": 0,
        "parent_mandate_id": None,
        "intent_hash": None
    }
    
    parent_signature = sign_mandate(parent_mandate_data, test_principal.private_key_pem)
    
    parent_mandate = ExecutionMandate(
        mandate_id=parent_mandate_data["mandate_id"],
        issuer_id=test_principal.principal_id,
        subject_id=test_subject.principal_id,
        valid_from=parent_valid_from,
        valid_until=parent_valid_until,
        resource_scope=["api:openai:*"],
        action_scope=["api_call"],
        signature=parent_signature,
        revoked=True,  # Parent is revoked
        delegation_depth=0
    )
    
    db_session.add(parent_mandate)
    db_session.commit()
    
    # Create child mandate
    child_mandate = ExecutionMandate(
        mandate_id=uuid4(),
        issuer_id=test_subject.principal_id,
        subject_id=uuid4(),
        valid_from=datetime.utcnow(),
        valid_until=datetime.utcnow() + timedelta(hours=1),
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        signature="dummy_signature",
        revoked=False,
        delegation_depth=1,
        parent_mandate_id=parent_mandate.mandate_id
    )
    
    db_session.add(child_mandate)
    db_session.commit()
    
    # Check delegation chain - should fail because parent is revoked
    chain_valid = evaluator.check_delegation_chain(child_mandate)
    
    assert chain_valid is False


def test_check_delegation_chain_expired_parent(db_session, test_principal, test_subject):
    """Test delegation chain check fails when parent is expired."""
    evaluator = AuthorityEvaluator(db_session)
    
    # Create parent mandate that's already expired
    parent_valid_from = datetime.utcnow() - timedelta(hours=2)
    parent_valid_until = datetime.utcnow() - timedelta(hours=1)
    
    parent_mandate_data = {
        "mandate_id": str(uuid4()),
        "issuer_id": str(test_principal.principal_id),
        "subject_id": str(test_subject.principal_id),
        "valid_from": parent_valid_from.isoformat(),
        "valid_until": parent_valid_until.isoformat(),
        "resource_scope": ["api:openai:*"],
        "action_scope": ["api_call"],
        "delegation_depth": 0,
        "parent_mandate_id": None,
        "intent_hash": None
    }
    
    parent_signature = sign_mandate(parent_mandate_data, test_principal.private_key_pem)
    
    parent_mandate = ExecutionMandate(
        mandate_id=parent_mandate_data["mandate_id"],
        issuer_id=test_principal.principal_id,
        subject_id=test_subject.principal_id,
        valid_from=parent_valid_from,
        valid_until=parent_valid_until,
        resource_scope=["api:openai:*"],
        action_scope=["api_call"],
        signature=parent_signature,
        revoked=False,
        delegation_depth=0
    )
    
    db_session.add(parent_mandate)
    db_session.commit()
    
    # Create child mandate
    child_mandate = ExecutionMandate(
        mandate_id=uuid4(),
        issuer_id=test_subject.principal_id,
        subject_id=uuid4(),
        valid_from=datetime.utcnow(),
        valid_until=datetime.utcnow() + timedelta(hours=1),
        resource_scope=["api:openai:gpt-4"],
        action_scope=["api_call"],
        signature="dummy_signature",
        revoked=False,
        delegation_depth=1,
        parent_mandate_id=parent_mandate.mandate_id
    )
    
    db_session.add(child_mandate)
    db_session.commit()
    
    # Check delegation chain - should fail because parent is expired
    chain_valid = evaluator.check_delegation_chain(child_mandate)
    
    assert chain_valid is False
