"""
Unit tests for CLI pricebook commands.

Tests pricebook listing, getting, setting, and importing via CLI.
"""

import json
import tempfile
from pathlib import Path

import pytest
from click.testing import CliRunner

from caracal.cli.main import cli
from caracal.core.pricebook import Pricebook


class TestPricebookCLI:
    """Test CLI pricebook commands."""
    
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
    def pricebook_with_data(self, temp_dir):
        """Create a pricebook with sample data."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        # Add sample prices
        from decimal import Decimal
        pricebook.set_price("openai.gpt-5.2.input_tokens", Decimal("1.75"), "USD")
        pricebook.set_price("openai.gpt-5.2.output_tokens", Decimal("14.00"), "USD")
        pricebook.set_price("openai.gpt-5.2.cached_input_tokens", Decimal("0.175"), "USD")
        
        return pricebook
    
    def test_pricebook_help(self):
        """Test pricebook command help output."""
        runner = CliRunner()
        result = runner.invoke(cli, ['pricebook', '--help'])
        
        assert result.exit_code == 0
        assert 'pricebook' in result.output.lower()
        assert 'resource' in result.output.lower()
        assert 'price' in result.output.lower()
    
    def test_pricebook_list_empty(self, config_file):
        """Test listing prices when pricebook is empty."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'list'
        ])
        
        assert result.exit_code == 0
        assert 'No prices in pricebook' in result.output
    
    def test_pricebook_list_table_format(self, config_file, pricebook_with_data):
        """Test listing prices in table format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'list'
        ])
        
        assert result.exit_code == 0
        assert 'Total resources: 3' in result.output
        assert 'Resource Type' in result.output
        assert 'Price/Unit' in result.output
        assert 'Currency' in result.output
        assert 'Last Updated' in result.output
        assert 'openai.gpt-5.2.input_tokens' in result.output
        assert '1.75' in result.output
        assert 'USD' in result.output
    
    def test_pricebook_list_json_format(self, config_file, pricebook_with_data):
        """Test listing prices in JSON format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'list',
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        prices = json.loads(result.output)
        assert len(prices) == 3
        assert 'openai.gpt-5.2.input_tokens' in prices
        assert prices['openai.gpt-5.2.input_tokens']['price_per_unit'] == '1.75'
        assert prices['openai.gpt-5.2.input_tokens']['currency'] == 'USD'
    
    def test_pricebook_get_success(self, config_file, pricebook_with_data):
        """Test getting price for a specific resource."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'get',
            '--resource', 'openai.gpt-5.2.input_tokens'
        ])
        
        assert result.exit_code == 0
        assert 'Resource Price Details' in result.output
        assert 'Resource:' in result.output
        assert 'openai.gpt-5.2.input_tokens' in result.output
        assert 'Price:' in result.output
        assert '1.75 USD per unit' in result.output
        assert 'Last Updated:' in result.output
    
    def test_pricebook_get_not_found(self, config_file, pricebook_with_data):
        """Test getting price for nonexistent resource."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'get',
            '--resource', 'nonexistent.resource'
        ])
        
        assert result.exit_code == 1
        assert 'not found in pricebook' in result.output
    
    def test_pricebook_get_json_format(self, config_file, pricebook_with_data):
        """Test getting price in JSON format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'get',
            '--resource', 'openai.gpt-5.2.input_tokens',
            '--format', 'json'
        ])
        
        assert result.exit_code == 0
        
        # Parse JSON output
        price_entry = json.loads(result.output)
        assert price_entry['resource_type'] == 'openai.gpt-5.2.input_tokens'
        assert price_entry['price_per_unit'] == '1.75'
        assert price_entry['currency'] == 'USD'
    
    def test_pricebook_set_new_resource(self, config_file):
        """Test setting price for a new resource."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'custom.api.calls',
            '--price', '0.01'
        ])
        
        assert result.exit_code == 0
        assert 'Price set successfully' in result.output
        assert 'Resource:' in result.output
        assert 'custom.api.calls' in result.output
        assert 'Price:' in result.output
        assert '0.01 USD per unit' in result.output
    
    def test_pricebook_set_update_existing(self, config_file, pricebook_with_data):
        """Test updating price for existing resource."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'openai.gpt-5.2.input_tokens',
            '--price', '1.80'
        ])
        
        assert result.exit_code == 0
        assert 'Price updated successfully' in result.output
        assert 'openai.gpt-5.2.input_tokens' in result.output
        assert '1.80 USD per unit' in result.output
    
    def test_pricebook_set_with_currency(self, config_file):
        """Test setting price with explicit currency."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'test.resource',
            '--price', '0.05',
            '--currency', 'USD'
        ])
        
        assert result.exit_code == 0
        assert 'Price set successfully' in result.output
        assert '0.05 USD per unit' in result.output
    
    def test_pricebook_set_negative_price(self, config_file):
        """Test setting negative price (should fail)."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'test.resource',
            '--price', '-0.01'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'must be non-negative' in result.output
    
    def test_pricebook_set_invalid_price(self, config_file):
        """Test setting invalid price format."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'test.resource',
            '--price', 'not-a-number'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'Invalid price' in result.output
    
    def test_pricebook_set_too_many_decimals(self, config_file):
        """Test setting price with too many decimal places."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'test.resource',
            '--price', '0.0000001'  # 7 decimal places
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'at most 6 decimal places' in result.output
    
    def test_pricebook_set_empty_resource(self, config_file):
        """Test setting price with empty resource type."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', '',
            '--price', '0.01'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'cannot be empty' in result.output
    
    def test_pricebook_set_invalid_currency(self, config_file):
        """Test setting price with unsupported currency."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'set',
            '--resource', 'test.resource',
            '--price', '0.01',
            '--currency', 'EUR'
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'USD' in result.output
    
    def test_pricebook_import_success(self, config_file, temp_dir):
        """Test importing prices from JSON file."""
        # Create JSON file with prices
        json_file = temp_dir / "prices.json"
        prices_data = {
            "openai.gpt-5.2.input_tokens": {
                "price": "1.75",
                "currency": "USD"
            },
            "openai.gpt-5.2.output_tokens": {
                "price": "14.00",
                "currency": "USD"
            }
        }
        json_file.write_text(json.dumps(prices_data))
        
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', str(json_file)
        ])
        
        assert result.exit_code == 0
        assert 'Successfully imported 2 prices' in result.output
        assert 'Imported resources:' in result.output
        assert 'openai.gpt-5.2.input_tokens' in result.output
        assert '1.75 USD' in result.output
    
    def test_pricebook_import_invalid_json(self, config_file, temp_dir):
        """Test importing from invalid JSON file."""
        # Create invalid JSON file
        json_file = temp_dir / "invalid.json"
        json_file.write_text("{ invalid json }")
        
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', str(json_file)
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'Invalid JSON' in result.output
    
    def test_pricebook_import_empty_json(self, config_file, temp_dir):
        """Test importing from empty JSON file."""
        # Create empty JSON object
        json_file = temp_dir / "empty.json"
        json_file.write_text("{}")
        
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', str(json_file)
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'empty' in result.output
    
    def test_pricebook_import_invalid_price(self, config_file, temp_dir):
        """Test importing with invalid price value."""
        # Create JSON file with invalid price
        json_file = temp_dir / "invalid_price.json"
        prices_data = {
            "test.resource": {
                "price": "-0.01",  # Negative price
                "currency": "USD"
            }
        }
        json_file.write_text(json.dumps(prices_data))
        
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', str(json_file)
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
    
    def test_pricebook_import_missing_price_field(self, config_file, temp_dir):
        """Test importing with missing price field."""
        # Create JSON file with missing price field
        json_file = temp_dir / "missing_price.json"
        prices_data = {
            "test.resource": {
                "currency": "USD"
                # Missing "price" field
            }
        }
        json_file.write_text(json.dumps(prices_data))
        
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', str(json_file)
        ])
        
        assert result.exit_code == 1
        assert 'Error:' in result.output
        assert 'price' in result.output.lower()
    
    def test_pricebook_import_nonexistent_file(self, config_file):
        """Test importing from nonexistent file."""
        runner = CliRunner()
        result = runner.invoke(cli, [
            '--config', config_file,
            'pricebook', 'import',
            '--file', '/nonexistent/file.json'
        ])
        
        # Click should catch this before our code runs
        assert result.exit_code != 0
