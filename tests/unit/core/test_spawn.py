"""Unit tests for atomic spawn orchestration."""

from datetime import datetime
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.spawn import SpawnManager
from caracal.db.models import Principal
from caracal.exceptions import PrincipalNotFoundError


@pytest.mark.unit
class TestSpawnManager:
    def setup_method(self) -> None:
        self.mock_session = Mock()
        self.mock_session.begin_nested.return_value = nullcontext()
        self.mock_mandate_manager = Mock()
        self.mock_ledger_writer = Mock()
        self.mock_nonce_manager = Mock()
        self.mock_nonce_manager.issue_nonce.return_value = SimpleNamespace(nonce="nonce-123")
        self.manager = SpawnManager(
            db_session=self.mock_session,
            mandate_manager=self.mock_mandate_manager,
            ledger_writer=self.mock_ledger_writer,
            attestation_nonce_manager=self.mock_nonce_manager,
        )

    def test_spawn_returns_existing_idempotent_result(self) -> None:
        issuer_id = uuid4()
        existing = self._build_spawn_result(idempotent_replay=True)

        self.manager._find_existing_spawn = Mock(return_value=existing)

        result = self.manager.spawn_principal(
            issuer_principal_id=str(issuer_id),
            principal_name="worker-1",
            principal_kind="worker",
            owner="ops",
            resource_scope=["provider:openai:models"],
            action_scope=["infer"],
            validity_seconds=300,
            idempotency_key="abc-123",
        )

        assert result.principal_id == existing.principal_id
        assert result.mandate_id == existing.mandate_id
        assert result.idempotent_replay is True
        assert result.attestation_nonce == "nonce-123"
        self.mock_session.query.assert_not_called()
        self.mock_mandate_manager.issue_mandate.assert_not_called()
        self.mock_nonce_manager.issue_nonce.assert_called_once_with(existing.principal_id)

    def test_spawn_raises_when_issuer_missing(self) -> None:
        issuer_id = uuid4()
        self.manager._find_existing_spawn = Mock(return_value=None)

        principal_query = Mock()
        principal_query.filter.return_value.first.return_value = None
        self.mock_session.query.return_value = principal_query

        with pytest.raises(PrincipalNotFoundError):
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-2",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="xyz-456",
            )

    def test_spawn_issues_mandate_and_ledger_event(self) -> None:
        issuer_id = uuid4()
        principal_id = uuid4()
        mandate_id = uuid4()

        self.manager._find_existing_spawn = Mock(return_value=None)

        issuer_row = SimpleNamespace(principal_id=issuer_id)
        principal_row = SimpleNamespace(
            principal_id=principal_id,
            name="worker-3",
            principal_kind="worker",
            public_key_pem=None,
        )
        duplicate = None

        principal_query = Mock()
        principal_query.filter.return_value.first.side_effect = [issuer_row, duplicate]

        def _query_side_effect(model):
            return principal_query

        self.mock_session.query.side_effect = _query_side_effect

        captured_principal = {"row": None}

        def _capture_add(obj):
            if isinstance(obj, Principal):
                obj.principal_id = principal_id
                principal_row.principal_id = principal_id
                principal_row.name = getattr(obj, "name", principal_row.name)
                principal_row.principal_kind = getattr(obj, "principal_kind", principal_row.principal_kind)
                captured_principal["row"] = obj

        self.mock_session.add.side_effect = _capture_add

        self.mock_mandate_manager.issue_mandate.return_value = SimpleNamespace(mandate_id=mandate_id)

        # Patch key generation path to avoid backend calls in unit test.
        from caracal.core import spawn as spawn_module

        original_generate = spawn_module.generate_and_store_principal_keypair
        spawn_module.generate_and_store_principal_keypair = Mock(
            return_value=SimpleNamespace(public_key_pem="pub", storage=SimpleNamespace(metadata={}))
        )
        try:
            result = self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-3",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="spawn-777",
            )
        finally:
            spawn_module.generate_and_store_principal_keypair = original_generate

        assert result.principal_id == str(principal_id)
        assert result.mandate_id == str(mandate_id)
        assert result.idempotent_replay is False
        assert result.attestation_bootstrap_artifact == f"attest-bootstrap:{principal_id}"
        assert result.attestation_nonce == "nonce-123"
        assert captured_principal["row"] is not None
        assert captured_principal["row"].lifecycle_status == "pending_attestation"
        assert captured_principal["row"].attestation_status == "pending"

        self.mock_mandate_manager.issue_mandate.assert_called_once()
        self.mock_ledger_writer.append_event.assert_called_once()
        self.mock_nonce_manager.issue_nonce.assert_called_once_with(str(principal_id))

    @staticmethod
    def _build_spawn_result(idempotent_replay: bool):
        return SimpleNamespace(
            principal_id=str(uuid4()),
            principal_name="existing-worker",
            principal_kind="worker",
            mandate_id=str(uuid4()),
            attestation_bootstrap_artifact="attest-bootstrap:existing",
            attestation_nonce="",
            idempotent_replay=idempotent_replay,
        )
