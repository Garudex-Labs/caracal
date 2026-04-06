"""
Unit tests for database models.

This module tests SQLAlchemy model definitions and relationships.
"""
import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from caracal.db.models import (
    Principal,
    ExecutionMandate,
    DelegationEdgeModel,
    PrincipalKeyCustody,
    PrincipalWorkloadBinding,
    LedgerEvent,
    AuditLog,
    MerkleRoot,
    LedgerSnapshot,
    AuthorityLedgerEvent,
    AuthorityPolicy,
    GatewayProvider,
    EnterpriseRuntimeConfig,
    SessionHandoffTransfer,
)


@pytest.mark.unit
class TestPrincipalModel:
    """Test suite for Principal model."""
    
    def test_principal_creation(self):
        """Test Principal model instantiation with valid data."""
        # Arrange & Act
        principal = Principal(
            principal_id=uuid4(),
            name="test-agent",
            principal_kind="worker",
            owner="test-owner",
            public_key_pem="test-public-key",
            principal_metadata={"env": "test"}
        )
        
        # Assert
        assert principal.name == "test-agent"
        assert principal.principal_kind == "worker"
        assert principal.owner == "test-owner"
        assert principal.public_key_pem == "test-public-key"
        assert principal.principal_metadata["env"] == "test"

    def test_principal_identity_fields_exclude_authority_and_runtime_session_columns(self):
        """Identity records must stay distinct from graph-edge and session artifacts."""
        column_names = {column.name for column in Principal.__table__.columns}

        assert "source_mandate_id" not in column_names
        assert "target_mandate_id" not in column_names
        assert "handoff_jti" not in column_names
        assert "refresh_token" not in column_names

    def test_principal_relationships_keep_key_and_workload_artifacts_out_of_identity_columns(self):
        """Key custody and workload bindings should remain typed side tables."""
        assert Principal.key_custody.property.mapper.class_ is PrincipalKeyCustody
        assert Principal.workload_bindings.property.mapper.class_ is PrincipalWorkloadBinding

    def test_principal_repr(self):
        """Test Principal string representation."""
        # Arrange
        principal_id = uuid4()
        principal = Principal(
            principal_id=principal_id,
            name="test-agent",
            principal_kind="worker",
            owner="test-owner"
        )

        # Act
        repr_str = repr(principal)

        # Assert
        assert "Principal" in repr_str
        assert str(principal_id) in repr_str
        assert "test-agent" in repr_str
        assert "worker" in repr_str


@pytest.mark.unit
def test_authority_and_runtime_session_artifacts_use_distinct_tables() -> None:
    """Authority edges and runtime handoff state should remain isolated from identity rows."""
    assert DelegationEdgeModel.__tablename__ == "delegation_edges"
    assert SessionHandoffTransfer.__tablename__ == "session_handoff_transfers"
    assert DelegationEdgeModel.__tablename__ != SessionHandoffTransfer.__tablename__


@pytest.mark.unit
class TestExecutionMandateModel:
    """Test suite for ExecutionMandate model."""
    
    def test_mandate_creation(self):
        """Test ExecutionMandate model instantiation with valid data."""
        # Arrange
        issuer_id = uuid4()
        subject_id = uuid4()
        now = datetime.utcnow()
        
        # Act
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=subject_id,
            valid_from=now,
            valid_until=now + timedelta(hours=1),
            resource_scope=["secrets/*"],
            action_scope=["read"],
            signature="test-signature",
            revoked=False
        )
        
        # Assert
        assert mandate.issuer_id == issuer_id
        assert mandate.subject_id == subject_id
        assert mandate.resource_scope == ["secrets/*"]
        assert mandate.action_scope == ["read"]
        assert mandate.revoked is False
    
    def test_mandate_revocation(self):
        """Test mandate revocation fields."""
        # Arrange
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow(),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secrets/*"],
            action_scope=["read"],
            signature="test-signature"
        )
        
        # Act
        mandate.revoked = True
        mandate.revoked_at = datetime.utcnow()
        mandate.revocation_reason = "Security breach"
        
        # Assert
        assert mandate.revoked is True
        assert mandate.revoked_at is not None
        assert mandate.revocation_reason == "Security breach"
    
    def test_mandate_repr(self):
        """Test ExecutionMandate string representation."""
        # Arrange
        mandate_id = uuid4()
        subject_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=uuid4(),
            subject_id=subject_id,
            valid_from=datetime.utcnow(),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secrets/*"],
            action_scope=["read"],
            signature="test-signature",
            revoked=False
        )
        
        # Act
        repr_str = repr(mandate)
        
        # Assert
        assert "ExecutionMandate" in repr_str
        assert str(mandate_id) in repr_str
        assert str(subject_id) in repr_str


@pytest.mark.unit
class TestDelegationEdgeModel:
    """Test suite for DelegationEdgeModel."""
    
    def test_delegation_edge_creation(self):
        """Test DelegationEdgeModel instantiation with valid data."""
        # Arrange
        source_mandate_id = uuid4()
        target_mandate_id = uuid4()
        
        # Act
        edge = DelegationEdgeModel(
            edge_id=uuid4(),
            source_mandate_id=source_mandate_id,
            target_mandate_id=target_mandate_id,
            source_principal_type="user",
            target_principal_type="agent",
            delegation_type="directed",
            context_tags=["production"],
            revoked=False
        )
        
        # Assert
        assert edge.source_mandate_id == source_mandate_id
        assert edge.target_mandate_id == target_mandate_id
        assert edge.source_principal_type == "user"
        assert edge.target_principal_type == "agent"
        assert edge.delegation_type == "directed"
        assert edge.context_tags == ["production"]
    
    def test_delegation_edge_repr(self):
        """Test DelegationEdgeModel string representation."""
        # Arrange
        edge_id = uuid4()
        edge = DelegationEdgeModel(
            edge_id=edge_id,
            source_mandate_id=uuid4(),
            target_mandate_id=uuid4(),
            source_principal_type="user",
            target_principal_type="agent",
            delegation_type="directed",
            revoked=False
        )
        
        # Act
        repr_str = repr(edge)
        
        # Assert
        assert "DelegationEdge" in repr_str
        assert str(edge_id) in repr_str
        assert "user" in repr_str
        assert "agent" in repr_str


@pytest.mark.unit
class TestLedgerEventModel:
    """Test suite for LedgerEvent model."""
    
    def test_ledger_event_creation(self):
        """Test LedgerEvent model instantiation with valid data."""
        # Arrange
        principal_id = uuid4()
        
        # Act
        event = LedgerEvent(
            principal_id=principal_id,
            timestamp=datetime.utcnow(),
            resource_type="api_calls",
            quantity=Decimal("10.5"),
            event_metadata={"endpoint": "/api/v1/secrets"}
        )
        
        # Assert
        assert event.principal_id == principal_id
        assert event.resource_type == "api_calls"
        assert event.quantity == Decimal("10.5")
        assert event.event_metadata["endpoint"] == "/api/v1/secrets"
    
    def test_ledger_event_repr(self):
        """Test LedgerEvent string representation."""
        # Arrange
        principal_id = uuid4()
        event = LedgerEvent(
            principal_id=principal_id,
            timestamp=datetime.utcnow(),
            resource_type="api_calls",
            quantity=Decimal("10.5")
        )
        event.event_id = 12345
        
        # Act
        repr_str = repr(event)
        
        # Assert
        assert "LedgerEvent" in repr_str
        assert "12345" in repr_str
        assert str(principal_id) in repr_str


@pytest.mark.unit
class TestMerkleRootModel:
    """Test suite for MerkleRoot model."""
    
    def test_merkle_root_creation(self):
        """Test MerkleRoot model instantiation with valid data."""
        # Arrange
        batch_id = uuid4()
        
        # Act
        merkle_root = MerkleRoot(
            root_id=uuid4(),
            batch_id=batch_id,
            merkle_root="abc123def456",
            signature="signature-data",
            event_count=100,
            first_event_id=1,
            last_event_id=100,
            source="live"
        )
        
        # Assert
        assert merkle_root.batch_id == batch_id
        assert merkle_root.merkle_root == "abc123def456"
        assert merkle_root.event_count == 100
        assert merkle_root.first_event_id == 1
        assert merkle_root.last_event_id == 100
        assert merkle_root.source == "live"
    
    def test_merkle_root_repr(self):
        """Test MerkleRoot string representation."""
        # Arrange
        root_id = uuid4()
        batch_id = uuid4()
        merkle_root = MerkleRoot(
            root_id=root_id,
            batch_id=batch_id,
            merkle_root="abc123",
            signature="sig",
            event_count=50,
            first_event_id=1,
            last_event_id=50,
            source="live"
        )
        
        # Act
        repr_str = repr(merkle_root)
        
        # Assert
        assert "MerkleRoot" in repr_str
        assert str(root_id) in repr_str
        assert str(batch_id) in repr_str
        assert "1-50" in repr_str
        assert "live" in repr_str


@pytest.mark.unit
class TestAuthorityPolicyModel:
    """Test suite for AuthorityPolicy model."""
    
    def test_authority_policy_creation(self):
        """Test AuthorityPolicy model instantiation with valid data."""
        # Arrange
        principal_id = uuid4()
        
        # Act
        policy = AuthorityPolicy(
            policy_id=uuid4(),
            principal_id=principal_id,
            max_validity_seconds=3600,
            allowed_resource_patterns=["secrets/*", "config/*"],
            allowed_actions=["read", "write"],
            allow_delegation=True,
            max_network_distance=2,
            created_by="admin",
            active=True
        )
        
        # Assert
        assert policy.principal_id == principal_id
        assert policy.max_validity_seconds == 3600
        assert policy.allowed_resource_patterns == ["secrets/*", "config/*"]
        assert policy.allowed_actions == ["read", "write"]
        assert policy.allow_delegation is True
        assert policy.max_network_distance == 2
        assert policy.active is True


@pytest.mark.unit
class TestGatewayProviderModel:
    """Test suite for GatewayProvider model."""
    
    def test_gateway_provider_creation(self):
        """Test GatewayProvider model instantiation with valid data."""
        # Act
        provider = GatewayProvider(
            provider_id="test-provider",
            name="Test Provider",
            base_url="https://api.example.com",
            service_type="application",
            auth_scheme="api_key",
            enabled=True
        )
        
        # Assert
        assert provider.provider_id == "test-provider"
        assert provider.name == "Test Provider"
        assert provider.base_url == "https://api.example.com"
        assert provider.service_type == "application"
        assert provider.enabled is True
    
    def test_gateway_provider_repr(self):
        """Test GatewayProvider string representation."""
        # Arrange
        provider = GatewayProvider(
            provider_id="test-provider",
            name="Test Provider",
            base_url="https://api.example.com",
            enabled=True
        )
        
        # Act
        repr_str = repr(provider)
        
        # Assert
        assert "GatewayProvider" in repr_str
        assert "test-provider" in repr_str
        assert "https://api.example.com" in repr_str


@pytest.mark.unit
class TestEnterpriseRuntimeConfigModel:
    """Test suite for enterprise runtime config persistence model."""

    def test_enterprise_runtime_config_creation(self):
        """Test EnterpriseRuntimeConfig model instantiation with valid data."""
        runtime_config = EnterpriseRuntimeConfig(
            runtime_key="__enterprise_runtime__",
            config_data={
                "license_key": "ent-123",
                "valid": True,
                "enterprise_api_url": "https://enterprise.example.com",
            },
        )

        assert runtime_config.runtime_key == "__enterprise_runtime__"
        assert runtime_config.config_data["license_key"] == "ent-123"
        assert runtime_config.config_data["valid"] is True
