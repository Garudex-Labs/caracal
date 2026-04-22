"""Helpers for generating asymmetric key material used by vault bootstrap flows."""

from __future__ import annotations

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa


def generate_asymmetric_keypair_pem(algorithm: str) -> tuple[str, str]:
    normalized_algorithm = str(algorithm or "").strip().upper()
    if normalized_algorithm == "ES256":
        private_key = ec.generate_private_key(ec.SECP256R1())
    elif normalized_algorithm == "RS256":
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    else:
        raise ValueError(
            f"Unsupported asymmetric key bootstrap algorithm: {normalized_algorithm!r}."
        )

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return private_pem, public_pem
