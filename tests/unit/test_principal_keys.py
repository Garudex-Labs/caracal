from __future__ import annotations

from uuid import uuid4

import pytest

from caracal.core import principal_keys
from caracal.core.principal_keys import PrincipalKeyStorageError, PrincipalKeyStorageResult


def test_store_principal_private_key_rejects_invalid_backend(monkeypatch):
    monkeypatch.setenv("CARACAL_PRINCIPAL_KEY_BACKEND", "invalid")

    with pytest.raises(PrincipalKeyStorageError):
        principal_keys.store_principal_private_key(uuid4(), "pem")


def test_store_principal_private_key_strict_aws_fails_closed(monkeypatch):
    monkeypatch.setenv("CARACAL_PRINCIPAL_KEY_BACKEND", "aws_kms")
    monkeypatch.setenv("CARACAL_PRINCIPAL_KEY_STRICT_AWS", "true")
    monkeypatch.setattr(principal_keys, "_store_in_aws_kms", lambda **_: None)

    with pytest.raises(PrincipalKeyStorageError):
        principal_keys.store_principal_private_key(uuid4(), "pem")


def test_store_principal_private_key_aws_fallback_when_not_strict(monkeypatch):
    monkeypatch.setenv("CARACAL_PRINCIPAL_KEY_BACKEND", "aws_kms")
    monkeypatch.setenv("CARACAL_PRINCIPAL_KEY_STRICT_AWS", "false")
    monkeypatch.setattr(principal_keys, "_store_in_aws_kms", lambda **_: None)

    expected = PrincipalKeyStorageResult(backend="local", reference="ref", metadata={"key_backend": "local"})
    monkeypatch.setattr(principal_keys, "_store_locally", lambda **_: expected)

    actual = principal_keys.store_principal_private_key(uuid4(), "pem")
    assert actual is expected


def test_resolve_principal_private_key_prefers_legacy_inline_key():
    principal_id = uuid4()
    pem = "-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----"

    resolved = principal_keys.resolve_principal_private_key(
        principal_id=principal_id,
        principal_metadata={
            "private_key_pem": pem,
            "key_backend": "aws_kms",
        },
    )
    assert resolved == pem


def test_resolve_principal_private_key_reads_local_ref(tmp_path):
    principal_id = uuid4()
    key_file = tmp_path / "principal.key"
    key_file.write_text("pem-data", encoding="utf-8")

    resolved = principal_keys.resolve_principal_private_key(
        principal_id=principal_id,
        principal_metadata={
            "key_backend": "local",
            "private_key_ref": str(key_file),
        },
    )
    assert resolved == "pem-data"


def test_resolve_principal_private_key_rejects_unknown_backend():
    with pytest.raises(PrincipalKeyStorageError):
        principal_keys.resolve_principal_private_key(
            principal_id=uuid4(),
            principal_metadata={"key_backend": "unknown"},
        )
