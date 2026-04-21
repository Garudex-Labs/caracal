"""Unit tests for atomic spawn orchestration."""

from datetime import datetime, timedelta
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.spawn import SpawnManager
from caracal.db.models import ExecutionMandate, Principal
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
        self.mock_nonce_manager.ttl_seconds = 300
        self.mock_principal_ttl_manager = Mock()
        self.mock_principal_ttl_manager.constrain_child_ttl.return_value = SimpleNamespace(
            requested_ttl_seconds=300,
            effective_ttl_seconds=300,
            parent_remaining_ttl_seconds=None,
            truncated=False,
        )
        self.manager = SpawnManager(
            db_session=self.mock_session,
            mandate_manager=self.mock_mandate_manager,
            ledger_writer=self.mock_ledger_writer,
            attestation_nonce_manager=self.mock_nonce_manager,
            principal_ttl_manager=self.mock_principal_ttl_manager,
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
        self.mock_principal_ttl_manager.register_pending_principal.assert_called_once()

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

        issuer_row = SimpleNamespace(principal_id=issuer_id, principal_kind="orchestrator")
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
        self.mock_principal_ttl_manager.register_pending_principal.assert_called_once_with(
            principal_id=str(principal_id),
            pending_ttl_seconds=300,
            active_ttl_seconds=300,
            parent_principal_id=str(issuer_id),
        )

    def test_spawn_truncates_child_ttl_to_parent_remaining_lifetime(self) -> None:
        issuer_id = uuid4()
        principal_id = uuid4()
        mandate_id = uuid4()

        self.manager._find_existing_spawn = Mock(return_value=None)
        self.mock_principal_ttl_manager.constrain_child_ttl.return_value = SimpleNamespace(
            requested_ttl_seconds=600,
            effective_ttl_seconds=120,
            parent_remaining_ttl_seconds=120,
            truncated=True,
        )

        issuer_row = SimpleNamespace(principal_id=issuer_id, principal_kind="orchestrator")
        duplicate = None
        principal_query = Mock()
        principal_query.filter.return_value.first.side_effect = [issuer_row, duplicate]
        self.mock_session.query.side_effect = lambda _model: principal_query

        def _capture_add(obj):
            if isinstance(obj, Principal):
                obj.principal_id = principal_id

        self.mock_session.add.side_effect = _capture_add
        self.mock_mandate_manager.issue_mandate.return_value = SimpleNamespace(mandate_id=mandate_id)

        from caracal.core import spawn as spawn_module

        original_generate = spawn_module.generate_and_store_principal_keypair
        spawn_module.generate_and_store_principal_keypair = Mock(
            return_value=SimpleNamespace(public_key_pem="pub", storage=SimpleNamespace(metadata={}))
        )
        try:
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-truncated",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=600,
                idempotency_key="spawn-ttl",
            )
        finally:
            spawn_module.generate_and_store_principal_keypair = original_generate

        assert self.mock_mandate_manager.issue_mandate.call_args.kwargs["validity_seconds"] == 120

    def test_spawn_rejects_scope_amplification_before_transaction(self) -> None:
        issuer_id = uuid4()
        source_mandate_id = uuid4()
        self.manager._find_existing_spawn = Mock(return_value=None)

        source_mandate = SimpleNamespace(
            mandate_id=source_mandate_id,
            subject_id=issuer_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=1),
            valid_until=datetime.utcnow() + timedelta(minutes=5),
            resource_scope=["provider:openai:*"],
            action_scope=["infer"],
            network_distance=2,
        )
        source_query = Mock()
        source_query.filter.return_value.first.return_value = source_mandate

        def _query_side_effect(model):
            if model is ExecutionMandate:
                return source_query
            raise AssertionError("Unexpected query after pre-write source mandate validation failure")

        self.mock_session.query.side_effect = _query_side_effect

        with pytest.raises(ValueError, match="resource scope"):
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-invalid-scope",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:anthropic:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="spawn-invalid-scope",
                source_mandate_id=str(source_mandate_id),
            )

        self.mock_session.begin_nested.assert_not_called()
        self.mock_session.add.assert_not_called()
        self.mock_mandate_manager.issue_mandate.assert_not_called()

    def test_spawn_rejects_depth_amplification_before_transaction(self) -> None:
        issuer_id = uuid4()
        source_mandate_id = uuid4()
        self.manager._find_existing_spawn = Mock(return_value=None)

        source_mandate = SimpleNamespace(
            mandate_id=source_mandate_id,
            subject_id=issuer_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=1),
            valid_until=datetime.utcnow() + timedelta(minutes=5),
            resource_scope=["provider:openai:*"],
            action_scope=["infer"],
            network_distance=1,
        )
        source_query = Mock()
        source_query.filter.return_value.first.return_value = source_mandate

        def _query_side_effect(model):
            if model is ExecutionMandate:
                return source_query
            raise AssertionError("Unexpected query after pre-write source mandate validation failure")

        self.mock_session.query.side_effect = _query_side_effect

        with pytest.raises(ValueError, match="delegation depth"):
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-invalid-depth",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="spawn-invalid-depth",
                source_mandate_id=str(source_mandate_id),
                network_distance=1,
            )

        self.mock_session.begin_nested.assert_not_called()
        self.mock_session.add.assert_not_called()
        self.mock_mandate_manager.issue_mandate.assert_not_called()

    def test_spawn_derives_child_depth_from_source_mandate_when_unspecified(self) -> None:
        issuer_id = uuid4()
        principal_id = uuid4()
        source_mandate_id = uuid4()
        mandate_id = uuid4()
        self.manager._find_existing_spawn = Mock(return_value=None)

        source_mandate = SimpleNamespace(
            mandate_id=source_mandate_id,
            subject_id=issuer_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=1),
            valid_until=datetime.utcnow() + timedelta(minutes=5),
            resource_scope=["provider:openai:*"],
            action_scope=["infer"],
            network_distance=3,
        )
        source_query = Mock()
        source_query.filter.return_value.first.return_value = source_mandate

        issuer_row = SimpleNamespace(principal_id=issuer_id, principal_kind="orchestrator")
        duplicate = None
        principal_query = Mock()
        principal_query.filter.return_value.first.side_effect = [issuer_row, duplicate]

        def _query_side_effect(model):
            if model is ExecutionMandate:
                return source_query
            if model is Principal:
                return principal_query
            return principal_query

        self.mock_session.query.side_effect = _query_side_effect

        def _capture_add(obj):
            if isinstance(obj, Principal):
                obj.principal_id = principal_id

        self.mock_session.add.side_effect = _capture_add
        self.mock_mandate_manager.issue_mandate.return_value = SimpleNamespace(mandate_id=mandate_id)

        from caracal.core import spawn as spawn_module

        original_generate = spawn_module.generate_and_store_principal_keypair
        spawn_module.generate_and_store_principal_keypair = Mock(
            return_value=SimpleNamespace(public_key_pem="pub", storage=SimpleNamespace(metadata={}))
        )
        try:
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-derived-depth",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="spawn-derived-depth",
                source_mandate_id=str(source_mandate_id),
            )
        finally:
            spawn_module.generate_and_store_principal_keypair = original_generate

        assert self.mock_mandate_manager.issue_mandate.call_args.kwargs["network_distance"] == 2

    def test_spawn_rolls_back_before_ttl_registration_when_nonce_issue_fails(self) -> None:
        issuer_id = uuid4()
        principal_id = uuid4()
        mandate_id = uuid4()

        self.manager._find_existing_spawn = Mock(return_value=None)
        self.mock_nonce_manager.issue_nonce.side_effect = RuntimeError("nonce backend unavailable")

        issuer_row = SimpleNamespace(principal_id=issuer_id, principal_kind="orchestrator")
        duplicate = None
        principal_query = Mock()
        principal_query.filter.return_value.first.side_effect = [issuer_row, duplicate]
        self.mock_session.query.side_effect = lambda _model: principal_query

        def _capture_add(obj):
            if isinstance(obj, Principal):
                obj.principal_id = principal_id

        self.mock_session.add.side_effect = _capture_add
        self.mock_mandate_manager.issue_mandate.return_value = SimpleNamespace(mandate_id=mandate_id)

        from caracal.core import spawn as spawn_module

        original_generate = spawn_module.generate_and_store_principal_keypair
        spawn_module.generate_and_store_principal_keypair = Mock(
            return_value=SimpleNamespace(public_key_pem="pub", storage=SimpleNamespace(metadata={}))
        )
        try:
            with pytest.raises(RuntimeError, match="nonce backend unavailable"):
                self.manager.spawn_principal(
                    issuer_principal_id=str(issuer_id),
                    principal_name="worker-nonce-failure",
                    principal_kind="worker",
                    owner="ops",
                    resource_scope=["provider:openai:models"],
                    action_scope=["infer"],
                    validity_seconds=300,
                    idempotency_key="spawn-nonce-failure",
                )
        finally:
            spawn_module.generate_and_store_principal_keypair = original_generate

        self.mock_principal_ttl_manager.register_pending_principal.assert_not_called()

    def test_spawn_cleans_up_nonce_when_ttl_registration_fails(self) -> None:
        issuer_id = uuid4()
        principal_id = uuid4()
        mandate_id = uuid4()

        self.manager._find_existing_spawn = Mock(return_value=None)
        self.mock_principal_ttl_manager.register_pending_principal.side_effect = RuntimeError(
            "ttl backend unavailable"
        )
        issued_nonce = SimpleNamespace(nonce="nonce-cleanup")
        self.mock_nonce_manager.issue_nonce.return_value = issued_nonce
        self.mock_nonce_manager.revoke_nonce = Mock()
        self.mock_principal_ttl_manager.clear_principal = Mock()

        issuer_row = SimpleNamespace(principal_id=issuer_id, principal_kind="orchestrator")
        duplicate = None
        principal_query = Mock()
        principal_query.filter.return_value.first.side_effect = [issuer_row, duplicate]
        self.mock_session.query.side_effect = lambda _model: principal_query

        def _capture_add(obj):
            if isinstance(obj, Principal):
                obj.principal_id = principal_id

        self.mock_session.add.side_effect = _capture_add
        self.mock_mandate_manager.issue_mandate.return_value = SimpleNamespace(mandate_id=mandate_id)

        from caracal.core import spawn as spawn_module

        original_generate = spawn_module.generate_and_store_principal_keypair
        spawn_module.generate_and_store_principal_keypair = Mock(
            return_value=SimpleNamespace(public_key_pem="pub", storage=SimpleNamespace(metadata={}))
        )
        try:
            with pytest.raises(RuntimeError, match="ttl backend unavailable"):
                self.manager.spawn_principal(
                    issuer_principal_id=str(issuer_id),
                    principal_name="worker-ttl-failure",
                    principal_kind="worker",
                    owner="ops",
                    resource_scope=["provider:openai:models"],
                    action_scope=["infer"],
                    validity_seconds=300,
                    idempotency_key="spawn-ttl-failure",
                )
        finally:
            spawn_module.generate_and_store_principal_keypair = original_generate

        self.mock_nonce_manager.revoke_nonce.assert_called_once_with("nonce-cleanup")
        self.mock_principal_ttl_manager.clear_principal.assert_called_once_with(str(principal_id))

    def test_spawn_rejects_service_principal_as_issuer(self) -> None:
        issuer_id = uuid4()

        self.manager._find_existing_spawn = Mock(return_value=None)

        service_issuer = SimpleNamespace(principal_id=issuer_id, principal_kind="service")
        principal_query = Mock()
        principal_query.filter.return_value.first.return_value = service_issuer
        self.mock_session.query.return_value = principal_query

        with pytest.raises(ValueError, match="Service principal"):
            self.manager.spawn_principal(
                issuer_principal_id=str(issuer_id),
                principal_name="worker-bad-issuer",
                principal_kind="worker",
                owner="ops",
                resource_scope=["provider:openai:models"],
                action_scope=["infer"],
                validity_seconds=300,
                idempotency_key="spawn-service-issuer",
            )

        self.mock_session.add.assert_not_called()
        self.mock_mandate_manager.issue_mandate.assert_not_called()

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
