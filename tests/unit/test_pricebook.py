"""
Unit tests for pricebook management.
"""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from caracal.core.pricebook import PriceEntry, Pricebook
from caracal.exceptions import (
    InvalidPriceError,
    PricebookError,
    PricebookLoadError,
)


class TestPriceEntry:
    """Test PriceEntry dataclass."""

    def test_price_entry_creation(self):
        """Test creating a PriceEntry."""
        entry = PriceEntry(
            resource_type="openai.gpt4.input_tokens",
            price_per_unit=Decimal("0.000030"),
            currency="USD",
            updated_at="2024-01-15T10:00:00Z"
        )
        
        assert entry.resource_type == "openai.gpt4.input_tokens"
        assert entry.price_per_unit == Decimal("0.000030")
        assert entry.currency == "USD"
        assert entry.updated_at == "2024-01-15T10:00:00Z"

    def test_price_entry_to_dict(self):
        """Test converting PriceEntry to dictionary."""
        entry = PriceEntry(
            resource_type="openai.gpt4.input_tokens",
            price_per_unit=Decimal("0.000030"),
            currency="USD",
            updated_at="2024-01-15T10:00:00Z"
        )
        
        data = entry.to_dict()
        assert data["resource_type"] == "openai.gpt4.input_tokens"
        assert data["price_per_unit"] == "0.000030"
        assert data["currency"] == "USD"
        assert data["updated_at"] == "2024-01-15T10:00:00Z"

    def test_price_entry_from_dict(self):
        """Test creating PriceEntry from dictionary."""
        data = {
            "resource_type": "openai.gpt4.input_tokens",
            "price_per_unit": "0.000030",
            "currency": "USD",
            "updated_at": "2024-01-15T10:00:00Z"
        }
        
        entry = PriceEntry.from_dict(data)
        assert entry.resource_type == "openai.gpt4.input_tokens"
        assert entry.price_per_unit == Decimal("0.000030")
        assert entry.currency == "USD"


class TestPricebook:
    """Test Pricebook class."""

    def test_pricebook_initialization_empty(self, temp_dir):
        """Test initializing a Pricebook with no existing file."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        assert pricebook.csv_path == pricebook_path
        assert pricebook.backup_count == 3
        assert len(pricebook.get_all_prices()) == 0

    def test_pricebook_initialization_with_file(self, sample_pricebook_path):
        """Test initializing a Pricebook with existing CSV file."""
        pricebook = Pricebook(str(sample_pricebook_path))
        
        prices = pricebook.get_all_prices()
        assert len(prices) == 4
        assert "openai.gpt4.input_tokens" in prices
        assert "openai.gpt4.output_tokens" in prices

    def test_get_price_existing_resource(self, sample_pricebook_path):
        """Test getting price for an existing resource."""
        pricebook = Pricebook(str(sample_pricebook_path))
        
        price = pricebook.get_price("openai.gpt4.input_tokens")
        assert price == Decimal("0.000030")

    def test_get_price_unknown_resource(self, sample_pricebook_path):
        """Test getting price for unknown resource returns zero."""
        pricebook = Pricebook(str(sample_pricebook_path))
        
        price = pricebook.get_price("unknown.resource")
        assert price == Decimal("0")

    def test_set_price_new_resource(self, temp_dir):
        """Test setting price for a new resource."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        pricebook.set_price(
            "openai.gpt4.input_tokens",
            Decimal("0.000030"),
            "USD"
        )
        
        price = pricebook.get_price("openai.gpt4.input_tokens")
        assert price == Decimal("0.000030")

    def test_set_price_update_existing(self, sample_pricebook_path):
        """Test updating price for existing resource."""
        pricebook = Pricebook(str(sample_pricebook_path))
        
        # Update price
        pricebook.set_price(
            "openai.gpt4.input_tokens",
            Decimal("0.000035"),
            "USD"
        )
        
        price = pricebook.get_price("openai.gpt4.input_tokens")
        assert price == Decimal("0.000035")

    def test_set_price_negative_rejected(self, temp_dir):
        """Test that negative prices are rejected."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        with pytest.raises(InvalidPriceError) as exc_info:
            pricebook.set_price(
                "test.resource",
                Decimal("-0.01"),
                "USD"
            )
        
        assert "non-negative" in str(exc_info.value).lower()

    def test_set_price_too_many_decimals(self, temp_dir):
        """Test that prices with >6 decimal places are rejected."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        with pytest.raises(InvalidPriceError) as exc_info:
            pricebook.set_price(
                "test.resource",
                Decimal("0.0000001"),  # 7 decimal places
                "USD"
            )
        
        assert "6 decimal places" in str(exc_info.value)

    def test_set_price_six_decimals_allowed(self, temp_dir):
        """Test that prices with exactly 6 decimal places are allowed."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        # Should not raise
        pricebook.set_price(
            "test.resource",
            Decimal("0.000001"),  # 6 decimal places
            "USD"
        )
        
        price = pricebook.get_price("test.resource")
        assert price == Decimal("0.000001")

    def test_get_all_prices(self, sample_pricebook_path):
        """Test getting all prices."""
        pricebook = Pricebook(str(sample_pricebook_path))
        
        prices = pricebook.get_all_prices()
        assert len(prices) == 4
        assert isinstance(prices, dict)
        
        # Verify it's a copy (not the internal dict)
        prices["new.resource"] = PriceEntry(
            resource_type="new.resource",
            price_per_unit=Decimal("1.0"),
            currency="USD",
            updated_at="2024-01-15T10:00:00Z"
        )
        assert "new.resource" not in pricebook.get_all_prices()

    def test_import_from_json_valid(self, temp_dir):
        """Test importing prices from valid JSON."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        json_data = {
            "openai.gpt4.input_tokens": {
                "price": "0.000030",
                "currency": "USD"
            },
            "openai.gpt4.output_tokens": {
                "price": "0.000060",
                "currency": "USD"
            }
        }
        
        pricebook.import_from_json(json_data)
        
        assert pricebook.get_price("openai.gpt4.input_tokens") == Decimal("0.000030")
        assert pricebook.get_price("openai.gpt4.output_tokens") == Decimal("0.000060")

    def test_import_from_json_default_currency(self, temp_dir):
        """Test importing prices with default currency."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        json_data = {
            "test.resource": {
                "price": "1.50"
            }
        }
        
        pricebook.import_from_json(json_data)
        
        prices = pricebook.get_all_prices()
        assert prices["test.resource"].currency == "USD"

    def test_import_from_json_invalid_price(self, temp_dir):
        """Test that invalid prices in JSON are rejected."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        json_data = {
            "test.resource": {
                "price": "invalid"
            }
        }
        
        with pytest.raises(InvalidPriceError):
            pricebook.import_from_json(json_data)

    def test_import_from_json_negative_price(self, temp_dir):
        """Test that negative prices in JSON are rejected."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        json_data = {
            "test.resource": {
                "price": "-1.0"
            }
        }
        
        with pytest.raises(InvalidPriceError) as exc_info:
            pricebook.import_from_json(json_data)
        
        assert "non-negative" in str(exc_info.value).lower()

    def test_import_from_json_missing_price(self, temp_dir):
        """Test that JSON without price field is rejected."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        json_data = {
            "test.resource": {
                "currency": "USD"
            }
        }
        
        with pytest.raises(PricebookError) as exc_info:
            pricebook.import_from_json(json_data)
        
        assert "price" in str(exc_info.value).lower()

    def test_import_from_json_atomic(self, temp_dir):
        """Test that import is atomic (all or nothing)."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        # Add initial price
        pricebook.set_price("existing.resource", Decimal("1.0"), "USD")
        
        # Try to import with one invalid price
        json_data = {
            "valid.resource": {
                "price": "2.0"
            },
            "invalid.resource": {
                "price": "-1.0"  # Invalid
            }
        }
        
        with pytest.raises(InvalidPriceError):
            pricebook.import_from_json(json_data)
        
        # Verify no changes were made
        assert "valid.resource" not in pricebook.get_all_prices()
        assert pricebook.get_price("existing.resource") == Decimal("1.0")

    def test_persistence(self, temp_dir):
        """Test that prices are persisted to disk."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        # Set price
        pricebook.set_price(
            "test.resource",
            Decimal("1.50"),
            "USD"
        )
        
        # Verify file was created
        assert pricebook_path.exists()
        
        # Verify file content
        with open(pricebook_path, 'r') as f:
            content = f.read()
        
        assert "test.resource" in content
        assert "1.50" in content

    def test_load_from_disk(self, temp_dir):
        """Test loading prices from disk."""
        pricebook_path = temp_dir / "pricebook.csv"
        
        # Create first pricebook and set price
        pricebook1 = Pricebook(str(pricebook_path))
        pricebook1.set_price("test.resource", Decimal("1.50"), "USD")
        
        # Create second pricebook (should load from disk)
        pricebook2 = Pricebook(str(pricebook_path))
        
        # Verify price was loaded
        price = pricebook2.get_price("test.resource")
        assert price == Decimal("1.50")

    def test_backup_creation(self, temp_dir):
        """Test that backups are created."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path))
        
        # Set first price (creates initial file)
        pricebook.set_price("resource1", Decimal("1.0"), "USD")
        
        # Set second price (should create backup)
        pricebook.set_price("resource2", Decimal("2.0"), "USD")
        
        # Verify backup exists
        backup_path = Path(f"{pricebook_path}.bak.1")
        assert backup_path.exists()

    def test_backup_rotation(self, temp_dir):
        """Test that backups are rotated correctly."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook = Pricebook(str(pricebook_path), backup_count=3)
        
        # Set multiple prices to trigger backup rotation
        for i in range(5):
            pricebook.set_price(f"resource{i}", Decimal(str(i)), "USD")
        
        # Verify backup files exist (up to backup_count)
        backup1 = Path(f"{pricebook_path}.bak.1")
        backup2 = Path(f"{pricebook_path}.bak.2")
        backup3 = Path(f"{pricebook_path}.bak.3")
        backup4 = Path(f"{pricebook_path}.bak.4")
        
        assert backup1.exists()
        assert backup2.exists()
        assert backup3.exists()
        assert not backup4.exists()  # Should not exceed backup_count

    def test_malformed_csv_missing_columns(self, temp_dir):
        """Test that CSV with missing columns raises error."""
        pricebook_path = temp_dir / "pricebook.csv"
        
        # Create malformed CSV (missing updated_at column)
        with open(pricebook_path, 'w') as f:
            f.write("resource_type,price_per_unit,currency\n")
            f.write("test.resource,1.0,USD\n")
        
        with pytest.raises(PricebookLoadError) as exc_info:
            Pricebook(str(pricebook_path))
        
        assert "missing required columns" in str(exc_info.value).lower()

    def test_malformed_csv_invalid_price(self, temp_dir):
        """Test that CSV with invalid price raises error."""
        pricebook_path = temp_dir / "pricebook.csv"
        
        # Create CSV with invalid price
        with open(pricebook_path, 'w') as f:
            f.write("resource_type,price_per_unit,currency,updated_at\n")
            f.write("test.resource,invalid,USD,2024-01-15T10:00:00Z\n")
        
        with pytest.raises(PricebookLoadError):
            Pricebook(str(pricebook_path))

    def test_malformed_csv_negative_price(self, temp_dir):
        """Test that CSV with negative price raises error."""
        pricebook_path = temp_dir / "pricebook.csv"
        
        # Create CSV with negative price
        with open(pricebook_path, 'w') as f:
            f.write("resource_type,price_per_unit,currency,updated_at\n")
            f.write("test.resource,-1.0,USD,2024-01-15T10:00:00Z\n")
        
        with pytest.raises((PricebookLoadError, InvalidPriceError)):
            Pricebook(str(pricebook_path))

    def test_csv_empty_resource_type_skipped(self, temp_dir):
        """Test that rows with empty resource_type are skipped."""
        pricebook_path = temp_dir / "pricebook.csv"
        
        # Create CSV with empty resource_type
        with open(pricebook_path, 'w') as f:
            f.write("resource_type,price_per_unit,currency,updated_at\n")
            f.write(",1.0,USD,2024-01-15T10:00:00Z\n")
            f.write("valid.resource,2.0,USD,2024-01-15T10:00:00Z\n")
        
        pricebook = Pricebook(str(pricebook_path))
        
        # Should only load the valid resource
        prices = pricebook.get_all_prices()
        assert len(prices) == 1
        assert "valid.resource" in prices

    def test_decimal_precision_preserved(self, temp_dir):
        """Test that decimal precision is preserved through save/load."""
        pricebook_path = temp_dir / "pricebook.csv"
        pricebook1 = Pricebook(str(pricebook_path))
        
        # Set price with 6 decimal places
        pricebook1.set_price("test.resource", Decimal("0.000001"), "USD")
        
        # Load in new pricebook
        pricebook2 = Pricebook(str(pricebook_path))
        
        # Verify precision preserved
        price = pricebook2.get_price("test.resource")
        assert price == Decimal("0.000001")
        assert str(price) == "0.000001"
