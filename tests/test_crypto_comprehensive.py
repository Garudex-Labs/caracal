#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

[One-sentence description of the file's purpose and functionality.]
"""

"""
Comprehensive test suite for crypto operations.
This tests all functions in the caracal.core.crypto module.
"""


import json
import hashlib
from unittest.mock import Mock, patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
import pytest

from caracal.core.crypto import (
    sign_mandate,
    verify_mandate_signature,
    sign_merkle_root,
    verify_merkle_root,
    store_signed_merkle_root
)


def generate_test_keys():
    """Generate test ECDSA P-256 keys for testing."""
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()

    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()

    return private_pem, public_pem


def test_sign_mandate_success():
    """Test successful mandate signing."""
    private_pem, public_pem = generate_test_keys()

    mandate = {
        "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        "valid_from": "2024-01-15T10:00:00Z",
        "valid_until": "2024-01-15T11:00:00Z",
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"]
    }

    signature = sign_mandate(mandate, private_pem)

    # Verify the signature is valid
    assert isinstance(signature, str)
    assert len(signature) > 0
    assert verify_mandate_signature(mandate, signature, public_pem) is True


def test_sign_mandate_invalid_inputs():
    """Test mandate signing with invalid inputs."""
    private_pem, _ = generate_test_keys()

    # Test with non-dict mandate_data
    with pytest.raises(TypeError):
        sign_mandate("not_a_dict", private_pem)

    # Test with empty mandate_data
    with pytest.raises(ValueError):
        sign_mandate({}, private_pem)

    # Test with empty private key
    with pytest.raises(ValueError):
        sign_mandate({"test": "data"}, "")

    # Test with invalid private key
    with pytest.raises(ValueError):
        sign_mandate({"test": "data"}, "invalid_key")


def test_verify_mandate_signature_success():
    """Test successful mandate signature verification."""
    private_pem, public_pem = generate_test_keys()

    mandate = {
        "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        "valid_from": "2024-01-15T10:00:00Z",
        "valid_until": "2024-01-15T11:00:00Z",
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"]
    }

    signature = sign_mandate(mandate, private_pem)
    assert verify_mandate_signature(mandate, signature, public_pem) is True


def test_verify_mandate_signature_invalid_inputs():
    """Test mandate signature verification with invalid inputs."""
    private_pem, public_pem = generate_test_keys()

    mandate = {
        "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        "valid_from": "2024-01-15T10:00:00Z",
        "valid_until": "2024-01-15T11:00:00Z",
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"]
    }

    # Test with invalid signature
    assert verify_mandate_signature(mandate, "invalid_signature", public_pem) is False

    # Test with empty mandate_data
    assert verify_mandate_signature({}, "signature", public_pem) is False

    # Test with empty signature
    assert verify_mandate_signature(mandate, "", public_pem) is False

    # Test with empty public key
    assert verify_mandate_signature(mandate, "signature", "") is False

    # Test with invalid public key
    assert verify_mandate_signature(mandate, "signature", "invalid_key") is False


def test_sign_merkle_root_success():
    """Test successful Merkle root signing."""
    private_pem, public_pem = generate_test_keys()

    # Generate a test Merkle root (32-byte SHA-256 hash)
    test_data = b"test data for merkle root"
    merkle_root = hashlib.sha256(test_data).digest()

    signature = sign_merkle_root(merkle_root, private_pem)

    # Verify the signature is valid
    assert isinstance(signature, str)
    assert len(signature) > 0
    assert verify_merkle_root(merkle_root, signature, public_pem) is True


def test_sign_merkle_root_invalid_inputs():
    """Test Merkle root signing with invalid inputs."""
    private_pem, _ = generate_test_keys()

    # Test with empty merkle_root
    with pytest.raises(ValueError):
        sign_merkle_root(b"", private_pem)

    # Test with wrong length merkle_root (not 32 bytes)
    with pytest.raises(ValueError):
        sign_merkle_root(b"wrong_length", private_pem)

    # Test with empty private key
    with pytest.raises(ValueError):
        sign_merkle_root(b"test_root" * 4, "")

    # Test with invalid private key
    with pytest.raises(ValueError):
        sign_merkle_root(b"test_root" * 4, "invalid_key")


def test_verify_merkle_root_success():
    """Test successful Merkle root signature verification."""
    private_pem, public_pem = generate_test_keys()

    # Generate a test Merkle root (32-byte SHA-256 hash)
    test_data = b"test data for merkle root"
    merkle_root = hashlib.sha256(test_data).digest()

    signature = sign_merkle_root(merkle_root, private_pem)
    assert verify_merkle_root(merkle_root, signature, public_pem) is True


def test_verify_merkle_root_invalid_inputs():
    """Test Merkle root signature verification with invalid inputs."""
    private_pem, public_pem = generate_test_keys()

    # Generate a test Merkle root
    test_data = b"test data for merkle root"
    merkle_root = hashlib.sha256(test_data).digest()

    # Test with invalid signature
    assert verify_merkle_root(merkle_root, "invalid_signature", public_pem) is False

    # Test with empty merkle_root
    assert verify_merkle_root(b"", "signature", public_pem) is False

    # Test with wrong length merkle_root
    assert verify_merkle_root(b"wrong_length", "signature", public_pem) is False

    # Test with empty signature
    assert verify_merkle_root(merkle_root, "", public_pem) is False

    # Test with empty public key
    assert verify_merkle_root(merkle_root, "signature", "") is False

    # Test with invalid public key
    assert verify_merkle_root(merkle_root, "signature", "invalid_key") is False


def test_store_signed_merkle_root_success():
    """Test successful storage of signed Merkle root."""
    private_pem, public_pem = generate_test_keys()

    # Generate a test Merkle root
    test_data = b"test data for merkle root"
    merkle_root = hashlib.sha256(test_data).digest()

    # Sign the Merkle root
    signature = sign_merkle_root(merkle_root, private_pem)

    # Mock database session
    mock_session = Mock()

    # Test successful storage
    result = store_signed_merkle_root(
        mock_session,
        merkle_root,
        signature,
        "test-batch-id",
        100,
        1,
        100
    )

    # Verify that the session was called to add the record
    mock_session.add.assert_called_once()
    mock_session.commit.assert_not_called()  # Not called in the function, but should be called by caller


def test_store_signed_merkle_root_invalid_inputs():
    """Test storage of signed Merkle root with invalid inputs."""
    private_pem, public_pem = generate_test_keys()

    # Generate a test Merkle root
    test_data = b"test data for merkle root"
    merkle_root = hashlib.sha256(test_data).digest()

    # Sign the Merkle root
    signature = sign_merkle_root(merkle_root, private_pem)

    # Mock database session
    mock_session = Mock()

    # Test with invalid merkle_root (empty)
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            b"",
            signature,
            "test-batch-id",
            100,
            1,
            100
        )

    # Test with invalid merkle_root (wrong length)
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            b"wrong_length",
            signature,
            "test-batch-id",
            100,
            1,
            100
        )

    # Test with invalid signature
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            merkle_root,
            "",
            "test-batch-id",
            100,
            1,
            100
        )

    # Test with invalid batch_id
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            merkle_root,
            signature,
            "",
            100,
            1,
            100
        )

    # Test with invalid event_count
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            merkle_root,
            signature,
            "test-batch-id",
            0,
            1,
            100
        )

    # Test with invalid event IDs
    with pytest.raises(ValueError):
        store_signed_merkle_root(
            mock_session,
            merkle_root,
            signature,
            "test-batch-id",
            100,
            100,
            1
        )


if __name__ == "__main__":
    # Run the tests if executed directly
    pytest.main([__file__, "-v"])