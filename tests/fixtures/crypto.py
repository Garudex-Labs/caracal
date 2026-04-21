"""Cryptographic test fixtures."""
import pytest
from typing import Any


@pytest.fixture
def crypto_fixtures(db_session):
    """Provide principals with real cryptographic keys for testing."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
    from caracal.db.models import Principal
    from uuid import uuid4
    
    # Generate issuer keypair
    issuer_private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    issuer_private_pem = issuer_private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    
    issuer_public_pem = issuer_private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    
    # Generate subject keypair
    subject_private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    subject_private_pem = subject_private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    
    subject_public_pem = subject_private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    
    # Create issuer principal
    issuer = Principal(
        principal_id=uuid4(),
        principal_kind="human",
        name="test-issuer",
        owner="security-test",
        private_key_pem=issuer_private_pem,
        public_key_pem=issuer_public_pem,
    )
    
    # Create subject principal
    subject = Principal(
        principal_id=uuid4(),
        principal_kind="worker",
        name="test-subject",
        owner="security-test",
        private_key_pem=subject_private_pem,
        public_key_pem=subject_public_pem,
    )
    
    db_session.add(issuer)
    db_session.add(subject)
    db_session.flush()
    
    return {
        "issuer": issuer,
        "subject": subject,
        "issuer_private_key": issuer_private_pem,
        "issuer_public_key": issuer_public_pem,
        "subject_private_key": subject_private_pem,
        "subject_public_key": subject_public_pem,
    }
