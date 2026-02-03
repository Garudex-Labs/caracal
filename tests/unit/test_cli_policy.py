"""
Unit tests for CLI policy commands.

Tests policy creation, listing, and retrieval via CLI.
"""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli
from caracal.core.identity import AgentRegistry
from caracal.core.policy import PolicyStore


class TestPolicyCLI:
    """Test CLI policy commands."""
    
    @pytest.fixture
    def temp_dir(self):
        """Create temporary directory for test files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)
    
    @pytest.fixture
    def config_file(self, temp_dir):
        """Create temporary config file."""
        config_path = temp_dir / "config.yaml"
        config_content = f"""
storage:
  agent_registry: {temp_dir}/agents.json
  policy_store: {temp_dir}/policies.json
  ledger: {temp_dir}/ledger.jsonl
  pricebook: {temp_dir}/pricebook.csv
  backup_dir: {temp_dir}/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily

logging:
  level: INFO
  file: {temp_dir}/caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
"""
        config_path.write_text(config_content)
        return str(config_path)
    
    @pytest.fixture
    def agent_id(self, temp_dir, config_file):
        """Create a test agent and return its ID."""
        # Create agent registry
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        
        # Register agent
        agent = registry.register_agent(
            name="test-agent",
            owner="test@example.com"
        )
        
        return agent.agent_id
    
    def test_policy_help(self):
        """Test policy command help output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['policy', '--help'])
        
        assert result.exit_code == 0
        assert 'policy' in result.output.lower()
        assert 'budget' in result.output.lower()
    
    def test_policy_create_success(self, config_file, agent_id):
        """Test successful policy creation."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        
        assert result.exit_code == 0
        assert 'Policy created successfully' in result.output
        assert 'Policy ID:' in result.output
        assert 'Agent ID:' in result.output
        assert '100.00 USD' in result.output
        assert 'daily' in result.output
    
    def test_policy_create_with_options(self, config_file, agent_id):
        """Test policy creation with all options."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '50.00',
            '--time-window', 'daily',
            '--currency', 'USD'
        ])
        
        assert result.exit_code == 0
        assert 'Policy created successfully' in result.output
        assert '50.00 USD' in result.output
    
    def test_policy_create_invalid_agent(self, config_file):
        """Test policy creation with nonexistent agent."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', '00000000-0000-0000-0000-000000000000',
            '--limit', '100.00'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'does not exist' in result.output
    
    def test_policy_create_negative_limit(self, config_file, agent_id):
        """Test policy creation with negative limit."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '-10.00'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'must be positive' in result.output
    
    def test_policy_create_zero_limit(self, config_file, agent_id):
        """Test policy creation with zero limit."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '0'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'must be positive' in result.output
    
    def test_policy_create_invalid_limit(self, config_file, agent_id):
        """Test policy creation with invalid limit format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', 'not-a-number'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'Invalid limit amount' in result.output
    
    def test_policy_create_invalid_window(self, config_file, agent_id):
        """Test policy creation with unsupported time window."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00',
            '--time-window', 'hourly'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'daily' in result.output
    
    def test_policy_create_invalid_currency(self, config_file, agent_id):
        """Test policy creation with unsupported currency."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00',
            '--currency', 'EUR'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'USD' in result.output
    
    def test_policy_list_empty(self, config_file):
        """Test listing policies when none exist."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'list'
        ])
        
        assert result.exit_code == 0
        assert 'No policies found' in result.output
    
    def test_policy_list_table_format(self, config_file, agent_id):
        """Test listing policies in table format."""
        # Create a policy first
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        
        # List policies
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'list'
        ])
        
        assert result.exit_code == 0
        assert 'Total policies: 1' in result.output
        assert 'Policy ID' in result.output
        assert 'Agent ID' in result.output
        assert 'Limit' in result.output
        assert 'Window' in result.output
        assert 'Active' in result.output
        assert agent_id in result.output
        assert '100.00 USD' in result.output
        assert 'daily' in result.output
    
    def test_policy_list_json_format(self, config_file, agent_id):
        """Test listing policies in JSON format."""
        # Create a policy first
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        
        # List policies in JSON format (use mix_stderr=False to separate logs from JSON)
        runner_json = CliRunner(mix_stderr=False)
        result = runner_json.invoke(cli, [
            '--config', config_file,
            'policy', 'list',
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        policies = json.loads(result.output)
        assert len(policies) == 1
        assert policies[0]['agent_id'] == agent_id
        assert policies[0]['limit_amount'] == '100.00'
        assert policies[0]['currency'] == 'USD'
        assert policies[0]['time_window'] == 'daily'
        assert policies[0]['active'] is True
    
    def test_policy_list_filter_by_agent(self, config_file, agent_id, temp_dir):
        """Test listing policies filtered by agent ID."""
        # Create another agent
        registry_path = temp_dir / "agents.json"
        registry = AgentRegistry(str(registry_path))
        agent2 = registry.register_agent(
            name="test-agent-2",
            owner="test2@example.com"
        )
        
        # Create policies for both agents
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent2.agent_id,
            '--limit', '200.00'
        ])
        
        # List policies for first agent only
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'list',
            '--agent-id', agent_id
        ])
        
        assert result.exit_code == 0
        assert 'Total policies: 1' in result.output
        assert agent_id in result.output
        assert agent2.agent_id not in result.output
        assert '100.00 USD' in result.output
        assert '200.00 USD' not in result.output
    
    def test_policy_get_success(self, config_file, agent_id):
        """Test getting policies for a specific agent."""
        # Create a policy first
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        
        # Get policies for agent
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'get',
            '--agent-id', agent_id
        ])
        
        assert result.exit_code == 0
        assert f'Policies for Agent: {agent_id}' in result.output
        assert 'Policy #1' in result.output
        assert 'Policy ID:' in result.output
        assert 'Limit:' in result.output
        assert '100.00 USD' in result.output
        assert 'Time Window:' in result.output
        assert 'daily' in result.output
        assert 'Active:' in result.output
        assert 'Yes' in result.output
    
    def test_policy_get_no_policies(self, config_file, agent_id):
        """Test getting policies for agent with no policies."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'get',
            '--agent-id', agent_id
        ])
        
        assert result.exit_code == 0
        assert 'No active policies found' in result.output
    
    def test_policy_get_json_format(self, config_file, agent_id):
        """Test getting policies in JSON format."""
        # Create a policy first
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        
        # Get policies in JSON format (use mix_stderr=False to separate logs from JSON)
        runner_json = CliRunner(mix_stderr=False)
        result = runner_json.invoke(cli, [
            '--config', config_file,
            'policy', 'get',
            '--agent-id', agent_id,
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        policies = json.loads(result.output)
        assert len(policies) == 1
        assert policies[0]['agent_id'] == agent_id
        assert policies[0]['limit_amount'] == '100.00'
    
    def test_policy_get_multiple_policies(self, config_file, agent_id):
        """Test getting multiple policies for same agent."""
        # Create multiple policies
        runner = CliRunner()
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '100.00'
        ])
        runner.invoke(cli, [
            '--config', config_file,
            'policy', 'create',
            '--agent-id', agent_id,
            '--limit', '200.00'
        ])
        
        # Get policies
        result = runner.invoke(cli, [
            '--config', config_file,
            'policy', 'get',
            '--agent-id', agent_id
        ])
        
        assert result.exit_code == 0
        assert 'Policy #1' in result.output
        assert 'Policy #2' in result.output
        assert '100.00 USD' in result.output
        assert '200.00 USD' in result.output
