"""Cryptographic test fixtures."""
import pytest
from typing import Tuple, Dict, Any
import secrets


@pytest.fixture
def test_keypair() -> Tuple[bytes, bytes]:
    """Provide a test keypair (private_key, public_key)."""
    # Generate mock keys for testing (not real crypto keys)
    private_key = secrets.token_bytes(32)
    public_key = secrets.token_bytes(32)
    return private_key, public_key


@pytest.fixture
def multiple_keypairs() -> list[Tuple[bytes, bytes]]:
    """Provide multiple test keypairs."""
    return [
        (secrets.token_bytes(32), secrets.token_bytes(32))
        for _ in range(5)
    ]


@pytest.fixture
def test_signature() -> bytes:
    """Provide a test signature."""
    return secrets.token_bytes(64)


@pytest.fixture
def test_data_to_sign() -> bytes:
    """Provide test data for signing."""
    return b"test data for cryptographic signing"


@pytest.fixture
def encryption_key() -> bytes:
    """Provide a test encryption key."""
    return secrets.token_bytes(32)


@pytest.fixture
def encrypted_data() -> Dict[str, Any]:
    """Provide encrypted data structure for testing."""
    return {
        "ciphertext": secrets.token_bytes(128),
        "nonce": secrets.token_bytes(12),
        "tag": secrets.token_bytes(16),
        "algorithm": "AES-256-GCM",
    }


@pytest.fixture
def certificate_data() -> Dict[str, Any]:
    """Provide certificate data for testing."""
    return {
        "subject": "CN=test.caracal.local",
        "issuer": "CN=Caracal Test CA",
        "serial_number": "123456789",
        "not_before": "2024-01-01T00:00:00Z",
        "not_after": "2025-01-01T00:00:00Z",
        "public_key": secrets.token_bytes(32),
    }


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
