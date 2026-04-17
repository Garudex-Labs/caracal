"""
Unit tests for Principal Identity management.

This module tests the PrincipalIdentity and PrincipalRegistry classes.
"""
from datetime import datetime
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest

from caracal.core.identity import (
    PrincipalIdentity,
    PrincipalRegistry,
    VerificationStatus,
)
from caracal.db.models import Principal
from caracal.exceptions import DuplicatePrincipalNameError


@pytest.mark.unit
class TestPrincipalIdentity:
    """Test suite for PrincipalIdentity dataclass."""
    
    def test_principal_creation_with_valid_data(self):
        """Test principal identity creation with valid data."""
        identity = PrincipalIdentity(
            principal_id="test-id-123",
            name="test-principal",
            owner="test-owner",
            created_at="2024-01-01T00:00:00Z",
            metadata={"key": "value"}
        )
        assert identity.principal_id == "test-id-123"
        assert identity.name == "test-principal"
        assert identity.owner == "test-owner"
        assert identity.created_at == "2024-01-01T00:00:00Z"
        assert identity.metadata == {"key": "value"}
        assert identity.principal_kind == "worker"
        assert identity.verification_status == VerificationStatus.UNVERIFIED
    
    def test_principal_to_dict(self):
        """Test principal identity serialization to dictionary."""
        identity = PrincipalIdentity(
            principal_id="test-id-123",
            name="test-principal",
            owner="test-owner",
            created_at="2024-01-01T00:00:00Z",
            metadata={"key": "value"},
            verification_status=VerificationStatus.VERIFIED
        )
        result = identity.to_dict()
        assert result["principal_id"] == "test-id-123"
        assert result["name"] == "test-principal"
        assert result["verification_status"] == "verified"
        assert result["metadata"] == {"key": "value"}
    
    def test_principal_from_dict(self):
        """Test principal identity deserialization from dictionary."""
        data = {
            "principal_id": "test-id-123",
            "name": "test-principal",
            "owner": "test-owner",
            "created_at": "2024-01-01T00:00:00Z",
            "metadata": {"key": "value"},
            "verification_status": "verified"
        }
        identity = PrincipalIdentity.from_dict(data)
        assert identity.principal_id == "test-id-123"
        assert identity.name == "test-principal"
        assert identity.verification_status == VerificationStatus.VERIFIED

@pytest.mark.unit
class TestPrincipalRegistry:
    """Test suite for PrincipalRegistry class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_session = Mock()
        self.registry = PrincipalRegistry(self.mock_session)
    
    def test_register_principal_with_valid_data(self):
        """Test principal registration with valid data."""
        mock_query = Mock()
        mock_query.filter_by.return_value.first.return_value = None
        self.mock_session.query.return_value = mock_query

        self.mock_session.add = Mock()
        self.mock_session.flush = Mock()
        self.mock_session.commit = Mock()

        with patch('caracal.core.identity.generate_and_store_principal_keypair') as mock_gen:
            mock_gen.return_value = Mock(
                public_key_pem="test_public_key",
                storage=Mock(metadata={})
            )
            identity = self.registry.register_principal(
                name="test-principal",
                owner="test-owner",
                generate_keys=False
            )
        assert identity.name == "test-principal"
        assert identity.owner == "test-owner"
        self.mock_session.add.assert_called_once()
        self.mock_session.commit.assert_called_once()
    
    def test_register_principal_duplicate_name(self):
        """Test principal registration with duplicate name raises error."""
        existing_principal = Principal(
            principal_id=uuid4(),
            name="existing-principal",
            principal_kind="worker",
            owner="test-owner",
            created_at=datetime.utcnow()
        )

        mock_query = Mock()
        mock_query.filter_by.return_value.first.return_value = existing_principal
        self.mock_session.query.return_value = mock_query
        with pytest.raises(DuplicatePrincipalNameError):
            self.registry.register_principal(
                name="existing-principal",
                owner="test-owner"
            )
    
    def test_get_principal_valid_id(self):
        """Test getting principal with valid ID."""
        principal_id = uuid4()
        mock_principal = Principal(
            principal_id=principal_id,
            name="test-principal",
            principal_kind="worker",
            owner="test-owner",
            created_at=datetime.utcnow(),
            principal_metadata={},
            public_key_pem="test_key"
        )
        
        mock_query = Mock()
        mock_query.filter_by.return_value.first.return_value = mock_principal
        self.mock_session.query.return_value = mock_query
        identity = self.registry.get_principal(str(principal_id))
        assert identity is not None
        assert identity.principal_id == str(principal_id)
        assert identity.name == "test-principal"
    
    def test_get_principal_not_found(self):
        """Test getting principal with non-existent ID returns None."""
        principal_id = uuid4()
        mock_query = Mock()
        mock_query.filter_by.return_value.first.return_value = None
        self.mock_session.query.return_value = mock_query
        identity = self.registry.get_principal(str(principal_id))
        assert identity is None
    
    def test_get_principal_invalid_id(self):
        """Test getting principal with invalid ID returns None."""
        identity = self.registry.get_principal("invalid-uuid")
        assert identity is None
    
    def test_list_principals(self):
        """Test listing all principals."""
        mock_principals = [
            Principal(
                principal_id=uuid4(),
                name=f"principal-{i}",
                principal_kind="worker",
                owner="test-owner",
                created_at=datetime.utcnow(),
                principal_metadata={}
            )
            for i in range(3)
        ]
        
        mock_query = Mock()
        mock_query.order_by.return_value.all.return_value = mock_principals
        self.mock_session.query.return_value = mock_query
        identities = self.registry.list_principals()
        assert len(identities) == 3
        assert all(isinstance(i, PrincipalIdentity) for i in identities)
    
    def test_update_agent_metadata(self):
        """Test updating principal metadata."""
        principal_id = uuid4()
        mock_principal = Principal(
            principal_id=principal_id,
            name="test-principal",
            principal_kind="worker",
            owner="test-owner",
            created_at=datetime.utcnow(),
            principal_metadata={"old_key": "old_value"}
        )
        
        mock_query = Mock()
        mock_query.filter_by.return_value.first.return_value = mock_principal
        self.mock_session.query.return_value = mock_query
        identity = self.registry.update_agent(
            str(principal_id),
            metadata={"new_key": "new_value"}
        )
        assert identity is not None
        self.mock_session.flush.assert_called()
        self.mock_session.commit.assert_called()

@pytest.mark.unit
class TestVerificationStatus:
    """Test suite for VerificationStatus enum."""
    
    def test_verification_status_values(self):
        """Test verification status enum values."""
        assert VerificationStatus.UNVERIFIED.value == "unverified"
        assert VerificationStatus.VERIFIED.value == "verified"
        assert VerificationStatus.TRUSTED.value == "trusted"
