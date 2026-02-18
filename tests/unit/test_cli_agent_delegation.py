"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for CLI agent delegation commands.

Tests the agent register command with parent-id and delegated-budget options,
and the delegation list and revoke commands.
"""

import json
import os
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli
from caracal.core.identity import AgentRegistry
from caracal.core.policy import PolicyStore


class TestCLIAgentDelegation:
    """Test CLI agent delegation commands."""
    
    def test_agent_register_with_parent_id(self):
        """Test registering an agent with a parent ID."""
        runner = CliRunner()
        
        with runner.isolated_filesystem():
            # Create config
            config_path = Path("config.yaml")
            config_path.write_text("""
storage:
  agent_registry: agents.json
  policy_store: policies.json
  ledger: ledger.jsonl
  pricebook: pricebook.csv
  backup_dir: backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
""")
            
            # Register parent agent first
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'parent-agent',
                '--owner', 'parent@example.com'
            ])
            
            assert result.exit_code == 0
            assert 'Agent registered successfully' in result.output
            
            # Extract parent agent ID from output
            lines = result.output.split('\n')
            parent_id = None
            for line in lines:
                if 'Agent ID:' in line:
                    parent_id = line.split('Agent ID:')[1].strip()
                    break
            
            assert parent_id is not None
            
            # Register child agent with parent ID
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'child-agent',
                '--owner', 'child@example.com',
                '--parent-id', parent_id
            ])
            
            assert result.exit_code == 0
            assert 'Agent registered successfully' in result.output
            assert f'Parent ID:   {parent_id}' in result.output
    
    def test_agent_register_with_delegated_budget(self):
        """Test registering an agent with delegated budget."""
        runner = CliRunner()
        
        with runner.isolated_filesystem():
            # Create config
            config_path = Path("config.yaml")
            config_path.write_text("""
storage:
  agent_registry: agents.json
  policy_store: policies.json
  ledger: ledger.jsonl
  pricebook: pricebook.csv
  backup_dir: backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
""")
            
            # Register parent agent first
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'parent-agent',
                '--owner', 'parent@example.com'
            ])
            
            assert result.exit_code == 0
            
            # Extract parent agent ID
            lines = result.output.split('\n')
            parent_id = None
            for line in lines:
                if 'Agent ID:' in line:
                    parent_id = line.split('Agent ID:')[1].strip()
                    break
            
            # Register child agent with delegated budget
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'child-agent',
                '--owner', 'child@example.com',
                '--parent-id', parent_id,
                '--delegated-budget', '50.00'
            ])
            
            assert result.exit_code == 0
            assert 'Agent registered successfully' in result.output
            assert 'Delegated budget policy created' in result.output
            assert 'Limit:       50.0 USD' in result.output
    
    def test_agent_register_delegated_budget_requires_parent(self):
        """Test that delegated budget requires parent ID."""
        runner = CliRunner()
        
        with runner.isolated_filesystem():
            # Create config
            config_path = Path("config.yaml")
            config_path.write_text("""
storage:
  agent_registry: agents.json
  policy_store: policies.json
  ledger: ledger.jsonl
  pricebook: pricebook.csv
  backup_dir: backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
""")
            
            # Try to register agent with delegated budget but no parent
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'child-agent',
                '--owner', 'child@example.com',
                '--delegated-budget', '50.00'
            ])
            
            assert result.exit_code == 1
            assert '--delegated-budget requires --parent-id' in result.output
    
    def test_delegation_list_command(self):
        """Test delegation list command."""
        runner = CliRunner()
        
        with runner.isolated_filesystem():
            # Create config
            config_path = Path("config.yaml")
            config_path.write_text("""
storage:
  agent_registry: agents.json
  policy_store: policies.json
  ledger: ledger.jsonl
  pricebook: pricebook.csv
  backup_dir: backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
""")
            
            # Register parent and child with delegation
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'parent-agent',
                '--owner', 'parent@example.com'
            ])
            assert result.exit_code == 0
            
            lines = result.output.split('\n')
            parent_id = None
            for line in lines:
                if 'Agent ID:' in line:
                    parent_id = line.split('Agent ID:')[1].strip()
                    break
            
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'child-agent',
                '--owner', 'child@example.com',
                '--parent-id', parent_id,
                '--delegated-budget', '50.00'
            ])
            assert result.exit_code == 0
            
            # List all delegations
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'delegation', 'list'
            ])
            
            assert result.exit_code == 0
            assert 'Total delegations: 1' in result.output
            assert 'parent-agent' in result.output
            assert 'child-agent' in result.output
    
    def test_delegation_revoke_command(self):
        """Test delegation revoke command."""
        runner = CliRunner()
        
        with runner.isolated_filesystem():
            # Create config
            config_path = Path("config.yaml")
            config_path.write_text("""
storage:
  agent_registry: agents.json
  policy_store: policies.json
  ledger: ledger.jsonl
  pricebook: pricebook.csv
  backup_dir: backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
""")
            
            # Register parent and child with delegation
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'parent-agent',
                '--owner', 'parent@example.com'
            ])
            assert result.exit_code == 0
            
            lines = result.output.split('\n')
            parent_id = None
            for line in lines:
                if 'Agent ID:' in line:
                    parent_id = line.split('Agent ID:')[1].strip()
                    break
            
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'agent', 'register',
                '--name', 'child-agent',
                '--owner', 'child@example.com',
                '--parent-id', parent_id,
                '--delegated-budget', '50.00'
            ])
            assert result.exit_code == 0
            
            # Extract policy ID
            lines = result.output.split('\n')
            policy_id = None
            for line in lines:
                if 'Policy ID:' in line:
                    policy_id = line.split('Policy ID:')[1].strip()
                    break
            
            assert policy_id is not None
            
            # Revoke delegation with --confirm flag
            result = runner.invoke(cli, [
                '--config', str(config_path),
                'delegation', 'revoke',
                '--policy-id', policy_id,
                '--confirm'
            ])
            
            assert result.exit_code == 0
            assert 'Delegation revoked successfully' in result.output
            assert 'Status:        Inactive' in result.output
