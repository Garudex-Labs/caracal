"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Edge case tests for ECDSA signing and signature verification.
"""
from __future__ import annotations

import hashlib

import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from caracal.core.crypto import verify_mandate_signature
from tests.mock.builders import mandate_data
from tests.mock.signing import sign_mandate_for_test


@pytest.fixture(scope="module")
def key_pair():
    priv = ec.generate_private_key(ec.SECP256R1(), default_backend())
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pub_pem = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv_pem, pub_pem


@pytest.mark.edge
class TestSigningEdge:
    """Edge cases for mandate signing input validation."""

    def test_empty_mandate_raises(self, key_pair) -> None:
        priv, _ = key_pair
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_mandate_for_test({}, priv)

    def test_non_dict_raises(self, key_pair) -> None:
        priv, _ = key_pair
        with pytest.raises(TypeError, match="must be a dictionary"):
            sign_mandate_for_test("string-data", priv)  # type: ignore[arg-type]

    def test_empty_key_raises(self) -> None:
        with pytest.raises(ValueError, match="cannot be empty"):
            sign_mandate_for_test(mandate_data(), "")

    def test_invalid_key_pem_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid private key"):
            sign_mandate_for_test(mandate_data(), "not-a-pem-key")

    def test_non_p256_key_raises(self) -> None:
        priv_p384 = ec.generate_private_key(ec.SECP384R1(), default_backend())
        pem = priv_p384.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()
        with pytest.raises(ValueError, match="not P-256"):
            sign_mandate_for_test(mandate_data(), pem)


@pytest.mark.edge
class TestVerificationEdge:
    """Edge cases for signature verification."""

    def test_empty_mandate_data_rejected(self, key_pair) -> None:
        _, pub = key_pair
        assert verify_mandate_signature({}, "aabbcc", pub) is False

    def test_empty_signature_rejected(self, key_pair) -> None:
        _, pub = key_pair
        assert verify_mandate_signature(mandate_data(), "", pub) is False

    def test_empty_public_key_rejected(self, key_pair) -> None:
        priv, _ = key_pair
        sig = sign_mandate_for_test(mandate_data(), priv)
        assert verify_mandate_signature(mandate_data(), sig, "") is False

    def test_tampered_data_rejected(self, key_pair) -> None:
        priv, pub = key_pair
        data = mandate_data()
        sig = sign_mandate_for_test(data, priv)
        data["action_scope"] = ["admin:delete"]
        assert verify_mandate_signature(data, sig, pub) is False

    def test_valid_signature_accepted(self, key_pair) -> None:
        priv, pub = key_pair
        data = mandate_data()
        sig = sign_mandate_for_test(data, priv)
        assert verify_mandate_signature(data, sig, pub) is True

    def test_cross_key_signature_rejected(self) -> None:
        priv_a = ec.generate_private_key(ec.SECP256R1(), default_backend())
        priv_b = ec.generate_private_key(ec.SECP256R1(), default_backend())
        pem_a = priv_a.private_bytes(
            ec.SECP256R1(),
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ) if False else priv_a.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        pub_b = priv_b.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        data = mandate_data()
        sig = sign_mandate_for_test(data, pem_a)
        assert verify_mandate_signature(data, sig, pub_b) is False
