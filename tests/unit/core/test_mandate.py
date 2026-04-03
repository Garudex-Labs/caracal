"""
Unit tests for Mandate core logic.

This module tests the MandateManager class and its lifecycle methods.
"""
import pytest
from datetime import datetime, timedelta
from uuid import uuid4
from unittest.mock import Mock, MagicMock, patch

from caracal.core.mandate import MandateManager
from caracal.core.principal_keys import PrincipalKeyStorageError
from caracal.db.models import ExecutionMandate, AuthorityPolicy, Principal


@pytest.mark.unit
class TestMandateManager:
    """Test suite for MandateManager class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_db_session = Mock()
        self.manager = MandateManager(self.mock_db_session)
    
    def test_issue_mandate_with_valid_data(self):
        """Test mandate creation with valid data."""
        # Arrange
        issuer_id = uuid4()
        subject_id = uuid4()
        
        # Mock issuer principal with keys
        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
        )
        
        # Mock policy
        policy = AuthorityPolicy(
            policy_id=uuid4(),
            principal_id=issuer_id,
            active=True,
            max_validity_seconds=86400,
            allowed_resource_patterns=["secret/*"],
            allowed_actions=["read:secrets"],
            allow_delegation=True,
            max_network_distance=3
        )
        
        # Mock database queries
        def mock_query_side_effect(model):
            mock_query = Mock()
            if model == AuthorityPolicy:
                mock_query.filter.return_value.first.return_value = policy
            elif model == Principal:
                mock_query.filter.return_value.first.return_value = issuer
            return mock_query
        
        self.mock_db_session.query.side_effect = mock_query_side_effect
        
        # Mock metadata-backed key resolution and signature function
        with patch('caracal.core.identity.PrincipalRegistry.resolve_private_key', return_value="test_private_key"):
            with patch('caracal.core.mandate.sign_mandate', return_value="test_signature"):
            # Act
                mandate = self.manager.issue_mandate(
                    issuer_id=issuer_id,
                    subject_id=subject_id,
                    resource_scope=["secret/test"],
                    action_scope=["read:secrets"],
                    validity_seconds=3600
                )
        
        # Assert
        assert mandate is not None
        assert mandate.issuer_id == issuer_id
        assert mandate.subject_id == subject_id
        assert mandate.resource_scope == ["secret/test"]
        assert mandate.action_scope == ["read:secrets"]
        assert mandate.revoked is False
        assert mandate.signature == "test_signature"
    
    def test_issue_mandate_without_active_policy(self):
        """Test mandate issuance fails without active policy."""
        # Arrange
        issuer_id = uuid4()
        subject_id = uuid4()
        
        # Mock no active policy
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = None
        self.mock_db_session.query.return_value = mock_query
        
        # Act & Assert
        with pytest.raises(ValueError, match="does not have an active authority policy"):
            self.manager.issue_mandate(
                issuer_id=issuer_id,
                subject_id=subject_id,
                resource_scope=["secret/test"],
                action_scope=["read:secrets"],
                validity_seconds=3600
            )
    
    def test_issue_mandate_exceeds_validity_limit(self):
        """Test mandate issuance fails when validity exceeds policy limit."""
        # Arrange
        issuer_id = uuid4()
        subject_id = uuid4()
        
        # Mock policy with low max validity
        policy = AuthorityPolicy(
            policy_id=uuid4(),
            principal_id=issuer_id,
            active=True,
            max_validity_seconds=3600,  # 1 hour max
            allowed_resource_patterns=["secret/*"],
            allowed_actions=["read:secrets"],
            allow_delegation=True,
            max_network_distance=3
        )
        
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = policy
        self.mock_db_session.query.return_value = mock_query
        
        # Act & Assert
        with pytest.raises(ValueError, match="exceeds policy maximum"):
            self.manager.issue_mandate(
                issuer_id=issuer_id,
                subject_id=subject_id,
                resource_scope=["secret/test"],
                action_scope=["read:secrets"],
                validity_seconds=7200  # 2 hours - exceeds limit
            )

    def test_issue_mandate_without_resolvable_private_key(self):
        """Test mandate issuance fails when issuer key metadata is missing/invalid."""
        issuer_id = uuid4()
        subject_id = uuid4()

        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
        )

        policy = AuthorityPolicy(
            policy_id=uuid4(),
            principal_id=issuer_id,
            active=True,
            max_validity_seconds=86400,
            allowed_resource_patterns=["secret/*"],
            allowed_actions=["read:secrets"],
            allow_delegation=True,
            max_network_distance=3,
        )

        def mock_query_side_effect(model):
            mock_query = Mock()
            if model == AuthorityPolicy:
                mock_query.filter.return_value.first.return_value = policy
            elif model == Principal:
                mock_query.filter.return_value.first.return_value = issuer
            return mock_query

        self.mock_db_session.query.side_effect = mock_query_side_effect

        with patch(
            'caracal.core.identity.PrincipalRegistry.resolve_private_key',
            side_effect=PrincipalKeyStorageError("missing private key metadata"),
        ):
            with pytest.raises(RuntimeError, match="no resolvable private key metadata"):
                self.manager.issue_mandate(
                    issuer_id=issuer_id,
                    subject_id=subject_id,
                    resource_scope=["secret/test"],
                    action_scope=["read:secrets"],
                    validity_seconds=3600,
                )

    def test_delegate_mandate_propagates_source_lineage(self):
        """Delegated mandate creation must preserve source_mandate_id lineage."""
        source_mandate_id = uuid4()
        source_subject_id = uuid4()
        target_subject_id = uuid4()

        source_mandate = Mock(
            mandate_id=source_mandate_id,
            subject_id=source_subject_id,
            revoked=False,
            valid_from=datetime.utcnow() - timedelta(minutes=5),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            network_distance=2,
        )

        source_principal = Mock(principal_kind="human")
        target_principal = Mock(principal_kind="worker")

        delegated_mandate = Mock(
            mandate_id=uuid4(),
            valid_until=datetime.utcnow() + timedelta(minutes=30),
        )

        principal_query_count = {"count": 0}

        def mock_query_side_effect(model):
            mock_query = Mock()
            if model == ExecutionMandate:
                mock_query.filter.return_value.first.return_value = source_mandate
            elif model == Principal:
                principal_query_count["count"] += 1
                if principal_query_count["count"] == 1:
                    mock_query.filter.return_value.first.return_value = source_principal
                else:
                    mock_query.filter.return_value.first.return_value = target_principal
            return mock_query

        self.mock_db_session.query.side_effect = mock_query_side_effect
        self.manager.delegation_graph = Mock()

        with patch.object(self.manager, "issue_mandate", return_value=delegated_mandate) as mock_issue:
            result = self.manager.delegate_mandate(
                source_mandate_id=source_mandate_id,
                target_subject_id=target_subject_id,
                resource_scope=["secret/test"],
                action_scope=["read:secrets"],
                validity_seconds=1800,
            )

        assert result is delegated_mandate
        assert mock_issue.call_args.kwargs["source_mandate_id"] == source_mandate_id
        assert mock_issue.call_args.kwargs["issuer_id"] == source_subject_id
        self.manager.delegation_graph.add_edge.assert_called_once()
        assert self.manager.delegation_graph.add_edge.call_args.kwargs["source_mandate_id"] == source_mandate_id
        assert self.manager.delegation_graph.add_edge.call_args.kwargs["target_mandate_id"] == delegated_mandate.mandate_id
    
    def test_revoke_mandate_success(self):
        """Test successful mandate revocation."""
        # Arrange
        mandate_id = uuid4()
        issuer_id = uuid4()
        subject_id = uuid4()
        
        # Mock mandate
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=issuer_id,
            subject_id=subject_id,
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = mandate
        self.mock_db_session.query.return_value = mock_query
        
        # Act
        self.manager.revoke_mandate(
            mandate_id=mandate_id,
            revoker_id=issuer_id,
            reason="Test revocation"
        )
        
        # Assert
        assert mandate.revoked is True
        assert mandate.revocation_reason == "Test revocation"
        assert mandate.revoked_at is not None
    
    def test_revoke_mandate_not_found(self):
        """Test mandate revocation fails when mandate not found."""
        # Arrange
        mandate_id = uuid4()
        revoker_id = uuid4()
        
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = None
        self.mock_db_session.query.return_value = mock_query
        
        # Act & Assert
        with pytest.raises(ValueError, match="not found"):
            self.manager.revoke_mandate(
                mandate_id=mandate_id,
                revoker_id=revoker_id,
                reason="Test"
            )
    
    def test_revoke_mandate_already_revoked(self):
        """Test mandate revocation fails when already revoked."""
        # Arrange
        mandate_id = uuid4()
        issuer_id = uuid4()
        
        # Mock already revoked mandate
        mandate = ExecutionMandate(
            mandate_id=mandate_id,
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=True
        )
        
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = mandate
        self.mock_db_session.query.return_value = mock_query
        
        # Act & Assert
        with pytest.raises(ValueError, match="already revoked"):
            self.manager.revoke_mandate(
                mandate_id=mandate_id,
                revoker_id=issuer_id,
                reason="Test"
            )
    
    def test_validate_scope_subset_valid(self):
        """Test scope subset validation with valid subset."""
        # Arrange
        target_scope = ["secret/test"]
        source_scope = ["secret/*"]
        
        # Act
        result = self.manager._validate_scope_subset(target_scope, source_scope)
        
        # Assert
        assert result is True
    
    def test_validate_scope_subset_invalid(self):
        """Test scope subset validation with invalid subset."""
        # Arrange
        target_scope = ["other/resource"]
        source_scope = ["secret/*"]
        
        # Act
        result = self.manager._validate_scope_subset(target_scope, source_scope)
        
        # Assert
        assert result is False
    
    def test_match_pattern_exact(self):
        """Test pattern matching with exact match."""
        # Act & Assert
        assert self.manager._match_pattern("secret/test", "secret/test") is True
        assert self.manager._match_pattern("secret/test", "secret/other") is False
    
    def test_match_pattern_wildcard(self):
        """Test pattern matching with wildcard."""
        # Act & Assert
        assert self.manager._match_pattern("secret/test", "secret/*") is True
        assert self.manager._match_pattern("secret/test", "*/test") is True
        assert self.manager._match_pattern("secret/test", "*") is True
        assert self.manager._match_pattern("other/test", "secret/*") is False


@pytest.mark.unit
class TestMandateValidation:
    """Test suite for mandate validation logic."""
    
    def test_mandate_expiration_logic_expired(self):
        """Test mandate expiration check for expired mandate."""
        # Arrange
        expired_time = datetime.utcnow() - timedelta(hours=1)
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=expired_time - timedelta(hours=2),
            valid_until=expired_time,
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Act
        current_time = datetime.utcnow()
        is_expired = current_time > mandate.valid_until
        
        # Assert
        assert is_expired is True
    
    def test_mandate_expiration_logic_not_expired(self):
        """Test mandate expiration check for valid mandate."""
        # Arrange
        future_time = datetime.utcnow() + timedelta(hours=1)
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=future_time,
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Act
        current_time = datetime.utcnow()
        is_expired = current_time > mandate.valid_until
        
        # Assert
        assert is_expired is False
    
    def test_mandate_revocation_status(self):
        """Test mandate revocation status check."""
        # Arrange
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=True,
            revocation_reason="Test revocation"
        )
        
        # Assert
        assert mandate.revoked is True
        assert mandate.revocation_reason == "Test revocation"
