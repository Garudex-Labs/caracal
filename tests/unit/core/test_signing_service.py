"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SigningService and VaultReferenceJwtSigner in core/signing_service.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from caracal.core.signing_service import (
    SigningService,
    SigningServiceError,
    SigningServiceExpiredToken,
    SigningServiceInvalidToken,
    SigningServiceKeyError,
    VaultReferenceJwtSigner,
)


@pytest.mark.unit
class TestSigningServiceErrors:
    def test_key_error_is_signing_error(self):
        err = SigningServiceKeyError("bad key")
        assert isinstance(err, SigningServiceError)

    def test_expired_token_is_signing_error(self):
        err = SigningServiceExpiredToken("expired")
        assert isinstance(err, SigningServiceError)

    def test_invalid_token_is_signing_error(self):
        err = SigningServiceInvalidToken("invalid")
        assert isinstance(err, SigningServiceError)


@pytest.mark.unit
class TestSigningServiceResolveSigningKeyReference:
    def _registry(self, ref=None, raises=False):
        reg = MagicMock()
        if raises:
            reg.get_signing_key_reference.side_effect = RuntimeError("db down")
        else:
            reg.get_signing_key_reference.return_value = ref
        return reg

    def test_no_method_raises_key_error(self):
        reg = MagicMock(spec=[])
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="get_signing_key_reference"):
            svc._resolve_signing_key_reference("pid")

    def test_method_raises_wraps_as_key_error(self):
        reg = self._registry(raises=True)
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="db down"):
            svc._resolve_signing_key_reference("pid")

    def test_empty_reference_raises_key_error(self):
        reg = self._registry(ref=None)
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="resolvable"):
            svc._resolve_signing_key_reference("pid")

    def test_invalid_reference_format_raises_key_error(self):
        reg = self._registry(ref="bad-format-no-colons")
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="parse"):
            svc._resolve_signing_key_reference("pid")

    def test_valid_reference_returns_tuple(self):
        valid_ref = "vault://ws1/env1/key1"
        reg = self._registry(ref=valid_ref)
        svc = SigningService(reg)
        workspace_id, env_id, secret_name = svc._resolve_signing_key_reference("pid")
        assert workspace_id == "ws1"
        assert env_id == "env1"
        assert secret_name == "key1"


@pytest.mark.unit
class TestSigningServiceResolvePublicKey:
    def test_unknown_principal_raises(self):
        reg = MagicMock()
        reg.get_principal.return_value = None
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="not found"):
            svc._resolve_public_key("pid")

    def test_principal_no_public_key_raises(self):
        reg = MagicMock()
        principal = MagicMock()
        principal.public_key = None
        principal.metadata = {}
        reg.get_principal.return_value = principal
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="no public key"):
            svc._resolve_public_key("pid")

    def test_invalid_pem_raises(self):
        reg = MagicMock()
        principal = MagicMock()
        principal.public_key = "not-valid-pem"
        principal.metadata = {}
        reg.get_principal.return_value = principal
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError, match="load public key"):
            svc._resolve_public_key("pid")

    def test_public_key_from_metadata(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()

        reg = MagicMock()
        principal = MagicMock()
        principal.public_key = None
        principal.metadata = {"public_key_pem": pem}
        reg.get_principal.return_value = principal
        svc = SigningService(reg)
        pub = svc._resolve_public_key("pid")
        assert pub is not None


@pytest.mark.unit
class TestSigningServiceSignCanonicalPayload:
    def test_non_dict_payload_raises(self):
        svc = SigningService(MagicMock())
        with pytest.raises(SigningServiceError, match="dict"):
            svc.sign_canonical_payload_for_principal(principal_id="pid", payload=["not", "a", "dict"])

    def test_empty_payload_raises(self):
        svc = SigningService(MagicMock())
        with pytest.raises(SigningServiceError, match="empty"):
            svc.sign_canonical_payload_for_principal(principal_id="pid", payload={})

    def test_key_resolution_failure_raises_signing_error(self):
        reg = MagicMock(spec=[])
        svc = SigningService(reg)
        with pytest.raises(SigningServiceKeyError):
            svc.sign_canonical_payload_for_principal(principal_id="pid", payload={"k": "v"})


@pytest.mark.unit
class TestVaultReferenceJwtSigner:
    def test_valid_init_stores_attrs(self):
        signer = VaultReferenceJwtSigner(
            workspace_id="ws1",
            env_id="env1",
            key_name="mykey",
            actor="test-actor",
        )
        assert signer._workspace_id == "ws1"
        assert signer._env_id == "env1"
        assert signer._key_name == "mykey"
        assert signer._actor == "test-actor"

    def test_missing_workspace_id_raises(self):
        with pytest.raises(SigningServiceKeyError, match="workspace_id"):
            VaultReferenceJwtSigner(workspace_id="", env_id="env1", key_name="k", actor="a")

    def test_missing_env_id_raises(self):
        with pytest.raises(SigningServiceKeyError):
            VaultReferenceJwtSigner(workspace_id="ws1", env_id="", key_name="k", actor="a")

    def test_missing_key_name_raises(self):
        with pytest.raises(SigningServiceKeyError):
            VaultReferenceJwtSigner(workspace_id="ws1", env_id="env1", key_name="", actor="a")

    def test_default_actor_fallback(self):
        signer = VaultReferenceJwtSigner(workspace_id="ws1", env_id="env1", key_name="k", actor="")
        assert signer._actor == "signing-service"

    def test_whitespace_actor_uses_default(self):
        signer = VaultReferenceJwtSigner(workspace_id="ws1", env_id="env1", key_name="k", actor="   ")
        assert signer._actor == "signing-service"

    def test_sign_token_vault_error_raises(self):
        signer = VaultReferenceJwtSigner(workspace_id="ws1", env_id="env1", key_name="k", actor="a")
        with patch("caracal.core.signing_service.get_vault") as mock_vault:
            mock_vault.return_value.sign_jwt.side_effect = RuntimeError("vault down")
            with patch("caracal.core.signing_service.vault_access_context"):
                with pytest.raises(SigningServiceError, match="vault down"):
                    signer.sign_token(claims={"sub": "test"}, algorithm="ES256")
