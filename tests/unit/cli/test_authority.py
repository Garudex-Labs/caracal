"""
Unit tests for CLI authority commands.

This module tests authority CLI commands including issue, validate, revoke, list, and delegate.
"""
import pytest
from click.testing import CliRunner
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timedelta
from uuid import uuid4

from caracal.cli.authority import (
    issue,
    validate,
    revoke,
    list_mandates,
    delegate,
    graph,
    attach_source,
    peer_delegate_cmd,
)


@pytest.mark.unit
class TestAuthorityIssueCommand:
    """Test suite for authority issue command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.issuer_id = str(uuid4())
        self.subject_id = str(uuid4())
    
    @patch('caracal.cli.authority.get_mandate_manager')
    @patch('caracal.cli.authority.resolve_issue_scopes_from_tool_ids')
    @patch('caracal.cli.authority.validate_provider_scopes')
    @patch('caracal.cli.authority.get_workspace_from_ctx')
    def test_issue_mandate_success(self, mock_workspace, mock_validate, mock_resolve_scopes, mock_get_manager):
        """Test issuing a mandate successfully."""
        # Arrange
        mock_workspace.return_value = 'test-workspace'
        mock_validate.return_value = None
        mock_resolve_scopes.return_value = {
            'tool_ids': ['provider:test:resource:api'],
            'providers': ['test'],
            'resource_scope': ['provider:test:resource:api'],
            'action_scope': ['provider:test:action:invoke'],
        }
        
        mock_mandate = Mock()
        mock_mandate.mandate_id = uuid4()
        mock_mandate.issuer_id = self.issuer_id
        mock_mandate.subject_id = self.subject_id
        mock_mandate.valid_from = datetime.utcnow()
        mock_mandate.valid_until = datetime.utcnow() + timedelta(hours=1)
        mock_mandate.resource_scope = ['provider:test:resource:api']
        mock_mandate.action_scope = ['provider:test:action:invoke']
        mock_mandate.signature = 'test-signature'
        mock_mandate.created_at = datetime.utcnow()
        mock_mandate.revoked = False
        mock_mandate.delegation_type = 'direct'
        mock_mandate.network_distance = 0
        
        mock_manager = Mock()
        mock_manager.issue_mandate.return_value = mock_mandate
        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)
        
        # Act
        result = self.runner.invoke(issue, [
            '--issuer-id', self.issuer_id,
            '--subject-id', self.subject_id,
            '--tool-id', 'provider:test:resource:api',
            '--validity-seconds', '3600'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Mandate issued successfully' in result.output
        mock_manager.issue_mandate.assert_called_once()
        mock_manager.db_session.commit.assert_called_once()
    
    def test_issue_mandate_invalid_uuid(self):
        """Test issuing mandate with invalid UUID."""
        result = self.runner.invoke(issue, [
            '--issuer-id', 'invalid-uuid',
            '--subject-id', self.subject_id,
            '--tool-id', 'provider:test:resource:api',
            '--validity-seconds', '3600'
        ], obj={'config': Mock()})
        
        assert result.exit_code != 0
        assert 'Invalid UUID' in result.output
    
    def test_issue_mandate_negative_validity(self):
        """Test issuing mandate with negative validity."""
        result = self.runner.invoke(issue, [
            '--issuer-id', self.issuer_id,
            '--subject-id', self.subject_id,
            '--tool-id', 'provider:test:resource:api',
            '--validity-seconds', '-100'
        ], obj={'config': Mock()})
        
        assert result.exit_code != 0
        assert 'positive' in result.output.lower()
    
    @patch('caracal.cli.authority.get_mandate_manager')
    @patch('caracal.cli.authority.resolve_issue_scopes_from_tool_ids')
    @patch('caracal.cli.authority.validate_provider_scopes')
    @patch('caracal.cli.authority.get_workspace_from_ctx')
    def test_issue_mandate_json_output(self, mock_workspace, mock_validate, mock_resolve_scopes, mock_get_manager):
        """Test issuing mandate with JSON output format."""
        # Arrange
        mock_workspace.return_value = 'test-workspace'
        mock_validate.return_value = None
        mock_resolve_scopes.return_value = {
            'tool_ids': ['provider:test:resource:api'],
            'providers': ['test'],
            'resource_scope': ['provider:test:resource:api'],
            'action_scope': ['provider:test:action:invoke'],
        }
        
        mock_mandate = Mock()
        mock_mandate.mandate_id = uuid4()
        mock_mandate.issuer_id = self.issuer_id
        mock_mandate.subject_id = self.subject_id
        mock_mandate.valid_from = datetime.utcnow()
        mock_mandate.valid_until = datetime.utcnow() + timedelta(hours=1)
        mock_mandate.resource_scope = ['provider:test:resource:api']
        mock_mandate.action_scope = ['provider:test:action:invoke']
        mock_mandate.signature = 'test-signature'
        mock_mandate.created_at = datetime.utcnow()
        mock_mandate.revoked = False
        mock_mandate.delegation_type = 'direct'
        mock_mandate.network_distance = 0
        
        mock_manager = Mock()
        mock_manager.issue_mandate.return_value = mock_mandate
        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)
        
        # Act
        result = self.runner.invoke(issue, [
            '--issuer-id', self.issuer_id,
            '--subject-id', self.subject_id,
            '--tool-id', 'provider:test:resource:api',
            '--validity-seconds', '3600',
            '--format', 'json'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'mandate_id' in result.output


@pytest.mark.unit
class TestAuthorityValidateCommand:
    """Test suite for authority validate command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.mandate_id = str(uuid4())
    
    @patch('caracal.cli.authority.get_authority_evaluator')
    @patch('caracal.cli.authority.validate_provider_scopes')
    @patch('caracal.cli.authority.get_workspace_from_ctx')
    def test_validate_mandate_allowed(self, mock_workspace, mock_validate, mock_get_evaluator):
        """Test validating a mandate that is allowed."""
        # Arrange
        mock_workspace.return_value = 'test-workspace'
        mock_validate.return_value = None
        
        mock_decision = Mock()
        mock_decision.allowed = True
        mock_decision.decision = 'ALLOW'
        mock_decision.reason = None
        
        mock_mandate = Mock()
        mock_mandate.mandate_id = self.mandate_id
        
        mock_evaluator = Mock()
        mock_evaluator.validate_mandate.return_value = mock_decision
        
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = mock_mandate
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        
        mock_get_evaluator.return_value = (mock_evaluator, mock_db_manager)
        
        # Act
        result = self.runner.invoke(validate, [
            '--mandate-id', self.mandate_id,
            '--action', 'provider:test:action:invoke',
            '--resource', 'provider:test:resource:api'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'ALLOWED' in result.output
        mock_evaluator.db_session.commit.assert_called_once()
    
    def test_validate_mandate_invalid_uuid(self):
        """Test validating mandate with invalid UUID."""
        result = self.runner.invoke(validate, [
            '--mandate-id', 'invalid-uuid',
            '--action', 'provider:test:action:invoke',
            '--resource', 'provider:test:resource:api'
        ], obj={'config': Mock()})
        
        assert result.exit_code != 0
        assert 'Invalid' in result.output


@pytest.mark.unit
class TestAuthorityRevokeCommand:
    """Test suite for authority revoke command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.mandate_id = str(uuid4())
        self.revoker_id = str(uuid4())
    
    @patch('caracal.cli.authority.get_mandate_manager')
    def test_revoke_mandate_success(self, mock_get_manager):
        """Test revoking a mandate successfully."""
        # Arrange
        mock_manager = Mock()
        mock_manager.revoke_mandate.return_value = None
        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)
        
        # Act
        result = self.runner.invoke(revoke, [
            '--mandate-id', self.mandate_id,
            '--revoker-id', self.revoker_id,
            '--reason', 'Test revocation'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'revoked successfully' in result.output
        mock_manager.revoke_mandate.assert_called_once()
        mock_manager.db_session.commit.assert_called_once()
    
    @patch('caracal.cli.authority.get_mandate_manager')
    def test_revoke_mandate_with_cascade(self, mock_get_manager):
        """Test revoking mandate with cascade option."""
        # Arrange
        mock_manager = Mock()
        mock_manager.revoke_mandate.return_value = None
        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)
        
        # Act
        result = self.runner.invoke(revoke, [
            '--mandate-id', self.mandate_id,
            '--revoker-id', self.revoker_id,
            '--reason', 'Test revocation',
            '--cascade'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'revoked successfully' in result.output
        call_args = mock_manager.revoke_mandate.call_args
        assert call_args[1]['cascade'] is True


@pytest.mark.unit
class TestAuthorityListCommand:
    """Test suite for authority list command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.db.connection.get_db_manager')
    def test_list_mandates_empty(self, mock_get_db_manager):
        """Test listing mandates when none exist."""
        # Arrange
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.all.return_value = []
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(list_mandates, [], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'No mandates found' in result.output
    
    @patch('caracal.db.connection.get_db_manager')
    def test_list_mandates_with_results(self, mock_get_db_manager):
        """Test listing mandates with results."""
        # Arrange
        mock_mandate = Mock()
        mock_mandate.mandate_id = uuid4()
        mock_mandate.issuer_id = uuid4()
        mock_mandate.subject_id = uuid4()
        mock_mandate.valid_from = datetime.utcnow()
        mock_mandate.valid_until = datetime.utcnow() + timedelta(hours=1)
        mock_mandate.resource_scope = ['provider:test:resource:api']
        mock_mandate.action_scope = ['provider:test:action:invoke']
        mock_mandate.revoked = False
        mock_mandate.delegation_type = 'direct'
        mock_mandate.network_distance = 0
        mock_mandate.created_at = datetime.utcnow()
        
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.all.return_value = [mock_mandate]
        mock_session.query.return_value = mock_query
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager
        
        # Act
        result = self.runner.invoke(list_mandates, [], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'Total mandates: 1' in result.output


@pytest.mark.unit
class TestAuthorityDelegateCommand:
    """Test suite for authority delegate command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
        self.source_mandate_id = str(uuid4())
        self.target_subject_id = str(uuid4())
    
    @patch('caracal.cli.authority.get_mandate_manager')
    @patch('caracal.cli.authority.validate_provider_scopes')
    @patch('caracal.cli.authority.get_workspace_from_ctx')
    def test_delegate_mandate_success(self, mock_workspace, mock_validate, mock_get_manager):
        """Test delegating a mandate successfully."""
        # Arrange
        mock_workspace.return_value = 'test-workspace'
        mock_validate.return_value = None
        
        mock_target_mandate = Mock()
        mock_target_mandate.mandate_id = uuid4()
        mock_target_mandate.issuer_id = self.source_mandate_id
        mock_target_mandate.subject_id = self.target_subject_id
        mock_target_mandate.valid_from = datetime.utcnow()
        mock_target_mandate.valid_until = datetime.utcnow() + timedelta(minutes=30)
        mock_target_mandate.resource_scope = ['provider:test:resource:api']
        mock_target_mandate.action_scope = ['provider:test:action:invoke']
        mock_target_mandate.delegation_type = 'delegated'
        mock_target_mandate.network_distance = 1
        mock_target_mandate.context_tags = ['test']
        mock_target_mandate.created_at = datetime.utcnow()
        
        mock_manager = Mock()
        mock_manager.delegate_mandate.return_value = mock_target_mandate
        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)
        
        # Act
        result = self.runner.invoke(delegate, [
            '--source-mandate-id', self.source_mandate_id,
            '--target-subject-id', self.target_subject_id,
            '--resource-scope', 'provider:test:resource:api',
            '--action-scope', 'provider:test:action:invoke',
            '--validity-seconds', '1800'
        ], obj={'config': Mock()})
        
        # Assert
        assert result.exit_code == 0
        assert 'delegated successfully' in result.output
        mock_manager.delegate_mandate.assert_called_once()
        mock_manager.db_session.commit.assert_called_once()


@pytest.mark.unit
class TestAuthorityGraphCommand:
    """Test suite for authority graph inspection command."""

    def setup_method(self):
        self.runner = CliRunner()

    @patch('caracal.core.delegation_graph.DelegationGraph')
    @patch('caracal.db.connection.get_db_manager')
    def test_graph_json_output_includes_explicit_details(self, mock_get_db_manager, mock_graph_cls):
        root_mandate_id = str(uuid4())

        mock_db_manager = Mock()
        mock_session = Mock()
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager

        mock_graph = Mock()
        mock_graph.get_topology.return_value = MagicMock(
            nodes=[{"mandate_id": root_mandate_id, "principal_kind": "human"}],
            edges=[{"edge_id": str(uuid4()), "source_principal_kind": "human", "target_principal_kind": "worker"}],
            stats={"total_nodes": 1, "total_edges": 1, "nodes_by_type": {"human": 1}},
        )
        mock_graph.get_path_details.return_value = {
            "root_mandate_id": root_mandate_id,
            "path": [{"mandate_id": root_mandate_id, "network_distance": 2, "target_count": 1, "active": True, "expired": False, "principal_kind": "human"}],
            "edges": [],
            "stats": {"branch_nodes": 0, "leaf_nodes": 1, "is_valid": True},
        }
        mock_graph_cls.return_value = mock_graph

        result = self.runner.invoke(
            graph,
            ['--root-mandate-id', root_mandate_id, '--format', 'json'],
            obj={'config': Mock()},
        )

        assert result.exit_code == 0
        assert '"graph_details"' in result.output
        assert '"total_nodes": 1' in result.output
        assert '"root_mandate_id"' in result.output

    @patch('caracal.core.delegation_graph.DelegationGraph')
    @patch('caracal.db.connection.get_db_manager')
    def test_graph_table_output_shows_stats(self, mock_get_db_manager, mock_graph_cls):
        mock_db_manager = Mock()
        mock_session = Mock()
        mock_db_manager.get_session.return_value = mock_session
        mock_get_db_manager.return_value = mock_db_manager

        mock_graph = Mock()
        mock_graph.get_topology.return_value = MagicMock(
            nodes=[{"mandate_id": str(uuid4()), "principal_kind": "human"}],
            edges=[],
            stats={"total_nodes": 1, "total_edges": 0, "nodes_by_type": {"human": 1}},
        )
        mock_graph_cls.return_value = mock_graph

        result = self.runner.invoke(graph, [], obj={'config': Mock()})

        assert result.exit_code == 0
        assert 'Delegation Graph (1 nodes, 0 edges)' in result.output
        assert 'Stats:' in result.output
        assert 'human: 1 nodes' in result.output


@pytest.mark.unit
class TestAuthorityAdvancedDelegationCommands:
    """Test suite for additional authority delegation command paths."""

    def setup_method(self):
        self.runner = CliRunner()
        self.source_mandate_id = str(uuid4())
        self.target_mandate_id = str(uuid4())
        self.target_subject_id = str(uuid4())

    @patch('caracal.cli.authority.get_mandate_manager')
    def test_attach_source_commits_manager_session(self, mock_get_manager):
        """Attach-source should commit via the same manager session."""
        mock_manager = Mock()
        mock_target = Mock()
        mock_target.mandate_id = uuid4()
        mock_target.resource_scope = ['provider:test:resource:api']
        mock_target.action_scope = ['provider:test:action:invoke']
        mock_target.valid_until = datetime.utcnow() + timedelta(hours=1)
        mock_target.context_tags = []
        mock_manager.attach_delegation_source.return_value = mock_target

        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)

        result = self.runner.invoke(
            attach_source,
            [
                '--source-mandate-id', self.source_mandate_id,
                '--target-mandate-id', self.target_mandate_id,
            ],
            obj={'config': Mock()},
        )

        assert result.exit_code == 0
        assert 'attached successfully' in result.output
        mock_manager.db_session.commit.assert_called_once()

    @patch('caracal.cli.authority.get_mandate_manager')
    @patch('caracal.cli.authority.validate_provider_scopes')
    @patch('caracal.cli.authority.get_workspace_from_ctx')
    def test_peer_delegate_commits_manager_session(
        self,
        mock_workspace,
        mock_validate_scopes,
        mock_get_manager,
    ):
        """Peer delegate should commit via the same manager session."""
        mock_workspace.return_value = 'test-workspace'
        mock_validate_scopes.return_value = None

        mock_manager = Mock()
        mock_peer_mandate = Mock()
        mock_peer_mandate.mandate_id = uuid4()
        mock_peer_mandate.subject_id = self.target_subject_id
        mock_peer_mandate.delegation_type = 'peer'
        mock_peer_mandate.context_tags = []
        mock_peer_mandate.created_at = datetime.utcnow()
        mock_manager.peer_delegate.return_value = mock_peer_mandate

        mock_db_manager = Mock()
        mock_get_manager.return_value = (mock_manager, mock_db_manager)

        result = self.runner.invoke(
            peer_delegate_cmd,
            [
                '--source-mandate-id', self.source_mandate_id,
                '--target-subject-id', self.target_subject_id,
                '--resource-scope', 'provider:test:resource:api',
                '--action-scope', 'provider:test:action:invoke',
                '--validity-seconds', '1800',
            ],
            obj={'config': Mock()},
        )

        assert result.exit_code == 0
        assert 'Peer delegation created successfully' in result.output
        mock_manager.db_session.commit.assert_called_once()
