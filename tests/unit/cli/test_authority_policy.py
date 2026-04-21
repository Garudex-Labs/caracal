"""Unit tests for authority policy CLI commands."""

from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest
from click.testing import CliRunner

from caracal.cli.authority_policy import create as create_policy


@pytest.mark.unit
class TestAuthorityPolicyCreateCommand:
    """Test suite for authority policy create command."""

    def setup_method(self):
        self.runner = CliRunner()
        self.principal_id = str(uuid4())

    @patch("caracal.cli.authority_policy.get_workspace_from_ctx")
    @patch("caracal.cli.authority_policy.validate_provider_scopes")
    @patch("caracal.db.connection.get_db_manager")
    def test_create_policy_requires_existing_principal(
        self,
        mock_get_db_manager,
        mock_validate_provider_scopes,
        mock_get_workspace,
    ):
        """Policy creation should fail when principal does not exist."""
        mock_get_workspace.return_value = "test-workspace"
        mock_validate_provider_scopes.return_value = None

        mock_db_manager = Mock()
        mock_session = Mock()
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = None
        mock_session.query.return_value = mock_query
        mock_db_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_db_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        mock_get_db_manager.return_value = mock_db_manager

        result = self.runner.invoke(
            create_policy,
            [
                "--principal-id",
                self.principal_id,
                "--max-validity-seconds",
                "3600",
                "--resource-pattern",
                "provider:test:resource:api",
                "--action",
                "provider:test:action:invoke",
            ],
            obj=SimpleNamespace(config=Mock()),
        )

        assert result.exit_code == 1
        assert "Principal not found" in result.output

    @patch("caracal.cli.authority_policy.get_workspace_from_ctx")
    @patch("caracal.cli.authority_policy.validate_provider_scopes")
    @patch("caracal.db.connection.get_db_manager")
    def test_create_policy_success_commits_session(
        self,
        mock_get_db_manager,
        mock_validate_provider_scopes,
        mock_get_workspace,
    ):
        """Policy creation should commit after adding policy with existing principal."""
        mock_get_workspace.return_value = "test-workspace"
        mock_validate_provider_scopes.return_value = None

        mock_db_manager = Mock()
        mock_session = Mock()

        principal = Mock()
        principal.principal_id = uuid4()
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = principal
        mock_session.query.return_value = mock_query

        mock_db_manager.session_scope.return_value.__enter__ = Mock(return_value=mock_session)
        mock_db_manager.session_scope.return_value.__exit__ = Mock(return_value=False)
        mock_get_db_manager.return_value = mock_db_manager

        result = self.runner.invoke(
            create_policy,
            [
                "--principal-id",
                self.principal_id,
                "--max-validity-seconds",
                "3600",
                "--resource-pattern",
                "provider:test:resource:api",
                "--action",
                "provider:test:action:invoke",
            ],
            obj=SimpleNamespace(config=Mock()),
        )

        assert result.exit_code == 0
        assert "Authority policy created successfully" in result.output
        assert mock_session.add.called
        assert mock_session.flush.called
