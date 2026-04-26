"""Focused unit tests for unified PrincipalRegistry registration behavior."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.identity import PrincipalRegistry


@pytest.mark.unit
def test_register_principal_accepts_explicit_principal_id() -> None:
    session = Mock()

    lookup = Mock()
    lookup.filter_by.return_value.first.return_value = None
    session.query.return_value = lookup

    explicit_id = uuid4()

    added_rows = []

    def _capture_add(obj):
        added_rows.append(obj)

    session.add.side_effect = _capture_add
    session.flush.side_effect = lambda: None
    session.commit.side_effect = lambda: None

    from caracal.core import identity as identity_module

    original_generate = identity_module.generate_and_store_principal_keypair
    identity_module.generate_and_store_principal_keypair = Mock(
        return_value=SimpleNamespace(
            public_key_pem="pub-key",
            storage=SimpleNamespace(metadata={"vault_key_ref": "vault://caracal/runtime/principal-keys/test"}),
        )
    )
    try:
        registry = PrincipalRegistry(session)
        identity = registry.register_principal(
            name="sync-principal",
            owner="tenant-x",
            principal_kind="worker",
            metadata={"source": "sync"},
            principal_id=str(explicit_id),
            generate_keys=True,
        )
    finally:
        identity_module.generate_and_store_principal_keypair = original_generate

    assert added_rows, "Expected principal row to be added"
    assert str(added_rows[0].principal_id) == str(explicit_id)
    assert identity.principal_id == str(explicit_id)
    assert identity.public_key == "pub-key"
    assert identity.metadata.get("vault_key_ref") == "vault://caracal/runtime/principal-keys/test"


@pytest.mark.unit
def test_register_principal_rejects_unknown_kind() -> None:
    session = Mock()
    registry = PrincipalRegistry(session)

    with pytest.raises(ValueError, match="Unknown principal_kind"):
        registry.register_principal(
            name="bad-kind-principal",
            owner="tenant-x",
            principal_kind="superagent",
        )

    session.query.assert_not_called()
    session.add.assert_not_called()


@pytest.mark.unit
def test_ensure_signing_keys_generates_when_missing() -> None:
    session = Mock()
    principal_id = uuid4()
    row = SimpleNamespace(
        principal_id=principal_id,
        principal_kind="worker",
        name="agent-a",
        owner="tenant-a",
        created_at=datetime.utcnow(),
        principal_metadata={"source": "test"},
        public_key_pem=None,
        source_principal_id=None,
        lifecycle_status="active",
        attestation_status="unattested",
    )

    lookup = Mock()
    lookup.filter_by.return_value.first.return_value = row
    session.query.return_value = lookup
    session.flush.side_effect = lambda: None
    session.commit.side_effect = lambda: None

    from caracal.core import identity as identity_module

    original_has_custody = identity_module.principal_has_key_custody
    original_generate = identity_module.generate_and_store_principal_keypair
    identity_module.principal_has_key_custody = Mock(return_value=False)
    identity_module.generate_and_store_principal_keypair = Mock(
        return_value=SimpleNamespace(
            public_key_pem="rotated-pub",
            storage=SimpleNamespace(metadata={"vault_key_ref": "vault://caracal/runtime/principal-keys/new"}),
        )
    )
    try:
        registry = PrincipalRegistry(session)
        identity = registry.ensure_signing_keys(str(principal_id))
    finally:
        identity_module.principal_has_key_custody = original_has_custody
        identity_module.generate_and_store_principal_keypair = original_generate

    assert row.public_key_pem == "rotated-pub"
    assert row.principal_metadata.get("vault_key_ref") == "vault://caracal/runtime/principal-keys/new"
    assert identity.public_key == "rotated-pub"
    session.commit.assert_called()


@pytest.mark.unit
def test_rotate_signing_keys_tracks_history_and_updates_metadata() -> None:
    session = Mock()
    principal_id = uuid4()
    row = SimpleNamespace(
        principal_id=principal_id,
        principal_kind="human",
        name="user-a",
        owner="tenant-a",
        created_at=datetime.utcnow(),
        principal_metadata={"source": "test"},
        public_key_pem="old-pub",
        source_principal_id=None,
        lifecycle_status="active",
        attestation_status="unattested",
    )

    lookup = Mock()
    lookup.filter_by.return_value.first.return_value = row
    session.query.return_value = lookup
    session.flush.side_effect = lambda: None
    session.commit.side_effect = lambda: None

    from caracal.core import identity as identity_module

    original_generate = identity_module.generate_and_store_principal_keypair
    identity_module.generate_and_store_principal_keypair = Mock(
        return_value=SimpleNamespace(
            public_key_pem="new-pub",
            storage=SimpleNamespace(metadata={"vault_key_ref": "vault://caracal/runtime/principal-keys/rotated"}),
        )
    )
    try:
        registry = PrincipalRegistry(session)
        identity = registry.rotate_signing_keys(
            str(principal_id),
            reason="Compromised credential",
            rotated_by="admin-1",
        )
    finally:
        identity_module.generate_and_store_principal_keypair = original_generate

    history = row.principal_metadata.get("key_rotation_history")
    assert isinstance(history, list)
    assert history[-1]["old_public_key"] == "old-pub"
    assert history[-1]["reason"] == "Compromised credential"
    assert row.principal_metadata.get("vault_key_ref") == "vault://caracal/runtime/principal-keys/rotated"
    assert row.principal_metadata.get("key_rotated_by") == "admin-1"
    assert row.public_key_pem == "new-pub"
    assert identity.public_key == "new-pub"
    session.commit.assert_called()
