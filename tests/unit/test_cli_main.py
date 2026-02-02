"""
Unit tests for CLI main entry point.

Tests CLI infrastructure including command groups, global options,
logging configuration, and input validation helpers.
"""

import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from caracal.cli.main import (
    cli,
    validate_currency,
    validate_non_negative_decimal,
    validate_positive_decimal,
    validate_resource_type,
    validate_time_window,
    validate_uuid,
)
from caracal.exceptions import InvalidConfigurationError


class TestCLIMain:
    """Test CLI main entry point."""
    
    def test_cli_help(self):
        """Test CLI help output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--help'])
        
        assert result.exit_code == 0
        assert 'Caracal Core' in result.output
        assert 'Economic control plane for AI agents' in result.output
        assert '--config' in result.output
        assert '--log-level' in result.output
        assert '--verbose' in result.output
    
    def test_cli_version(self):
        """Test CLI version output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--version'])
        
        assert result.exit_code == 0
        assert '0.2.0' in result.output
    
    def test_cli_with_config_path(self):
        """Test CLI with custom config path."""
        runner = CliRunner()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write("""
storage:
  agent_registry: /tmp/agents.json
  policy_store: /tmp/policies.json
  ledger: /tmp/ledger.jsonl
  pricebook: /tmp/pricebook.csv
  backup_dir: /tmp/backups
  backup_count: 3
""")
            config_path = f.name
        
        try:
            result = runner.invoke(cli, ['--config', config_path, '--help'])
            assert result.exit_code == 0
        finally:
            os.unlink(config_path)
    
    def test_cli_with_nonexistent_config(self):
        """Test CLI with nonexistent config file falls back to defaults."""
        runner = CliRunner()
        
        # Use a path that definitely doesn't exist
        config_path = "/tmp/nonexistent_caracal_config_12345.yaml"
        
        result = runner.invoke(cli, ['--config', config_path, '--help'])
        # Should succeed by falling back to defaults
        assert result.exit_code == 0
    
    def test_cli_with_log_level(self):
        """Test CLI with custom log level."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--log-level', 'DEBUG', '--help'])
        
        assert result.exit_code == 0
    
    def test_cli_with_verbose(self):
        """Test CLI with verbose flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--verbose', '--help'])
        
        assert result.exit_code == 0
    
    def test_agent_command_group(self):
        """Test agent command group exists."""
        runner = CliRunner()
        result = runner.invoke(cli, ['agent', '--help'])
        
        assert result.exit_code == 0
        assert 'agent' in result.output.lower()
    
    def test_policy_command_group(self):
        """Test policy command group exists."""
        runner = CliRunner()
        result = runner.invoke(cli, ['policy', '--help'])
        
        assert result.exit_code == 0
        assert 'policy' in result.output.lower()
    
    def test_ledger_command_group(self):
        """Test ledger command group exists."""
        runner = CliRunner()
        result = runner.invoke(cli, ['ledger', '--help'])
        
        assert result.exit_code == 0
        assert 'ledger' in result.output.lower()
    
    def test_pricebook_command_group(self):
        """Test pricebook command group exists."""
        runner = CliRunner()
        result = runner.invoke(cli, ['pricebook', '--help'])
        
        assert result.exit_code == 0
        assert 'pricebook' in result.output.lower()
    
    def test_backup_command_group(self):
        """Test backup command group exists."""
        runner = CliRunner()
        result = runner.invoke(cli, ['backup', '--help'])
        
        assert result.exit_code == 0
        assert 'backup' in result.output.lower()
    
    def test_init_command(self):
        """Test init command."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch('pathlib.Path.home', return_value=Path(tmpdir)):
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                assert 'initialized successfully' in result.output
                
                # Check that files were created
                caracal_dir = Path(tmpdir) / '.caracal'
                assert caracal_dir.exists()
                assert (caracal_dir / 'config.yaml').exists()
                assert (caracal_dir / 'agents.json').exists()
                assert (caracal_dir / 'policies.json').exists()
                assert (caracal_dir / 'ledger.jsonl').exists()
                assert (caracal_dir / 'pricebook.csv').exists()
                assert (caracal_dir / 'backups').exists()


class TestInputValidation:
    """Test input validation helpers."""
    
    def test_validate_positive_decimal_valid(self):
        """Test validate_positive_decimal with valid input."""
        from decimal import Decimal
        
        result = validate_positive_decimal(None, None, "100.50")
        assert result == Decimal("100.50")
        
        result = validate_positive_decimal(None, None, 100.50)
        assert result == Decimal("100.50")
    
    def test_validate_positive_decimal_zero(self):
        """Test validate_positive_decimal with zero."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be positive"):
            validate_positive_decimal(None, None, "0")
    
    def test_validate_positive_decimal_negative(self):
        """Test validate_positive_decimal with negative value."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be positive"):
            validate_positive_decimal(None, None, "-10")
    
    def test_validate_positive_decimal_invalid(self):
        """Test validate_positive_decimal with invalid input."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be a valid number"):
            validate_positive_decimal(None, None, "not-a-number")
    
    def test_validate_positive_decimal_none(self):
        """Test validate_positive_decimal with None."""
        result = validate_positive_decimal(None, None, None)
        assert result is None
    
    def test_validate_non_negative_decimal_valid(self):
        """Test validate_non_negative_decimal with valid input."""
        from decimal import Decimal
        
        result = validate_non_negative_decimal(None, None, "0")
        assert result == Decimal("0")
        
        result = validate_non_negative_decimal(None, None, "100.50")
        assert result == Decimal("100.50")
    
    def test_validate_non_negative_decimal_negative(self):
        """Test validate_non_negative_decimal with negative value."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be non-negative"):
            validate_non_negative_decimal(None, None, "-10")
    
    def test_validate_uuid_valid(self):
        """Test validate_uuid with valid UUID."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"
        result = validate_uuid(None, None, valid_uuid)
        assert result == valid_uuid
    
    def test_validate_uuid_invalid(self):
        """Test validate_uuid with invalid UUID."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be a valid UUID"):
            validate_uuid(None, None, "not-a-uuid")
    
    def test_validate_uuid_none(self):
        """Test validate_uuid with None."""
        result = validate_uuid(None, None, None)
        assert result is None
    
    def test_validate_time_window_valid(self):
        """Test validate_time_window with valid window."""
        result = validate_time_window(None, None, "daily")
        assert result == "daily"
    
    def test_validate_time_window_invalid(self):
        """Test validate_time_window with invalid window."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be one of"):
            validate_time_window(None, None, "hourly")
    
    def test_validate_currency_valid(self):
        """Test validate_currency with valid currency."""
        result = validate_currency(None, None, "USD")
        assert result == "USD"
        
        result = validate_currency(None, None, "usd")
        assert result == "USD"
    
    def test_validate_currency_invalid(self):
        """Test validate_currency with invalid currency."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="must be one of"):
            validate_currency(None, None, "EUR")
    
    def test_validate_resource_type_valid(self):
        """Test validate_resource_type with valid resource."""
        result = validate_resource_type(None, None, "openai.gpt4.input_tokens")
        assert result == "openai.gpt4.input_tokens"
        
        result = validate_resource_type(None, None, "  resource  ")
        assert result == "resource"
    
    def test_validate_resource_type_empty(self):
        """Test validate_resource_type with empty string."""
        from click.exceptions import BadParameter
        
        with pytest.raises(BadParameter, match="cannot be empty"):
            validate_resource_type(None, None, "")
        
        with pytest.raises(BadParameter, match="cannot be empty"):
            validate_resource_type(None, None, "   ")
    
    def test_validate_resource_type_none(self):
        """Test validate_resource_type with None."""
        result = validate_resource_type(None, None, None)
        assert result is None
