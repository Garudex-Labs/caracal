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
            storage=SimpleNamespace(metadata={"private_key_ref": "/tmp/key.pem"}),
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
    assert identity.metadata.get("private_key_ref") == "/tmp/key.pem"
