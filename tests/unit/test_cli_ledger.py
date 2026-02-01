"""
Unit tests for CLI ledger commands.

Tests ledger query and summary commands with various filters and output formats.
"""

import json
import tempfile
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli
from caracal.core.ledger import LedgerWriter


class TestLedgerCLI:
    """Test CLI ledger commands."""
    
    @pytest.fixture
    def temp_ledger(self):
        """Create a temporary ledger with test data."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
            ledger_path = f.name
        
        # Create ledger writer and add test events
        writer = LedgerWriter(ledger_path)
        
        # Add events for agent 1
        writer.append_event(
            agent_id="agent-1",
            resource_type="openai.gpt4.input_tokens",
            quantity=Decimal("1000"),
            cost=Decimal("0.030"),
            currency="USD",
            timestamp=datetime(2024, 1, 15, 10, 30, 0),
        )
        
        writer.append_event(
            agent_id="agent-1",
            resource_type="openai.gpt4.output_tokens",
            quantity=Decimal("500"),
            cost=Decimal("0.030"),
            currency="USD",
            timestamp=datetime(2024, 1, 15, 11, 0, 0),
        )
        
        # Add events for agent 2
        writer.append_event(
            agent_id="agent-2",
            resource_type="anthropic.claude3.input_tokens",
            quantity=Decimal("2000"),
            cost=Decimal("0.030"),
            currency="USD",
            timestamp=datetime(2024, 1, 16, 9, 0, 0),
        )
        
        yield ledger_path
        
        # Cleanup
        Path(ledger_path).unlink(missing_ok=True)
    
    @pytest.fixture
    def temp_config(self, temp_ledger):
        """Create a temporary config file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write(f"""
storage:
  agent_registry: /tmp/agents.json
  policy_store: /tmp/policies.json
  ledger: {temp_ledger}
  pricebook: /tmp/pricebook.csv
  backup_dir: /tmp/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily

logging:
  level: INFO
  file: /tmp/caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
""")
            config_path = f.name
        
        yield config_path
        
        # Cleanup
        Path(config_path).unlink(missing_ok=True)
    
    def test_ledger_query_help(self):
        """Test ledger query help output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['ledger', 'query', '--help'])
        
        assert result.exit_code == 0
        assert 'Query ledger events' in result.output
        assert '--agent-id' in result.output
        assert '--start' in result.output
        assert '--end' in result.output
        assert '--resource' in result.output
        assert '--format' in result.output
    
    def test_ledger_summary_help(self):
        """Test ledger summary help output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['ledger', 'summary', '--help'])
        
        assert result.exit_code == 0
        assert 'Summarize spending' in result.output
        assert '--agent-id' in result.output
        assert '--start' in result.output
        assert '--end' in result.output
        assert '--format' in result.output
    
    def test_query_all_events_table(self, temp_config):
        """Test querying all events with table output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--config', temp_config, 'ledger', 'query'])
        
        assert result.exit_code == 0
        assert 'Total events: 3' in result.output
        assert 'agent-1' in result.output
        assert 'agent-2' in result.output
        assert 'openai.gpt4.input_tokens' in result.output
        assert 'anthropic.claude3.input_tokens' in result.output
    
    def test_query_all_events_json(self, temp_config):
        """Test querying all events with JSON output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--config', temp_config, 'ledger', 'query', '--format', 'json'])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        events = json.loads(result.output)
        assert len(events) == 3
        assert events[0]['agent_id'] == 'agent-1'
        assert events[0]['resource_type'] == 'openai.gpt4.input_tokens'
    
    def test_query_filter_by_agent(self, temp_config):
        """Test querying events filtered by agent ID."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--agent-id', 'agent-1'
        ])
        
        assert result.exit_code == 0
        assert 'Total events: 2' in result.output
        assert 'agent-1' in result.output
        assert 'agent-2' not in result.output
    
    def test_query_filter_by_date_range(self, temp_config):
        """Test querying events filtered by date range."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--start', '2024-01-16',
            '--end', '2024-01-17'
        ])
        
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
        assert 'agent-2' in result.output
        assert 'agent-1' not in result.output
    
    def test_query_filter_by_resource_type(self, temp_config):
        """Test querying events filtered by resource type."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--resource', 'openai.gpt4.input_tokens'
        ])
        
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
        assert 'openai.gpt4.input_tokens' in result.output
        assert 'openai.gpt4.output_tokens' not in result.output
    
    def test_query_combined_filters(self, temp_config):
        """Test querying events with combined filters."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--agent-id', 'agent-1',
            '--start', '2024-01-15',
            '--end', '2024-01-15 12:00:00',
            '--resource', 'openai.gpt4.input_tokens'
        ])
        
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
        assert 'openai.gpt4.input_tokens' in result.output
    
    def test_query_no_results(self, temp_config):
        """Test querying with filters that return no results."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--agent-id', 'nonexistent-agent'
        ])
        
        assert result.exit_code == 0
        assert 'No events found' in result.output
    
    def test_query_invalid_date_format(self, temp_config):
        """Test querying with invalid date format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--start', 'invalid-date'
        ])
        
        assert result.exit_code == 1
        assert 'Invalid start time' in result.output
    
    def test_query_invalid_date_range(self, temp_config):
        """Test querying with start time after end time."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'query',
            '--start', '2024-01-20',
            '--end', '2024-01-10'
        ])
        
        assert result.exit_code == 1
        assert 'Start time must be before or equal to end time' in result.output
    
    def test_summary_single_agent_table(self, temp_config):
        """Test summary for single agent with table output."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--agent-id', 'agent-1',
            '--start', '2024-01-15',
            '--end', '2024-01-15 23:59:59'
        ])
        
        assert result.exit_code == 0
        assert 'Spending Summary for Agent: agent-1' in result.output
        assert 'Total Spending: 0.060 USD' in result.output
        assert 'Breakdown by Resource Type' in result.output
        assert 'openai.gpt4.input_tokens' in result.output
        assert 'openai.gpt4.output_tokens' in result.output
    
    def test_summary_single_agent_json(self, temp_config):
        """Test summary for single agent with JSON output."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--agent-id', 'agent-1',
            '--start', '2024-01-15',
            '--end', '2024-01-15 23:59:59',
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        summary = json.loads(result.output)
        assert summary['agent_id'] == 'agent-1'
        assert summary['total_spending'] == '0.060'
        assert 'breakdown_by_resource' in summary
        assert 'openai.gpt4.input_tokens' in summary['breakdown_by_resource']
    
    def test_summary_multi_agent_table(self, temp_config):
        """Test summary for multiple agents with table output."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--start', '2024-01-15',
            '--end', '2024-01-17'
        ])
        
        assert result.exit_code == 0
        assert 'Spending Summary by Agent' in result.output
        assert 'Total Agents: 2' in result.output
        assert 'Total Spending: 0.090 USD' in result.output
        assert 'agent-1' in result.output
        assert 'agent-2' in result.output
    
    def test_summary_multi_agent_json(self, temp_config):
        """Test summary for multiple agents with JSON output."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--start', '2024-01-15',
            '--end', '2024-01-17',
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        summary = json.loads(result.output)
        assert 'agents' in summary
        assert 'agent-1' in summary['agents']
        assert 'agent-2' in summary['agents']
        assert summary['agents']['agent-1'] == '0.060'
        assert summary['agents']['agent-2'] == '0.030'
    
    def test_summary_no_spending(self, temp_config):
        """Test summary with no spending in time period."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--start', '2024-01-01',
            '--end', '2024-01-10'
        ])
        
        assert result.exit_code == 0
        assert 'No spending recorded' in result.output
    
    def test_summary_missing_time_range(self, temp_config):
        """Test summary without required time range."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary'
        ])
        
        assert result.exit_code == 1
        assert '--start and --end are required' in result.output
    
    def test_summary_single_agent_missing_time_range(self, temp_config):
        """Test summary for single agent without required time range."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', temp_config,
            'ledger', 'summary',
            '--agent-id', 'agent-1'
        ])
        
        assert result.exit_code == 1
        assert '--start and --end are required' in result.output
