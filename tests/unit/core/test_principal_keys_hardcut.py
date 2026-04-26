"""Focused unit tests for hard-cut principal key custody helpers."""

from __future__ import annotations

import os
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from caracal.core.principal_keys import (
    generate_and_store_principal_keypair,
    resolve_principal_key_reference,
)
from caracal.db.models import PrincipalKeyBackend


@pytest.mark.unit
def test_generate_and_store_principal_keypair_bootstraps_only_via_vault() -> None:
    principal_id = uuid4()
    mock_vault = Mock()
    mock_vault.get.return_value = "public-key-pem"

    with patch.dict(
        os.environ,
        {
            "CCL_PRINCIPAL_KEY_BACKEND": "vault",
            "CCL_VAULT_WORKSPACE_ID": "caracal",
            "CCL_VAULT_ENVIRONMENT": "runtime",
            "CCL_VAULT_PRINCIPAL_KEY_PREFIX": "principal-keys",
        },
        clear=False,
    ):
        with patch("caracal.core.principal_keys.get_vault", return_value=mock_vault):
            result = generate_and_store_principal_keypair(principal_id)

    expected_private_name = f"principal-keys/{principal_id}"
    expected_public_name = f"{expected_private_name}.public"

    mock_vault.ensure_asymmetric_keypair.assert_called_once_with(
        workspace_id="caracal",
        env_id="runtime",
        private_key_name=expected_private_name,
        public_key_name=expected_public_name,
        algorithm="ES256",
        actor=f"principal-keys:{principal_id}",
    )
    mock_vault.get.assert_called_once_with(
        workspace_id="caracal",
        env_id="runtime",
        name=expected_public_name,
    )
    assert result.public_key_pem == "public-key-pem"
    assert result.storage.backend == PrincipalKeyBackend.VAULT.value
    assert result.storage.reference == f"vault://caracal/runtime/{expected_private_name}"
    assert result.storage.metadata["vault_public_key_ref"] == (
        f"vault://caracal/runtime/{expected_public_name}"
    )


@pytest.mark.unit
def test_generate_and_store_principal_keypair_updates_custody_record() -> None:
    principal_id = uuid4()
    mock_vault = Mock()
    mock_vault.get.return_value = "public-key-pem"
    session = Mock()

    custody_lookup = Mock()
    custody_lookup.filter_by.return_value.first.return_value = None
    session.query.return_value = custody_lookup

    added_rows: list[object] = []
    session.add.side_effect = added_rows.append
    session.flush.side_effect = lambda: None

    with patch.dict(
        os.environ,
        {
            "CCL_PRINCIPAL_KEY_BACKEND": "vault",
            "CCL_VAULT_WORKSPACE_ID": "caracal",
            "CCL_VAULT_ENVIRONMENT": "runtime",
            "CCL_VAULT_PRINCIPAL_KEY_PREFIX": "principal-keys",
        },
        clear=False,
    ):
        with patch("caracal.core.principal_keys.get_vault", return_value=mock_vault):
            result = generate_and_store_principal_keypair(principal_id, db_session=session)

    assert result.public_key_pem == "public-key-pem"
    assert len(added_rows) == 1
    custody = added_rows[0]
    assert custody.principal_id == principal_id
    assert custody.backend == PrincipalKeyBackend.VAULT.value
    assert custody.key_reference == f"vault://caracal/runtime/principal-keys/{principal_id}"
    assert custody.vault_details.vault_key_ref == custody.key_reference
    assert custody.vault_details.vault_namespace == "caracal/runtime"


@pytest.mark.unit
def test_generate_and_store_principal_keypair_uses_project_environment_context_when_set() -> None:
    principal_id = uuid4()
    mock_vault = Mock()
    mock_vault.get.return_value = "public-key-pem"

    with patch.dict(
        os.environ,
        {
            "CCL_PRINCIPAL_KEY_BACKEND": "vault",
            "CCL_VAULT_WORKSPACE_ID": "project-123",
            "CCL_VAULT_ENVIRONMENT": "dev",
            "CCL_VAULT_PRINCIPAL_KEY_PREFIX": "principal-keys",
        },
        clear=False,
    ):
        with patch("caracal.core.principal_keys.get_vault", return_value=mock_vault):
            generate_and_store_principal_keypair(principal_id)

    expected_private_name = f"principal-keys/{principal_id}"
    expected_public_name = f"{expected_private_name}.public"

    mock_vault.ensure_asymmetric_keypair.assert_called_once_with(
        workspace_id="project-123",
        env_id="dev",
        private_key_name=expected_private_name,
        public_key_name=expected_public_name,
        algorithm="ES256",
        actor=f"principal-keys:{principal_id}",
    )


@pytest.mark.unit
def test_generate_and_store_principal_keypair_resolves_project_uuid_from_vault_config() -> None:
    principal_id = uuid4()
    mock_vault = Mock()
    mock_vault.get.return_value = "public-key-pem"
    mock_vault._config = Mock(default_project="205db281-d6e7-4268-8dc8-20dba46b5067")

    with patch.dict(
        os.environ,
        {
            "CCL_PRINCIPAL_KEY_BACKEND": "vault",
            "CCL_VAULT_WORKSPACE_ID": "caracal",
            "CCL_VAULT_ENVIRONMENT": "dev",
            "CCL_VAULT_PRINCIPAL_KEY_PREFIX": "principal-keys",
        },
        clear=False,
    ):
        with patch("caracal.core.principal_keys.get_vault", return_value=mock_vault):
            generate_and_store_principal_keypair(principal_id)

    expected_private_name = f"principal-keys/{principal_id}"
    expected_public_name = f"{expected_private_name}.public"

    mock_vault.ensure_asymmetric_keypair.assert_called_once_with(
        workspace_id="205db281-d6e7-4268-8dc8-20dba46b5067",
        env_id="dev",
        private_key_name=expected_private_name,
        public_key_name=expected_public_name,
        algorithm="ES256",
        actor=f"principal-keys:{principal_id}",
    )


@pytest.mark.unit
def test_resolve_principal_key_reference_reads_metadata_fallback() -> None:
    principal_id = uuid4()
    session = Mock()

    custody_lookup = Mock()
    custody_lookup.filter_by.return_value.first.return_value = None
    session.query.return_value = custody_lookup

    reference = resolve_principal_key_reference(
        principal_id,
        db_session=session,
        principal_metadata={"vault_key_ref": "vault://caracal/runtime/principal-keys/test"},
    )

    assert reference == "vault://caracal/runtime/principal-keys/test"
