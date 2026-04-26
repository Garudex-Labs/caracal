"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SoftwareSigner, MerkleRootSignature, and create_merkle_signer factory.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from caracal.merkle.signer import (
    MerkleRootSignature,
    SoftwareSigner,
    create_merkle_signer,
)


def _generate_p256_pem(passphrase: bytes | None = None) -> tuple[str, bytes]:
    """Generate a P-256 private key and write it to a temp file. Returns (path, pem bytes)."""
    key = ec.generate_private_key(ec.SECP256R1())
    enc = serialization.BestAvailableEncryption(passphrase) if passphrase else serialization.NoEncryption()
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=enc,
    )
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pem")
    tmp.write(pem)
    tmp.close()
    return tmp.name, pem


@pytest.mark.unit
class TestMerkleRootSignatureDataclass:
    def test_fields_stored(self):
        root_id = uuid4()
        batch_id = uuid4()
        now = datetime.utcnow()
        sig = MerkleRootSignature(
            root_id=root_id,
            merkle_root=b"\x00" * 32,
            signature=b"\x01" * 64,
            batch_id=batch_id,
            event_count=5,
            first_event_id=1,
            last_event_id=5,
            signed_at=now,
            signing_backend="software",
        )
        assert sig.root_id == root_id
        assert sig.merkle_root == b"\x00" * 32
        assert sig.batch_id == batch_id
        assert sig.event_count == 5
        assert sig.signing_backend == "software"


@pytest.mark.unit
class TestSoftwareSignerInit:
    def test_loads_unencrypted_key(self):
        path, _ = _generate_p256_pem()
        try:
            signer = SoftwareSigner(path)
            assert signer.private_key_path == path
        finally:
            os.unlink(path)

    def test_loads_passphrase_protected_key(self):
        passphrase = b"testpass"
        path, _ = _generate_p256_pem(passphrase=passphrase)
        try:
            with patch.dict(os.environ, {"MERKLE_KEY_PASSPHRASE": "testpass"}):
                signer = SoftwareSigner(path)
                assert signer.private_key_path == path
        finally:
            os.unlink(path)

    def test_missing_key_file_raises(self):
        with pytest.raises(FileNotFoundError):
            SoftwareSigner("/nonexistent/path/to/key.pem")

    def test_invalid_key_data_raises(self):
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pem") as f:
            f.write(b"not a valid pem key")
            path = f.name
        try:
            with pytest.raises(ValueError):
                SoftwareSigner(path)
        finally:
            os.unlink(path)

    def test_non_ecdsa_key_raises(self):
        from cryptography.hazmat.primitives.asymmetric import rsa
        rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = rsa_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pem") as f:
            f.write(pem)
            path = f.name
        try:
            with pytest.raises(ValueError, match="ECDSA"):
                SoftwareSigner(path)
        finally:
            os.unlink(path)

    def test_non_p256_ec_key_raises(self):
        key = ec.generate_private_key(ec.SECP384R1())
        pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pem") as f:
            f.write(pem)
            path = f.name
        try:
            with pytest.raises(ValueError, match="P-256"):
                SoftwareSigner(path)
        finally:
            os.unlink(path)


@pytest.mark.unit
class TestSoftwareSignerSignRoot:
    def setup_method(self):
        self.path, _ = _generate_p256_pem()
        self.signer = SoftwareSigner(self.path)

    def teardown_method(self):
        os.unlink(self.path)

    @pytest.mark.asyncio
    async def test_sign_root_returns_signature_record(self):
        batch = MagicMock()
        batch.batch_id = uuid4()
        batch.event_count = 3
        batch.event_ids = [1, 2, 3]

        result = await self.signer.sign_root(b"\xab" * 32, batch)
        assert isinstance(result, MerkleRootSignature)
        assert result.signing_backend == "software"
        assert result.event_count == 3
        assert result.merkle_root == b"\xab" * 32

    @pytest.mark.asyncio
    async def test_sign_root_invalid_length_raises(self):
        batch = MagicMock()
        with pytest.raises(ValueError, match="32 bytes"):
            await self.signer.sign_root(b"\x00" * 16, batch)

    @pytest.mark.asyncio
    async def test_sign_root_empty_raises(self):
        batch = MagicMock()
        with pytest.raises(ValueError):
            await self.signer.sign_root(b"", batch)

    @pytest.mark.asyncio
    async def test_sign_root_stores_to_db_if_session(self):
        batch = MagicMock()
        batch.batch_id = uuid4()
        batch.event_count = 1
        batch.event_ids = [10]

        mock_session = MagicMock()
        signer = SoftwareSigner(self.path, db_session=mock_session)

        with patch.object(signer, "_store_signature") as mock_store:
            mock_store.return_value = None
            result = await signer.sign_root(b"\xcd" * 32, batch)
            mock_store.assert_called_once()


@pytest.mark.unit
class TestSoftwareSignerVerifySignature:
    def setup_method(self):
        self.path, _ = _generate_p256_pem()
        self.signer = SoftwareSigner(self.path)

    def teardown_method(self):
        os.unlink(self.path)

    @pytest.mark.asyncio
    async def test_verify_valid_signature(self):
        from cryptography.hazmat.primitives.asymmetric import ec as crypto_ec
        from cryptography.hazmat.primitives import hashes

        root = b"\xab" * 32
        sig = self.signer._private_key.sign(root, crypto_ec.ECDSA(hashes.SHA256()))
        assert await self.signer.verify_signature(root, sig) is True

    @pytest.mark.asyncio
    async def test_verify_wrong_signature_returns_false(self):
        root = b"\xab" * 32
        assert await self.signer.verify_signature(root, b"\x00" * 64) is False

    @pytest.mark.asyncio
    async def test_verify_invalid_root_length_returns_false(self):
        assert await self.signer.verify_signature(b"\x00" * 16, b"\x00" * 64) is False

    @pytest.mark.asyncio
    async def test_verify_empty_root_returns_false(self):
        assert await self.signer.verify_signature(b"", b"\x00" * 64) is False

    @pytest.mark.asyncio
    async def test_verify_empty_signature_returns_false(self):
        assert await self.signer.verify_signature(b"\xab" * 32, b"") is False


@pytest.mark.unit
class TestSoftwareSignerGetPublicKeyPem:
    def setup_method(self):
        self.path, _ = _generate_p256_pem()
        self.signer = SoftwareSigner(self.path)

    def teardown_method(self):
        os.unlink(self.path)

    def test_returns_pem_bytes(self):
        pem = self.signer.get_public_key_pem()
        assert isinstance(pem, bytes)
        assert b"PUBLIC KEY" in pem


@pytest.mark.unit
class TestCreateMerkleSigner:
    def test_software_backend_missing_path_raises(self):
        config = MagicMock()
        config.signing_backend = "software"
        config.private_key_path = None
        with pytest.raises(ValueError, match="private_key_path"):
            create_merkle_signer(config)

    def test_invalid_backend_raises(self):
        config = MagicMock()
        config.signing_backend = "hsm"
        with pytest.raises(ValueError, match="hsm"):
            create_merkle_signer(config)

    def test_software_backend_returns_software_signer(self):
        path, _ = _generate_p256_pem()
        try:
            config = MagicMock()
            config.signing_backend = "software"
            config.private_key_path = path
            signer = create_merkle_signer(config)
            assert isinstance(signer, SoftwareSigner)
        finally:
            os.unlink(path)

    def test_default_backend_is_software(self):
        path, _ = _generate_p256_pem()
        try:
            config = MagicMock(spec=[])  # no signing_backend attr
            config.private_key_path = path
            signer = create_merkle_signer(config)
            assert isinstance(signer, SoftwareSigner)
        finally:
            os.unlink(path)
