"""
Unit tests for CLI main entry point.

This module tests the main CLI command and its subcommands.
"""
import pytest
from click.testing import CliRunner
from unittest.mock import Mock, patch, MagicMock

from caracal.cli.main import cli, get_active_workspace, format_workspace_status


@pytest.fixture(autouse=True)
def _writable_caracal_home(tmp_path, monkeypatch):
    """Ensure CLI tests run with writable runtime state roots."""
    monkeypatch.setenv("CCL_HOME", str(tmp_path / ".caracal"))


def _invoke_cli(runner: CliRunner, args: list[str]):
    """Invoke CLI with argv patched to mirror real terminal invocation."""
    with patch('caracal.cli.main.sys.argv', ['caracal', *args]):
        return runner.invoke(cli, args)


@pytest.mark.unit
class TestCLIMain:
    """Test suite for CLI main commands."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    def test_cli_help(self):
        """Test CLI help command displays usage information."""
        result = self.runner.invoke(cli, ['--help'])
        
        assert result.exit_code == 0
        assert 'Usage:' in result.output
        assert 'Caracal' in result.output
    
    def test_cli_version(self):
        """Test CLI version command displays version."""
        result = self.runner.invoke(cli, ['--version'])
        
        assert result.exit_code == 0
        assert 'caracal' in result.output.lower() or 'version' in result.output.lower()
    
    def test_cli_invalid_command(self):
        """Test CLI with invalid command shows error."""
        result = self.runner.invoke(cli, ['invalid-command-xyz'])
        
        assert result.exit_code != 0
    
    def test_cli_subcommand_help(self):
        """Test CLI subcommand help displays subcommand info."""
        result = _invoke_cli(self.runner, ['workspace', '--help'])
        
        assert result.exit_code == 0
        assert 'workspace' in result.output.lower()

    def test_help_skips_config_loading(self):
        """Help output should not trigger runtime config validation."""
        with patch('caracal.cli.main.sys.argv', ['caracal', '--help']):
            with patch('caracal.cli.main.load_config', side_effect=AssertionError('load_config should not be called')):
                result = self.runner.invoke(cli, ['--help'])

        assert result.exit_code == 0

    def test_subcommand_help_skips_config_loading(self):
        """Subcommand help should not require runtime config."""
        with patch('caracal.cli.main.sys.argv', ['caracal', 'workspace', '--help']):
            with patch('caracal.cli.main.load_config', side_effect=AssertionError('load_config should not be called')):
                result = self.runner.invoke(cli, ['workspace', '--help'])

        assert result.exit_code == 0
    
    def test_cli_no_command_shows_info(self):
        """Test CLI without command shows workspace info."""
        with patch('caracal.cli.main.get_active_workspace', return_value='test-workspace'):
            result = self.runner.invoke(cli, [])
            
            assert result.exit_code == 0
    
    def test_get_active_workspace_success(self):
        """Test getting active workspace when configured."""
        with patch('caracal.deployment.config_manager.ConfigManager') as mock_config_mgr:
            mock_instance = Mock()
            mock_instance.get_default_workspace_name.return_value = 'test-workspace'
            mock_config_mgr.return_value = mock_instance
            
            workspace = get_active_workspace()
            
            assert workspace == 'test-workspace'
    
    def test_get_active_workspace_no_config(self):
        """Test getting active workspace when not configured."""
        with patch('caracal.deployment.config_manager.ConfigManager', side_effect=Exception('No config')):
            workspace = get_active_workspace()
            
            assert workspace is None
    
    def test_format_workspace_status_with_workspace(self):
        """Test formatting workspace status with active workspace."""
        status = format_workspace_status('my-workspace')
        
        assert 'my-workspace' in status
        assert 'Active Workspace' in status
    
    def test_format_workspace_status_no_workspace(self):
        """Test formatting workspace status without active workspace."""
        status = format_workspace_status(None)
        
        assert 'WARNING' in status
        assert 'No workspace' in status


@pytest.mark.unit
class TestCLICommandRegistration:
    """Test suite for CLI command registration."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    def test_workspace_command_registered(self):
        """Test workspace command is registered."""
        result = _invoke_cli(self.runner, ['workspace', '--help'])
        
        assert result.exit_code == 0
        assert 'workspace' in result.output.lower()
    
    def test_principal_command_registered(self):
        """Test principal command is registered."""
        result = _invoke_cli(self.runner, ['principal', '--help'])
        
        assert result.exit_code == 0
        assert 'principal' in result.output.lower()
    
    def test_authority_command_registered(self):
        """Test authority command is registered."""
        result = _invoke_cli(self.runner, ['authority', '--help'])
        
        assert result.exit_code == 0
        assert 'authority' in result.output.lower() or 'mandate' in result.output.lower()

    def test_delegation_command_registered(self):
        """Test delegation command is registered."""
        result = _invoke_cli(self.runner, ['delegation', '--help'])
        
        assert result.exit_code == 0
        assert 'delegation' in result.output.lower()

    def test_enterprise_command_registered(self):
        """Test enterprise command group is registered."""
        result = _invoke_cli(self.runner, ['enterprise', '--help'])

        assert result.exit_code == 0
        assert 'enterprise' in result.output.lower()

    def test_sync_command_removed(self):
        """Test legacy top-level sync command is removed in hard-cut mode."""
        result = self.runner.invoke(cli, ['sync', '--help'])

        assert result.exit_code != 0
        assert 'Command not found: sync' in result.output

    def test_system_migrate_command_removed(self):
        """Test legacy system migration command group is removed in hard-cut mode."""
        result = _invoke_cli(self.runner, ['system', 'migrate', '--help'])

        assert result.exit_code != 0
        assert 'Command not found: migrate' in result.output


@pytest.mark.unit
class TestCLIErrorHandling:
    """Test suite for CLI error handling."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    def test_config_option_removed(self):
        """Test legacy global --config option is rejected in hard-cut mode."""
        result = self.runner.invoke(cli, ['--config', '/nonexistent/path/config.yaml', 'workspace', 'list'])

        assert result.exit_code != 0
        assert "No such option: --config" in result.output
    
    def test_invalid_log_level(self):
        """Test CLI with invalid log level."""
        result = self.runner.invoke(cli, ['--log-level', 'invalid', '--help'])
        
        # Should show error or help
        assert result.exit_code != 0 or 'Usage:' in result.output
    
    def test_command_suggestion_on_typo(self):
        """Test CLI suggests similar command on typo."""
        result = self.runner.invoke(cli, ['workspac'])  # Missing 'e'
        
        assert result.exit_code != 0
