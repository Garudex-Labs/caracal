#!/usr/bin/env python3
"""Simple test for crypto operations."""

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

from caracal.core.crypto import sign_mandate, verify_mandate_signature

# Generate test keys
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

# Test mandate
mandate = {
    "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
    "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
    "subject_id": "770e8400-e29b-41d4-a716-446655440000",
    "valid_from": "2024-01-15T10:00:00Z",
    "valid_until": "2024-01-15T11:00:00Z",
    "resource_scope": ["api:openai:gpt-4"],
    "action_scope": ["api_call"]
}

# Sign and verify
signature = sign_mandate(mandate, private_pem)
print(f"Signature: {signature[:32]}...")

is_valid = verify_mandate_signature(mandate, signature, public_pem)
print(f"Verification: {is_valid}")

assert is_valid, "Verification failed"
print("SUCCESS!")
