"""
Security tests for cryptographic operations.

Tests key strength requirements, signature validation, and encryption strength
to ensure cryptographic operations meet security standards.
"""

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

from caracal.core.crypto import (
    verify_mandate_signature,
    verify_merkle_root,
)
from tests.helpers.crypto_signing import sign_mandate_for_test, sign_merkle_root_for_test


@pytest.mark.security
class TestCryptographicSecurity:
    """Security tests for cryptographic operations."""
    
    def test_key_strength_p256_required(self):
        """Test that only P-256 (SECP256R1) keys are accepted."""
        # Generate a P-256 key (should work)
        private_key_p256 = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem_p256 = private_key_p256.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # P-256 key should work
        signature = sign_mandate_for_test(mandate_data, private_key_pem_p256)
        assert signature is not None
        assert len(signature) > 0
    
    def test_weak_key_rejected(self):
        """Test that non-P-256 keys are rejected."""
        # Generate a P-384 key (stronger but not P-256)
        private_key_p384 = ec.generate_private_key(ec.SECP384R1(), default_backend())
        private_key_pem_p384 = private_key_p384.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # Non-P-256 key should be rejected
        with pytest.raises(ValueError, match="not P-256 curve"):
            sign_mandate_for_test(mandate_data, private_key_pem_p384)
    
    def test_signature_tampering_detected(self):
        """Test that tampered signatures are detected."""
        # Generate key pair
        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        public_key_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # Sign mandate
        signature = sign_mandate_for_test(mandate_data, private_key_pem)
        
        # Valid signature should verify
        assert verify_mandate_signature(mandate_data, signature, public_key_pem) is True
        
        # Tamper with signature (flip a bit)
        tampered_signature = signature[:-2] + ("00" if signature[-2:] != "00" else "ff")
        
        # Tampered signature should fail verification
        assert verify_mandate_signature(mandate_data, tampered_signature, public_key_pem) is False
    
    def test_data_tampering_detected(self):
        """Test that tampered mandate data is detected."""
        # Generate key pair
        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        public_key_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # Sign mandate
        signature = sign_mandate_for_test(mandate_data, private_key_pem)
        
        # Valid data should verify
        assert verify_mandate_signature(mandate_data, signature, public_key_pem) is True
        
        # Tamper with mandate data
        tampered_data = mandate_data.copy()
        tampered_data["resource_scope"] = ["admin:*"]
        
        # Tampered data should fail verification
        assert verify_mandate_signature(tampered_data, signature, public_key_pem) is False
    
    def test_wrong_public_key_rejected(self):
        """Test that signatures cannot be verified with wrong public key."""
        # Generate two key pairs
        private_key1 = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem1 = private_key1.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        private_key2 = ec.generate_private_key(ec.SECP256R1(), default_backend())
        public_key_pem2 = private_key2.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # Sign with key1
        signature = sign_mandate_for_test(mandate_data, private_key_pem1)
        
        # Verify with key2 (wrong key) should fail
        assert verify_mandate_signature(mandate_data, signature, public_key_pem2) is False
    
    def test_merkle_root_signature_security(self):
        """Test Merkle root signature security."""
        # Generate key pair
        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        public_key_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()
        
        # Create a 32-byte Merkle root
        merkle_root = b"a" * 32
        
        # Sign Merkle root
        signature = sign_merkle_root_for_test(merkle_root, private_key_pem)
        
        # Valid signature should verify
        assert verify_merkle_root(merkle_root, signature, public_key_pem) is True
        
        # Tampered root should fail
        tampered_root = b"b" * 32
        assert verify_merkle_root(tampered_root, signature, public_key_pem) is False
    
    def test_empty_data_rejected(self):
        """Test that empty mandate data is rejected."""
        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        
        # Empty mandate data should be rejected
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_mandate_for_test({}, private_key_pem)
    
    def test_invalid_key_format_rejected(self):
        """Test that invalid key formats are rejected."""
        mandate_data = {
            "mandate_id": "test-123",
            "issuer_id": "issuer-456",
            "subject_id": "subject-789",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-02T00:00:00Z",
            "resource_scope": ["test:*"],
            "action_scope": ["read"],
            "delegation_type": "directed",
            "intent_hash": None
        }
        
        # Invalid key format should be rejected
        with pytest.raises(ValueError, match="Invalid private key"):
            sign_mandate_for_test(mandate_data, "not-a-valid-key")
