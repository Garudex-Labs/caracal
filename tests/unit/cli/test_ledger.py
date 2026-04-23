"""
Unit tests for CLI ledger commands.

This module tests ledger CLI commands including query, summary, and delegation-path.
"""
import pytest
from click.testing import CliRunner
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from caracal.cli.ledger import query, summary
from caracal.datetime_parsing import parse_datetime


@pytest.mark.unit
class TestLedgerQueryCommand:
    """Test suite for ledger query command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_all_events(self, mock_get_query):
        """Test querying all ledger events."""
        # Arrange
        mock_event = Mock()
        mock_event.event_id = 1
        mock_event.principal_id = str(uuid4())
        mock_event.resource_type = 'test-resource'
        mock_event.quantity = '1'
        mock_event.timestamp = '2024-01-01T00:00:00'
        mock_event.to_dict.return_value = {
            'event_id': 1,
            'principal_id': mock_event.principal_id,
            'resource_type': 'test-resource',
            'quantity': '1',
            'timestamp': '2024-01-01T00:00:00'
        }
        
        mock_query = Mock()
        mock_query.get_events.return_value = [mock_event]
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(query, [], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_no_events(self, mock_get_query):
        """Test querying when no events exist."""
        # Arrange
        mock_query = Mock()
        mock_query.get_events.return_value = []
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(query, [], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'No events found' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_with_filters(self, mock_get_query):
        """Test querying with filters."""
        # Arrange
        principal_id = str(uuid4())
        mock_event = Mock()
        mock_event.event_id = 1
        mock_event.principal_id = principal_id
        mock_event.resource_type = 'test-resource'
        mock_event.quantity = '1'
        mock_event.timestamp = '2024-01-01T00:00:00'
        mock_event.to_dict.return_value = {
            'event_id': 1,
            'principal_id': principal_id,
            'resource_type': 'test-resource',
            'quantity': '1',
            'timestamp': '2024-01-01T00:00:00'
        }
        
        mock_query = Mock()
        mock_query.get_events.return_value = [mock_event]
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(query, [
            '--principal-id', principal_id,
            '--start', '2024-01-01',
            '--end', '2024-01-31',
            '--resource', 'test-resource'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_json_format(self, mock_get_query):
        """Test querying with JSON output format."""
        # Arrange
        mock_event = Mock()
        mock_event.event_id = 1
        mock_event.principal_id = str(uuid4())
        mock_event.resource_type = 'test-resource'
        mock_event.quantity = '1'
        mock_event.timestamp = '2024-01-01T00:00:00'
        mock_event.to_dict.return_value = {
            'event_id': 1,
            'principal_id': mock_event.principal_id,
            'resource_type': 'test-resource',
            'quantity': '1',
            'timestamp': '2024-01-01T00:00:00'
        }
        
        mock_query = Mock()
        mock_query.get_events.return_value = [mock_event]
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(query, ['--format', 'json'], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'event_id' in result.output
    
    def test_query_invalid_date_format(self):
        """Test querying with invalid date format."""
        result = self.runner.invoke(query, [
            '--start', 'invalid-date'
        ], obj=Mock(config=Mock()))
        
        assert result.exit_code != 0
        assert 'Invalid' in result.output
    
    def test_query_start_after_end(self):
        """Test querying with start date after end date."""
        result = self.runner.invoke(query, [
            '--start', '2024-12-31',
            '--end', '2024-01-01'
        ], obj=Mock(config=Mock()))
        
        assert result.exit_code != 0
        assert 'before or equal' in result.output


@pytest.mark.unit
class TestLedgerSummaryCommand:
    """Test suite for ledger summary command."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_summary_multi_agent(self, mock_get_query):
        """Test summary for multiple agents."""
        # Arrange
        mock_query = Mock()
        mock_query.aggregate_by_principal.return_value = {
            str(uuid4()): Decimal('100'),
            str(uuid4()): Decimal('50')
        }
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(summary, [
            '--start', '2024-01-01',
            '--end', '2024-01-31'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'Usage Summary by Principal' in result.output
        assert 'Total Principals: 2' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_summary_single_agent(self, mock_get_query):
        """Test summary for a single agent."""
        # Arrange
        principal_id = str(uuid4())
        mock_event = Mock()
        mock_event.event_id = 1
        mock_event.principal_id = principal_id
        mock_event.resource_type = 'test-resource'
        mock_event.quantity = '10'
        
        mock_query = Mock()
        mock_query.sum_usage.return_value = Decimal('10')
        mock_query.get_events.return_value = [mock_event]
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(summary, [
            '--principal-id', principal_id,
            '--start', '2024-01-01',
            '--end', '2024-01-31'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'Usage Summary for Principal' in result.output
        assert 'Total Usage: 10' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    @patch('caracal.cli.ledger.get_principal_registry')
    def test_summary_with_aggregate_children(self, mock_get_registry, mock_get_query):
        """Test summary with aggregate children option."""
        # Arrange
        principal_id = str(uuid4())
        
        mock_query = Mock()
        mock_query.sum_usage_with_children.return_value = {
            principal_id: Decimal('100'),
            str(uuid4()): Decimal('50')
        }
        mock_get_query.return_value = mock_query
        mock_get_registry.return_value = Mock()
        
        # Act
        result = self.runner.invoke(summary, [
            '--principal-id', principal_id,
            '--start', '2024-01-01',
            '--end', '2024-01-31',
            '--aggregate-children'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'with children' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    @patch('caracal.cli.ledger.get_principal_registry')
    def test_summary_with_breakdown(self, mock_get_registry, mock_get_query):
        """Test summary with hierarchical breakdown."""
        # Arrange
        principal_id = str(uuid4())
        
        mock_query = Mock()
        mock_query.get_usage_breakdown.return_value = {
            'principal_id': principal_id,
            'principal_name': 'test-principal',
            'usage': '100',
            'children': [],
            'total_with_children': '100'
        }
        mock_get_query.return_value = mock_query
        mock_get_registry.return_value = Mock()
        
        # Act
        result = self.runner.invoke(summary, [
            '--principal-id', principal_id,
            '--start', '2024-01-01',
            '--end', '2024-01-31',
            '--breakdown'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'directed Usage Breakdown' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_summary_no_usage(self, mock_get_query):
        """Test summary when no usage recorded."""
        # Arrange
        mock_query = Mock()
        mock_query.aggregate_by_principal.return_value = {}
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(summary, [
            '--start', '2024-01-01',
            '--end', '2024-01-31'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'No usage recorded' in result.output
    
    def test_summary_missing_dates(self):
        """Test summary without required date range."""
        result = self.runner.invoke(summary, [], obj=Mock(config=Mock()))
        
        assert result.exit_code != 0
        assert 'required' in result.output.lower()


@pytest.mark.unit
class TestParseDatetime:
    """Test suite for parse_datetime utility function."""
    
    def test_parse_iso_format(self):
        """Test parsing ISO 8601 format."""
        result = parse_datetime('2024-01-15T10:30:00Z')
        
        assert isinstance(result, datetime)
        assert result.year == 2024
        assert result.month == 1
        assert result.day == 15
    
    def test_parse_date_only(self):
        """Test parsing date only format."""
        result = parse_datetime('2024-01-15')
        
        assert isinstance(result, datetime)
        assert result.year == 2024
        assert result.month == 1
        assert result.day == 15
        assert result.hour == 0
        assert result.minute == 0
    
    def test_parse_date_time(self):
        """Test parsing date and time format."""
        result = parse_datetime('2024-01-15 10:30:00')
        
        assert isinstance(result, datetime)
        assert result.year == 2024
        assert result.month == 1
        assert result.day == 15
        assert result.hour == 10
        assert result.minute == 30
    
    def test_parse_invalid_format(self):
        """Test parsing invalid date format."""
        with pytest.raises(ValueError) as exc_info:
            parse_datetime('invalid-date')
        
        assert 'Invalid date format' in str(exc_info.value)


@pytest.mark.unit
class TestLedgerCommandArguments:
    """Test suite for ledger command argument parsing."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_help(self, mock_get_query):
        """Test query command help."""
        result = self.runner.invoke(query, ['--help'])
        
        assert result.exit_code == 0
        assert 'Query ledger events' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_summary_help(self, mock_get_query):
        """Test summary command help."""
        result = self.runner.invoke(summary, ['--help'])
        
        assert result.exit_code == 0
        assert 'Summarize usage' in result.output


@pytest.mark.unit
class TestLedgerOutputFormatting:
    """Test suite for ledger output formatting."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.runner = CliRunner()
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_query_table_format(self, mock_get_query):
        """Test query with table output format."""
        # Arrange
        mock_event = Mock()
        mock_event.event_id = 1
        mock_event.principal_id = str(uuid4())
        mock_event.resource_type = 'test-resource'
        mock_event.quantity = '1'
        mock_event.timestamp = '2024-01-01T00:00:00'
        mock_event.to_dict.return_value = {
            'event_id': 1,
            'principal_id': mock_event.principal_id,
            'resource_type': 'test-resource',
            'quantity': '1',
            'timestamp': '2024-01-01T00:00:00'
        }
        
        mock_query = Mock()
        mock_query.get_events.return_value = [mock_event]
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(query, ['--format', 'table'], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'Total events: 1' in result.output
    
    @patch('caracal.cli.ledger.get_ledger_query')
    def test_summary_json_format(self, mock_get_query):
        """Test summary with JSON output format."""
        # Arrange
        mock_query = Mock()
        mock_query.aggregate_by_principal.return_value = {
            str(uuid4()): Decimal('100')
        }
        mock_get_query.return_value = mock_query
        
        # Act
        result = self.runner.invoke(summary, [
            '--start', '2024-01-01',
            '--end', '2024-01-31',
            '--format', 'json'
        ], obj=Mock(config=Mock()))
        
        # Assert
        assert result.exit_code == 0
        assert 'principals' in result.output
