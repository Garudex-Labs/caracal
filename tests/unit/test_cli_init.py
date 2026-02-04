"""
Unit tests for CLI init command.

Tests the caracal init command that creates the directory structure
and default configuration files.
"""

import os
import tempfile
from pathlib import Path

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli


class TestCLIInit:
    """Test suite for CLI init command."""
    
    def test_init_creates_directory_structure(self):
        """Test that init command creates ~/.caracal directory."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            # Override home directory
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                assert "Created directory:" in result.output
                
                caracal_dir = Path(tmpdir) / ".caracal"
                assert caracal_dir.exists()
                assert caracal_dir.is_dir()
                
                backups_dir = caracal_dir / "backups"
                assert backups_dir.exists()
                assert backups_dir.is_dir()
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_creates_config_yaml(self):
        """Test that init command creates config.yaml with default content."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                
                config_path = Path(tmpdir) / ".caracal" / "config.yaml"
                assert config_path.exists()
                
                content = config_path.read_text()
                assert "storage:" in content
                assert "agent_registry:" in content
                assert "policy_store:" in content
                assert "ledger:" in content
                assert "pricebook:" in content
                assert "backup_dir:" in content
                assert "defaults:" in content
                assert "logging:" in content
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_creates_empty_agents_json(self):
        """Test that init command creates empty agents.json."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                
                agents_path = Path(tmpdir) / ".caracal" / "agents.json"
                assert agents_path.exists()
                assert agents_path.read_text() == "[]"
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_creates_empty_policies_json(self):
        """Test that init command creates empty policies.json."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                
                policies_path = Path(tmpdir) / ".caracal" / "policies.json"
                assert policies_path.exists()
                assert policies_path.read_text() == "[]"
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_creates_empty_ledger_jsonl(self):
        """Test that init command creates empty ledger.jsonl."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                
                ledger_path = Path(tmpdir) / ".caracal" / "ledger.jsonl"
                assert ledger_path.exists()
                assert ledger_path.read_text() == ""
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_creates_sample_pricebook_csv(self):
        """Test that init command creates sample pricebook.csv with common resources."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                
                pricebook_path = Path(tmpdir) / ".caracal" / "pricebook.csv"
                assert pricebook_path.exists()
                
                content = pricebook_path.read_text()
                assert "resource_type,price_per_unit,currency,updated_at" in content
                assert "openai.gpt-5.2.input_tokens" in content
                assert "openai.gpt-5.2.output_tokens" in content
                assert "openai.gpt-5.2.cached_input_tokens" in content
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_is_idempotent(self):
        """Test that running init twice doesn't fail or overwrite existing files."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                # Run init first time
                result1 = runner.invoke(cli, ['init'])
                assert result1.exit_code == 0
                
                # Modify config to test it's not overwritten
                config_path = Path(tmpdir) / ".caracal" / "config.yaml"
                original_content = config_path.read_text()
                modified_content = original_content + "\n# Custom comment\n"
                config_path.write_text(modified_content)
                
                # Run init second time
                result2 = runner.invoke(cli, ['init'])
                assert result2.exit_code == 0
                assert "already exists" in result2.output
                
                # Verify config wasn't overwritten
                assert config_path.read_text() == modified_content
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
    
    def test_init_success_message(self):
        """Test that init command displays success message with next steps."""
        runner = CliRunner()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmpdir
            
            try:
                result = runner.invoke(cli, ['init'])
                
                assert result.exit_code == 0
                assert "Caracal Core initialized successfully" in result.output
                assert "Next steps:" in result.output
                assert "caracal agent register" in result.output
                assert "caracal policy create" in result.output
            
            finally:
                if original_home:
                    os.environ['HOME'] = original_home
                else:
                    if 'HOME' in os.environ:
                        del os.environ['HOME']
