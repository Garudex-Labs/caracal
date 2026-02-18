"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CLI database management commands.

Tests the caracal db commands for database initialization, migrations, and status.
"""

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli


class TestCLIDatabase:
    """Test suite for CLI database commands."""
    
    def test_db_command_group_exists(self):
        """Test that db command group is registered."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', '--help'])
        
        assert result.exit_code == 0
        assert "Database management commands" in result.output
    
    def test_db_init_db_command_exists(self):
        """Test that init-db command is registered."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', '--help'])
        
        assert result.exit_code == 0
        assert "init-db" in result.output
        assert "Initialize the database schema" in result.output
    
    def test_db_migrate_command_exists(self):
        """Test that migrate command is registered."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', '--help'])
        
        assert result.exit_code == 0
        assert "migrate" in result.output
        assert "Run database migrations" in result.output
    
    def test_db_status_command_exists(self):
        """Test that status command is registered."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', '--help'])
        
        assert result.exit_code == 0
        assert "status" in result.output
        assert "Show database schema status" in result.output
    
    def test_db_init_db_help(self):
        """Test init-db command help text."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'init-db', '--help'])
        
        assert result.exit_code == 0
        assert "Initialize the database schema" in result.output
        assert "Creates all tables defined in SQLAlchemy models" in result.output
    
    def test_db_migrate_help(self):
        """Test migrate command help text."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'migrate', '--help'])
        
        assert result.exit_code == 0
        assert "Run database migrations" in result.output
        assert "DIRECTION" in result.output
        assert "up" in result.output
        assert "down" in result.output
    
    def test_db_migrate_requires_direction(self):
        """Test that migrate command requires direction argument."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'migrate'])
        
        assert result.exit_code != 0
        assert "Missing argument" in result.output or "DIRECTION" in result.output
    
    def test_db_migrate_accepts_up_direction(self):
        """Test that migrate command accepts 'up' direction."""
        runner = CliRunner()
        # This will fail due to missing database config, but should accept the argument
        result = runner.invoke(cli, ['db', 'migrate', 'up'])
        
        # Should fail with config error, not argument error
        assert "Database configuration not found" in result.output or "Cannot connect" in result.output
    
    def test_db_migrate_accepts_down_direction(self):
        """Test that migrate command accepts 'down' direction."""
        runner = CliRunner()
        # This will fail due to missing database config, but should accept the argument
        result = runner.invoke(cli, ['db', 'migrate', 'down'])
        
        # Should fail with config error, not argument error
        assert "Database configuration not found" in result.output or "Cannot connect" in result.output
    
    def test_db_migrate_rejects_invalid_direction(self):
        """Test that migrate command rejects invalid direction."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'migrate', 'invalid'])
        
        assert result.exit_code != 0
        assert "Invalid value" in result.output or "invalid" in result.output.lower()
    
    def test_db_migrate_sql_flag(self):
        """Test that migrate command accepts --sql flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'migrate', 'up', '--sql'])
        
        # Should fail with config error, but flag should be accepted
        assert "Database configuration not found" in result.output or "Cannot connect" in result.output or "Generating SQL" in result.output
    
    def test_db_migrate_revision_option(self):
        """Test that migrate command accepts --revision option."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'migrate', 'up', '--revision', 'abc123'])
        
        # Should fail with config error, but option should be accepted
        assert "Database configuration not found" in result.output or "Cannot connect" in result.output
    
    def test_db_status_help(self):
        """Test status command help text."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'status', '--help'])
        
        assert result.exit_code == 0
        assert "Show database schema status" in result.output
        assert "Displays current schema version" in result.output
        assert "--verbose" in result.output
    
    def test_db_status_verbose_flag(self):
        """Test that status command accepts --verbose flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'status', '--verbose'])
        
        # Should fail with config error, but flag should be accepted
        assert "Database configuration not found" in result.output or "Cannot connect" in result.output or "Database Status" in result.output
    
    def test_db_init_db_requires_database_config(self):
        """Test that init-db fails gracefully without database config."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'init-db'])
        
        # Should fail with clear error message about missing config
        assert result.exit_code != 0
        assert "Database configuration not found" in result.output
    
    def test_db_status_requires_database_config(self):
        """Test that status fails gracefully without database config."""
        runner = CliRunner()
        result = runner.invoke(cli, ['db', 'status'])
        
        # Should fail with clear error message about missing config
        assert result.exit_code != 0
        assert "Database configuration not found" in result.output
