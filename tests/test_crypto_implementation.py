#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""

"""
Quick test script to verify cryptographic operations implementation.
"""

import sys
from pathlib import Path

# Add caracal to path
sys.path.insert(0, str(Path(__file__).parent))

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

from caracal.core.crypto import (
    sign_mandate,
    verify_mandate_signature,
    sign_merkle_root,
    verify_merkle_root
)
from caracal.merkle.tree import MerkleTreeBuilder


def generate_test_keys():
    """Generate a test ECDSA P-256 key pair."""
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


def test_mandate_signing():
    """Test mandate signing and verification."""
    print("Testing mandate signing and verification...")
    
    # Generate test keys
    private_pem, public_pem = generate_test_keys()
    
    # Create test mandate
    mandate = {
        "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        "valid_from": "2024-01-15T10:00:00Z",
        "valid_until": "2024-01-15T11:00:00Z",
        "resource_scope": ["api:openai:gpt-4"],
        "action_scope": ["api_call"]
    }
    
    # Sign mandate
    signature = sign_mandate(mandate, private_pem)
    print(f"✓ Signed mandate: {signature[:32]}...")
    
    # Verify signature
    is_valid = verify_mandate_signature(mandate, signature, public_pem)
    assert is_valid, "Signature verification failed"
    print("✓ Signature verified successfully")
    
    # Test with modified mandate (should fail)
    modified_mandate = mandate.copy()
    modified_mandate["subject_id"] = "999e8400-e29b-41d4-a716-446655440000"
    is_valid = verify_mandate_signature(modified_mandate, signature, public_pem)
    assert not is_valid, "Modified mandate should fail verification"
    print("✓ Modified mandate correctly rejected")
    
    print("✓ Mandate signing tests passed!\n")


def test_merkle_operations():
    """Test Merkle tree operations."""
    print("Testing Merkle tree operations...")
    
    # Generate test keys
    private_pem, public_pem = generate_test_keys()
    
    # Create test events
    events = [
        b"event_1_data",
        b"event_2_data",
        b"event_3_data",
        b"event_4_data",
        b"event_5_data"
    ]
    
    # Build Merkle tree
    builder = MerkleTreeBuilder()
    builder.build_tree(events)
    print(f"✓ Built Merkle tree with {len(events)} events")
    
    # Get root
    root = builder.get_root()
    print(f"✓ Merkle root: {root.hex()[:32]}...")
    
    # Get proof for first event
    proof = builder.get_proof(0)
    print(f"✓ Generated proof for event 0 with {len(proof.proof_hashes)} hashes")
    
    # Sign Merkle root
    signature = sign_merkle_root(root, private_pem)
    print(f"✓ Signed Merkle root: {signature[:32]}...")
    
    # Verify signature
    is_valid = verify_merkle_root(root, signature, public_pem)
    assert is_valid, "Merkle root signature verification failed"
    print("✓ Merkle root signature verified successfully")
    
    # Test with modified root (should fail)
    modified_root = b"0" * 32
    is_valid = verify_merkle_root(modified_root, signature, public_pem)
    assert not is_valid, "Modified root should fail verification"
    print("✓ Modified root correctly rejected")
    
    print("✓ Merkle tree tests passed!\n")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Testing Core Cryptographic Operations")
    print("=" * 60 + "\n")
    
    try:
        test_mandate_signing()
        test_merkle_operations()
        
        print("=" * 60)
        print("✓ All tests passed!")
        print("=" * 60)
        return 0
        
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
