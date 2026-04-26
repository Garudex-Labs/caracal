"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Test-only signing helpers that operate directly on raw private key bytes.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec


def sign_mandate_for_test(
    mandate_data: dict[str, Any],
    private_key_pem: str,
    passphrase: str | None = None,
) -> str:
    """Sign canonical mandate payload for tests using ECDSA P-256."""
    if not isinstance(mandate_data, dict):
        raise TypeError(f"mandate_data must be a dictionary, got {type(mandate_data)}")
    if not mandate_data:
        raise ValueError("mandate_data cannot be empty")
    if not private_key_pem:
        raise ValueError("private_key_pem cannot be empty")

    try:
        passphrase_bytes = passphrase.encode() if passphrase else None
        private_key = serialization.load_pem_private_key(
            private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
            password=passphrase_bytes,
            backend=default_backend(),
        )
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"Key is not an ECDSA key, got {type(private_key)}")
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(f"Key is not P-256 curve, got {type(private_key.curve)}")
    except Exception as exc:
        raise ValueError(f"Invalid private key: {exc}") from exc

    canonical_json = json.dumps(mandate_data, sort_keys=True, separators=(",", ":"))
    message_hash = hashlib.sha256(canonical_json.encode()).digest()
    signature = private_key.sign(message_hash, ec.ECDSA(hashes.SHA256()))
    return signature.hex()


def sign_merkle_root_for_test(
    merkle_root: bytes,
    private_key_pem: str,
    passphrase: str | None = None,
) -> str:
    """Sign 32-byte Merkle roots for tests using ECDSA P-256."""
    if not merkle_root:
        raise ValueError("merkle_root cannot be empty")
    if len(merkle_root) != 32:
        raise ValueError(f"merkle_root must be 32 bytes (SHA-256), got {len(merkle_root)} bytes")
    if not private_key_pem:
        raise ValueError("private_key_pem cannot be empty")

    try:
        passphrase_bytes = passphrase.encode() if passphrase else None
        private_key = serialization.load_pem_private_key(
            private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
            password=passphrase_bytes,
            backend=default_backend(),
        )
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"Key is not an ECDSA key, got {type(private_key)}")
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(f"Key is not P-256 curve, got {type(private_key.curve)}")
    except Exception as exc:
        raise ValueError(f"Invalid private key: {exc}") from exc

    signature = private_key.sign(merkle_root, ec.ECDSA(hashes.SHA256()))
    return signature.hex()
