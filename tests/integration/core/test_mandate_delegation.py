"""
Integration tests for mandate-delegation interactions.

Tests the integration between mandate management and delegation graph,
ensuring that delegation operations work correctly with mandate lifecycle.
"""
import pytest
from uuid import uuid4

from caracal.core.mandate import MandateManager
from caracal.core.delegation_graph import DelegationGraph
from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.models import Principal, AuthorityPolicy, DelegationEdgeModel

def _make_principal(
    principal_id,
    name,
    principal_type,
    *,
    owner="integration-test",
    with_keys=False,
):
    metadata = None
    public_key_pem = None
    if with_keys:
        generated = generate_and_store_principal_keypair(principal_id)
        metadata = generated.storage.metadata
        public_key_pem = generated.public_key_pem

    return Principal(
        principal_id=principal_id,
        name=name,
        principal_type=principal_type,
        owner=owner,
        public_key_pem=public_key_pem,
        principal_metadata=metadata,
    )


def _make_policy(principal_id, *, allow_delegation, max_network_distance):
    return AuthorityPolicy(
        principal_id=principal_id,
        allowed_resource_patterns=["test:*"],
        allowed_actions=["read", "write"],
        max_validity_seconds=3600,
        allow_delegation=allow_delegation,
        max_network_distance=max_network_distance,
        created_by="integration-test",
        active=True,
    )


def _get_edges_from_source(db_session, source_mandate_id):
    return (
        db_session.query(DelegationEdgeModel)
        .filter(DelegationEdgeModel.source_mandate_id == source_mandate_id)
        .all()
    )


@pytest.mark.integration
class TestMandateDelegationIntegration:
    """Test mandate-delegation integration."""
    
    def test_mandate_creation_with_delegation(self, db_session):
        """Test mandate creation with delegation."""
        # Arrange: Create components
        delegation_graph = DelegationGraph(db_session)
        mandate_manager = MandateManager(db_session, delegation_graph=delegation_graph)
        
        # Create principals
        issuer_id = uuid4()
        issuer = _make_principal(issuer_id, "test-issuer", "user", with_keys=True)
        db_session.add(issuer)

        policy = _make_policy(issuer_id, allow_delegation=True, max_network_distance=2)
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-subject", "worker", with_keys=True)
        db_session.add(subject)

        target_id = uuid4()
        target = _make_principal(target_id, "test-target", "service")
        db_session.add(target)
        db_session.commit()
        
        # Act: Issue source mandate with delegation enabled
        source_mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600,
            network_distance=2
        )
        db_session.commit()
        
        # Delegate to target
        delegated_mandate = mandate_manager.delegate_mandate(
            source_mandate_id=source_mandate.mandate_id,
            target_subject_id=target_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=1800
        )
        db_session.commit()
        
        # Assert: Check that delegation edge was created
        edges = _get_edges_from_source(db_session, source_mandate.mandate_id)
        assert len(edges) == 1
        assert edges[0].source_mandate_id == source_mandate.mandate_id
        assert edges[0].target_mandate_id == delegated_mandate.mandate_id
        assert edges[0].delegation_type == "directed"
        assert delegated_mandate.source_mandate_id == source_mandate.mandate_id
    
    def test_delegation_chain_validation_with_mandates(self, db_session):
        """Test delegation chain validation with mandates."""
        # Arrange: Create components
        delegation_graph = DelegationGraph(db_session)
        mandate_manager = MandateManager(db_session, delegation_graph=delegation_graph)
        
        # Create principals: user -> agent -> service
        user_id = uuid4()
        user = _make_principal(user_id, "test-user", "user", with_keys=True)
        db_session.add(user)

        policy = _make_policy(user_id, allow_delegation=True, max_network_distance=3)
        db_session.add(policy)

        worker_id = uuid4()
        agent = _make_principal(worker_id, "test-worker", "worker", with_keys=True)
        db_session.add(agent)

        service_id = uuid4()
        service = _make_principal(service_id, "test-service", "service")
        db_session.add(service)
        db_session.commit()
        
        # Act: Create delegation chain
        # user -> agent
        mandate1 = mandate_manager.issue_mandate(
            issuer_id=user_id,
            subject_id=worker_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600,
            network_distance=3
        )
        db_session.commit()
        
        # agent -> service
        mandate2 = mandate_manager.delegate_mandate(
            source_mandate_id=mandate1.mandate_id,
            target_subject_id=service_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=1800
        )
        db_session.commit()
        
        # Assert: Validate the delegation chain
        is_valid = delegation_graph.check_delegation_path(mandate2.mandate_id)
        assert is_valid is True
        
        # Check that edges exist
        edges1 = _get_edges_from_source(db_session, mandate1.mandate_id)
        assert len(edges1) == 1
        assert edges1[0].target_mandate_id == mandate2.mandate_id
        assert mandate2.source_mandate_id == mandate1.mandate_id
    
    def test_mandate_revocation_cascades_to_delegations(self, db_session):
        """Test that mandate revocation cascades to delegations."""
        # Arrange: Create components
        delegation_graph = DelegationGraph(db_session)
        mandate_manager = MandateManager(db_session, delegation_graph=delegation_graph)
        
        # Create principals
        issuer_id = uuid4()
        issuer = _make_principal(issuer_id, "test-issuer", "user", with_keys=True)
        db_session.add(issuer)

        policy = _make_policy(issuer_id, allow_delegation=True, max_network_distance=2)
        db_session.add(policy)

        subject_id = uuid4()
        subject = _make_principal(subject_id, "test-subject", "worker", with_keys=True)
        db_session.add(subject)

        target_id = uuid4()
        target = _make_principal(target_id, "test-target", "service")
        db_session.add(target)
        db_session.commit()
        
        # Create mandate and delegation
        source_mandate = mandate_manager.issue_mandate(
            issuer_id=issuer_id,
            subject_id=subject_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=3600,
            network_distance=2
        )
        db_session.commit()
        
        delegated_mandate = mandate_manager.delegate_mandate(
            source_mandate_id=source_mandate.mandate_id,
            target_subject_id=target_id,
            resource_scope=["test:resource"],
            action_scope=["read"],
            validity_seconds=1800
        )
        db_session.commit()
        
        # Act: Revoke source mandate with cascade
        mandate_manager.revoke_mandate(
            mandate_id=source_mandate.mandate_id,
            revoker_id=issuer_id,
            reason="Test cascade revocation",
            cascade=True
        )
        db_session.commit()
        
        # Assert: Check that delegation edge is revoked
        edges = _get_edges_from_source(db_session, source_mandate.mandate_id)
        assert len(edges) == 1
        assert edges[0].revoked is True
        
        # Check that source mandate is revoked
        db_session.refresh(source_mandate)
        assert source_mandate.revoked is True
