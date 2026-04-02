"""
Integration tests for mandate-delegation interactions.

Tests the integration between mandate management and delegation graph,
ensuring that delegation operations work correctly with mandate lifecycle.
"""
import pytest
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.core.mandate import MandateManager
from caracal.core.delegation_graph import DelegationGraph
from caracal.db.models import Principal, ExecutionMandate, AuthorityPolicy
from tests.fixtures.database import db_session, in_memory_db_engine


@pytest.mark.integration
class TestMandateDelegationIntegration:
    """Test mandate-delegation integration."""
    
    def test_mandate_creation_with_delegation(self, db_session):
        """Test mandate creation with delegation."""
        # Arrange: Create components
        mandate_manager = MandateManager(db_session)
        delegation_graph = DelegationGraph(db_session)
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=True,
            max_network_distance=2,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-subject",
            principal_type="agent"
        )
        db_session.add(subject)
        
        target_id = uuid4()
        target = Principal(
            principal_id=target_id,
            principal_name="test-target",
            principal_type="service"
        )
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
        edges = delegation_graph.get_edges(source_mandate_id=source_mandate.mandate_id)
        assert len(edges) == 1
        assert edges[0].source_mandate_id == source_mandate.mandate_id
        assert edges[0].target_mandate_id == delegated_mandate.mandate_id
        assert edges[0].delegation_type == "directed"
    
    def test_delegation_chain_validation_with_mandates(self, db_session):
        """Test delegation chain validation with mandates."""
        # Arrange: Create components
        mandate_manager = MandateManager(db_session)
        delegation_graph = DelegationGraph(db_session)
        
        # Create principals: user -> agent -> service
        user_id = uuid4()
        user = Principal(
            principal_id=user_id,
            principal_name="test-user",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(user)
        
        policy = AuthorityPolicy(
            principal_id=user_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=True,
            max_network_distance=3,
            active=True
        )
        db_session.add(policy)
        
        agent_id = uuid4()
        agent = Principal(
            principal_id=agent_id,
            principal_name="test-agent",
            principal_type="agent",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(agent)
        
        service_id = uuid4()
        service = Principal(
            principal_id=service_id,
            principal_name="test-service",
            principal_type="service"
        )
        db_session.add(service)
        db_session.commit()
        
        # Act: Create delegation chain
        # user -> agent
        mandate1 = mandate_manager.issue_mandate(
            issuer_id=user_id,
            subject_id=agent_id,
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
        edges1 = delegation_graph.get_edges(source_mandate_id=mandate1.mandate_id)
        assert len(edges1) == 1
        assert edges1[0].target_mandate_id == mandate2.mandate_id
    
    def test_mandate_revocation_cascades_to_delegations(self, db_session):
        """Test that mandate revocation cascades to delegations."""
        # Arrange: Create components
        mandate_manager = MandateManager(db_session)
        delegation_graph = DelegationGraph(db_session)
        
        # Create principals
        issuer_id = uuid4()
        issuer = Principal(
            principal_id=issuer_id,
            principal_name="test-issuer",
            principal_type="user",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(issuer)
        
        policy = AuthorityPolicy(
            principal_id=issuer_id,
            allowed_resource_patterns=["test:*"],
            allowed_actions=["read", "write"],
            max_validity_seconds=3600,
            allow_delegation=True,
            max_network_distance=2,
            active=True
        )
        db_session.add(policy)
        
        subject_id = uuid4()
        subject = Principal(
            principal_id=subject_id,
            principal_name="test-subject",
            principal_type="agent",
            private_key_pem="-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTest1234567890Test1234567890Test1234567890hRACBggg==\n-----END PRIVATE KEY-----",
            public_key_pem="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETest1234567890Test1234567890Test1234567890Test1234567890==\n-----END PUBLIC KEY-----"
        )
        db_session.add(subject)
        
        target_id = uuid4()
        target = Principal(
            principal_id=target_id,
            principal_name="test-target",
            principal_type="service"
        )
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
        edges = delegation_graph.get_edges(source_mandate_id=source_mandate.mandate_id)
        assert len(edges) == 1
        assert edges[0].revoked is True
        
        # Check that source mandate is revoked
        db_session.refresh(source_mandate)
        assert source_mandate.revoked is True
