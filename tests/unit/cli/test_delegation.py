"""
Unit tests for CLI delegation commands.

This module tests delegation CLI commands including generate, list, validate, and revoke.
"""
import pytest
from click.testing import CliRunner
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime
from uuid import uuid4

from caracal.cli.delegation import generate, list_delegations, validate, revoke


@pytest.mark.unit
class TestDelegationGenerateCommand:
    """Test suite for delegation generate command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.source_id = str(uuid4())
        self.target_id = str(uuid4())
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_generate_token_success(self, mock_get_manager):
        """Test generating a delegation token successfully."""
        # Arrange
        mock_registry = Mock()
        # assert_exists should not raise an exception for success case
        mock_registry.assert_exists = Mock(return_value=None)
        mock_registry.ensure_signing_keys = Mock(return_value=None)
        
        mock_manager = Mock()
        mock_manager.generate_token.return_value = 'test-token-jwt'
        
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(generate, [
            '--source-id', self.source_id,
            '--target-id', self.target_id,
            '--authority-scope', '100.0'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Delegation token generated successfully' in result.output
        assert 'test-token-jwt' in result.output
        mock_manager.generate_token.assert_called_once()
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_generate_token_with_operations(self, mock_get_manager):
        """Test generating token with specific operations."""
        # Arrange
        mock_registry = Mock()
        mock_registry.assert_exists = Mock(return_value=None)
        mock_registry.ensure_signing_keys = Mock(return_value=None)
        
        mock_manager = Mock()
        mock_manager.generate_token.return_value = 'test-token-jwt'
        
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(generate, [
            '--source-id', self.source_id,
            '--target-id', self.target_id,
            '--authority-scope', '50.0',
            '--operations', 'api_call',
            '--operations', 'mcp_tool'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Delegation token generated successfully' in result.output
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_generate_token_with_context_tags(self, mock_get_manager):
        """Test generating token with context tags."""
        # Arrange
        mock_registry = Mock()
        mock_registry.assert_exists = Mock(return_value=None)
        mock_registry.ensure_signing_keys = Mock(return_value=None)
        
        mock_manager = Mock()
        mock_manager.generate_token.return_value = 'test-token-jwt'
        
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(generate, [
            '--source-id', self.source_id,
            '--target-id', self.target_id,
            '--authority-scope', '75.0',
            '--context-tags', 'production',
            '--context-tags', 'read-only'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Delegation token generated successfully' in result.output
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_generate_token_principal_not_found(self, mock_get_manager):
        """Test generating token when principal not found."""
        # Arrange
        from caracal.exceptions import PrincipalNotFoundError
        
        mock_registry = Mock()
        mock_registry.assert_exists.side_effect = PrincipalNotFoundError('Principal not found')
        
        mock_manager = Mock()
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(generate, [
            '--source-id', self.source_id,
            '--target-id', self.target_id,
            '--authority-scope', '100.0'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code != 0
        assert 'Error' in result.output


@pytest.mark.unit
class TestDelegationListCommand:
    """Test suite for delegation list command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.delegation.get_db_manager')
    def test_list_delegations_empty(self, mock_get_db_manager):
        """Test listing delegations when none exist."""
        # Arrange
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.filter.return_value.all.return_value = []
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(list_delegations, [], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'No delegation edges found' in result.output
    
    @patch('caracal.cli.delegation.get_db_manager')
    def test_list_delegations_with_results(self, mock_get_db_manager):
        """Test listing delegations with results."""
        # Arrange
        mock_edge = Mock()
        mock_edge.edge_id = uuid4()
        mock_edge.source_mandate_id = uuid4()
        mock_edge.target_mandate_id = uuid4()
        mock_edge.source_principal_type = 'user'
        mock_edge.target_principal_type = 'agent'
        mock_edge.delegation_type = 'directed'
        mock_edge.context_tags = ['production']
        mock_edge.granted_at = datetime.utcnow()
        mock_edge.expires_at = None
        
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.filter.return_value.all.return_value = [mock_edge]
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(list_delegations, [], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Total delegation edges: 1' in result.output
    
    @patch('caracal.cli.delegation.get_db_manager')
    def test_list_delegations_json_format(self, mock_get_db_manager):
        """Test listing delegations with JSON output."""
        # Arrange
        mock_edge = Mock()
        mock_edge.edge_id = uuid4()
        mock_edge.source_mandate_id = uuid4()
        mock_edge.target_mandate_id = uuid4()
        mock_edge.source_principal_type = 'user'
        mock_edge.target_principal_type = 'agent'
        mock_edge.delegation_type = 'directed'
        mock_edge.context_tags = ['production']
        mock_edge.granted_at = datetime.utcnow()
        mock_edge.expires_at = None
        
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.filter.return_value.all.return_value = [mock_edge]
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(list_delegations, ['--format', 'json'], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'edge_id' in result.output


@pytest.mark.unit
class TestDelegationValidateCommand:
    """Test suite for delegation validate command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_validate_token_success(self, mock_get_manager):
        """Test validating a valid delegation token."""
        # Arrange
        mock_claims = Mock()
        mock_claims.issuer = str(uuid4())
        mock_claims.subject = str(uuid4())
        mock_claims.audience = 'caracal'
        mock_claims.token_id = str(uuid4())
        mock_claims.issued_at = datetime.utcnow()
        mock_claims.expiration = datetime.utcnow()
        mock_claims.allowed_operations = ['api_call', 'mcp_tool']
        mock_claims.max_delegation_depth = 3
        
        mock_registry = Mock()
        mock_manager = Mock()
        mock_manager.validate_token.return_value = mock_claims
        
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(validate, [
            '--token', 'test-jwt-token'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Token is valid' in result.output
        assert 'Token Claims' in result.output
    
    @patch('caracal.cli.delegation._get_delegation_manager')
    def test_validate_token_invalid(self, mock_get_manager):
        """Test validating an invalid delegation token."""
        # Arrange
        from caracal.exceptions import CaracalError
        
        mock_registry = Mock()
        mock_manager = Mock()
        mock_manager.validate_token.side_effect = CaracalError('Invalid token')
        
        mock_get_manager.return_value = (mock_registry, mock_manager)
        
        # Act
        result = self.runner.invoke(validate, [
            '--token', 'invalid-token'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code != 0
        assert 'Error' in result.output


@pytest.mark.unit
class TestDelegationRevokeCommand:
    """Test suite for delegation revoke command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.policy_id = str(uuid4())
    
    @patch('caracal.cli.delegation.get_db_manager')
    def test_revoke_delegation_success(self, mock_get_db_manager):
        """Test revoking a delegation policy successfully."""
        # Arrange
        mock_policy = Mock()
        mock_policy.policy_id = self.policy_id
        mock_policy.principal_id = uuid4()
        mock_policy.active = True
        mock_policy.allow_delegation = True
        
        mock_principal = Mock()
        mock_principal.name = 'test-principal'
        
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_session.query.side_effect = lambda model: Mock(
            filter_by=Mock(return_value=Mock(
                first=Mock(return_value=mock_policy if model.__name__ == 'AuthorityPolicy' else mock_principal)
            ))
        )
        # Fix context manager support
        mock_context = MagicMock()
        mock_context.__enter__ = Mock(return_value=mock_session)
        mock_context.__exit__ = Mock(return_value=False)
        mock_db_manager.session_scope.return_value = mock_context
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(revoke, [
            '--policy-id', self.policy_id,
            '--confirm'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'revoked successfully' in result.output
    
    @patch('caracal.cli.delegation.get_db_manager')
    def test_revoke_delegation_not_found(self, mock_get_db_manager):
        """Test revoking a delegation policy that doesn't exist."""
        # Arrange
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_session.query.return_value.filter_by.return_value.first.return_value = None
        # Fix context manager support
        mock_context = MagicMock()
        mock_context.__enter__ = Mock(return_value=mock_session)
        mock_context.__exit__ = Mock(return_value=False)
        mock_db_manager.session_scope.return_value = mock_context
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(revoke, [
            '--policy-id', self.policy_id,
            '--confirm'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code != 0
        assert 'not found' in result.output
    
    def test_revoke_delegation_invalid_uuid(self):
        """Test revoking delegation with invalid UUID."""
        result = self.runner.invoke(revoke, [
            '--policy-id', 'invalid-uuid',
            '--confirm'
        ], obj={'config': Mock()})
        
        assert result.exit_code != 0
        assert 'Invalid' in result.output


@pytest.mark.unit
class TestDelegationCommandArguments:
    """Test suite for delegation command argument parsing."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    def test_generate_missing_required_args(self):
        """Test generate command with missing required arguments."""
        result = self.runner.invoke(generate, [], obj={'config': Mock()})
        
        assert result.exit_code != 0
    
    def test_validate_missing_token(self):
        """Test validate command with missing token."""
        result = self.runner.invoke(validate, [], obj={'config': Mock()})
        
        assert result.exit_code != 0
    
    def test_revoke_missing_policy_id(self):
        """Test revoke command with missing policy ID."""
        result = self.runner.invoke(revoke, [], obj={'config': Mock()})
        
        assert result.exit_code != 0
