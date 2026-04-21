"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

End-to-end tests for delegation chain mandate workflows.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from caracal.core.authority import AuthorityEvaluator, AuthorityReasonCode
from caracal.core.authority_ledger import AuthorityLedgerWriter
from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import AuthorityPolicy, Principal
from tests.fixtures.database import db_session, in_memory_db_engine


def _make_principal(principal_id, name, kind, *, with_keys: bool = False):
    public_key_pem = None
    metadata = None
    if with_keys:
        generated = generate_and_store_principal_keypair(principal_id)
        public_key_pem = generated.public_key_pem
        metadata = generated.storage.metadata
    return Principal(
        principal_id=principal_id,
        name=name,
        principal_kind=kind,
        owner="e2e-chain-test",
        lifecycle_status="active",
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _make_policy(principal_id, *, allow_delegation: bool = False, max_distance: int = 0):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["provider:ops-api:resource:*"],
        allowed_actions=["provider:ops-api:action:*"],
        max_validity_seconds=3600,
        allow_delegation=allow_delegation,
        max_network_distance=max_distance,
        created_by="e2e-chain-test",
        active=True,
    )


@pytest.mark.e2e
class TestDelegationChain:
    """Delegation chain: human issues to orchestrator, orchestrator to worker."""

    def test_human_to_orchestrator_to_worker(self, db_session) -> None:
        human_id = uuid4()
        orch_id = uuid4()
        worker_id = uuid4()
        db_session.add_all([
            _make_principal(human_id, "human", "human", with_keys=True),
            _make_principal(orch_id, "orchestrator", "orchestrator", with_keys=True),
            _make_principal(worker_id, "worker", "worker"),
            _make_policy(human_id, allow_delegation=True, max_distance=2),
            _make_policy(orch_id, allow_delegation=True, max_distance=1),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)

        parent_mandate = manager.issue_mandate(
            issuer_id=human_id,
            subject_id=orch_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
            delegation_type="directed",
            network_distance=2,
        )
        db_session.commit()

        child_mandate = manager.issue_mandate(
            issuer_id=orch_id,
            subject_id=worker_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
            delegation_type="directed",
            source_mandate_id=parent_mandate.mandate_id,
            network_distance=1,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=child_mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is True

    def test_revoked_parent_denies_child(self, db_session) -> None:
        human_id = uuid4()
        orch_id = uuid4()
        worker_id = uuid4()
        db_session.add_all([
            _make_principal(human_id, "human-r", "human", with_keys=True),
            _make_principal(orch_id, "orchestrator-r", "orchestrator", with_keys=True),
            _make_principal(worker_id, "worker-r", "worker"),
            _make_policy(human_id, allow_delegation=True, max_distance=2),
            _make_policy(orch_id, allow_delegation=True, max_distance=1),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)

        parent_mandate = manager.issue_mandate(
            issuer_id=human_id,
            subject_id=orch_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
            delegation_type="directed",
            network_distance=2,
        )
        db_session.commit()

        child_mandate = manager.issue_mandate(
            issuer_id=orch_id,
            subject_id=worker_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
            delegation_type="directed",
            source_mandate_id=parent_mandate.mandate_id,
            network_distance=1,
        )
        db_session.commit()

        manager.revoke_mandate(
            mandate_id=parent_mandate.mandate_id,
            revoker_id=human_id,
            reason="cascade revocation e2e test",
            cascade=True,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        decision = evaluator.validate_mandate(
            mandate=child_mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert decision.allowed is False

    def test_scope_narrowing_in_delegation(self, db_session) -> None:
        human_id = uuid4()
        worker_id = uuid4()
        db_session.add_all([
            _make_principal(human_id, "human-sn", "human", with_keys=True),
            _make_principal(worker_id, "worker-sn", "worker"),
            _make_policy(human_id),
        ])
        db_session.commit()

        ledger = AuthorityLedgerWriter(db_session)
        manager = MandateManager(db_session=db_session, ledger_writer=ledger)
        mandate = manager.issue_mandate(
            issuer_id=human_id,
            subject_id=worker_id,
            resource_scope=["provider:ops-api:resource:incident"],
            action_scope=["provider:ops-api:action:read_incident"],
            validity_seconds=3600,
        )
        db_session.commit()

        evaluator = AuthorityEvaluator(db_session, ledger_writer=ledger)
        allow = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:read_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        deny = evaluator.validate_mandate(
            mandate=mandate,
            requested_action="provider:ops-api:action:delete_incident",
            requested_resource="provider:ops-api:resource:incident",
        )
        assert allow.allowed is True
        assert deny.allowed is False
