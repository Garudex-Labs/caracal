"""
Pricebook management for Caracal Core.

This module provides the Pricebook for managing resource prices,
including CSV loading, price lookup, updates, and persistence.
"""

import csv
import json
import os
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, Optional

from caracal.exceptions import (
    InvalidPriceError,
    PricebookError,
    PricebookLoadError,
    FileReadError,
    FileWriteError,
)
from caracal.logging_config import get_logger
from caracal.core.retry import retry_on_transient_failure

logger = get_logger(__name__)


@dataclass
class PriceEntry:
    """
    Represents a price entry for a resource type.
    
    Attributes:
        resource_type: Resource identifier (e.g., "openai.gpt4.input_tokens")
        price_per_unit: Price per unit of resource
        currency: Currency code (e.g., "USD")
        updated_at: Timestamp when price was last updated
    """
    resource_type: str
    price_per_unit: Decimal
    currency: str
    updated_at: str  # ISO 8601 format

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "resource_type": self.resource_type,
            "price_per_unit": str(self.price_per_unit),
            "currency": self.currency,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PriceEntry":
        """Create PriceEntry from dictionary."""
        return cls(
            resource_type=data["resource_type"],
            price_per_unit=Decimal(data["price_per_unit"]),
            currency=data["currency"],
            updated_at=data["updated_at"],
        )


class Pricebook:
    """
    Manages resource pricing with CSV persistence.
    
    Provides methods to load, query, and update resource prices.
    Implements atomic write operations and rolling backups.
    """

    def __init__(self, csv_path: str, backup_count: int = 3):
        """
        Initialize Pricebook.
        
        Args:
            csv_path: Path to the pricebook CSV file
            backup_count: Number of rolling backups to maintain (default: 3)
            
        Raises:
            PricebookLoadError: If CSV file is malformed or cannot be loaded
        """
        self.csv_path = Path(csv_path)
        self.backup_count = backup_count
        self._prices: Dict[str, PriceEntry] = {}
        
        # Ensure parent directory exists
        self.csv_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Load existing pricebook if it exists
        if self.csv_path.exists():
            self._load_from_csv()
        else:
            logger.warning(
                f"Pricebook file not found at {self.csv_path}. "
                "Starting with empty pricebook."
            )

    def get_price(self, resource_type: str) -> Optional[Decimal]:
        """
        Get price for a resource type.
        
        Args:
            resource_type: The resource identifier
            
        Returns:
            Price per unit as Decimal, or None if resource not found
        """
        entry = self._prices.get(resource_type)
        if entry is None:
            logger.warning(
                f"Resource type '{resource_type}' not found in pricebook. "
                "Using default price of 0."
            )
            return Decimal("0")
        return entry.price_per_unit

    def set_price(
        self,
        resource_type: str,
        price_per_unit: Decimal,
        currency: str = "USD"
    ) -> None:
        """
        Set or update price for a resource type.
        
        Args:
            resource_type: The resource identifier
            price_per_unit: Price per unit (must be non-negative)
            currency: Currency code (default: "USD")
            
        Raises:
            InvalidPriceError: If price is negative or has too many decimal places
        """
        # Validate price is non-negative
        if price_per_unit < 0:
            logger.warning(f"Attempted to set negative price for '{resource_type}': {price_per_unit}")
            raise InvalidPriceError(
                f"Price must be non-negative, got {price_per_unit}"
            )
        
        # Validate decimal precision (up to 6 decimal places)
        if price_per_unit.as_tuple().exponent < -6:
            logger.warning(
                f"Attempted to set price with too many decimal places for '{resource_type}': {price_per_unit}"
            )
            raise InvalidPriceError(
                f"Price can have at most 6 decimal places, got {price_per_unit}"
            )
        
        # Create or update price entry
        entry = PriceEntry(
            resource_type=resource_type,
            price_per_unit=price_per_unit,
            currency=currency,
            updated_at=datetime.utcnow().isoformat() + "Z",
        )
        
        self._prices[resource_type] = entry
        
        # Persist to disk
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist pricebook to {self.csv_path}: {e}", exc_info=True)
            raise FileWriteError(
                f"Failed to persist pricebook to {self.csv_path}: {e}"
            ) from e
        
        logger.info(
            f"Updated price for '{resource_type}': "
            f"{price_per_unit} {currency}"
        )

    def get_all_prices(self) -> Dict[str, PriceEntry]:
        """
        Get all price entries as a dictionary.
        
        Returns:
            Dictionary mapping resource_type to PriceEntry
        """
        return self._prices.copy()

    def import_from_json(self, json_data: Dict[str, Any]) -> None:
        """
        Import prices from JSON data structure.
        
        Format: {"resource_type": {"price": "0.000030", "currency": "USD"}}
        
        Args:
            json_data: Dictionary with resource types and price information
            
        Raises:
            InvalidPriceError: If any price is invalid
            PricebookError: If JSON format is invalid
        """
        # Validate all prices before applying any changes
        validated_entries = {}
        
        for resource_type, price_info in json_data.items():
            if not isinstance(price_info, dict):
                logger.error(
                    f"Invalid price info format for '{resource_type}': "
                    f"expected dict, got {type(price_info).__name__}"
                )
                raise PricebookError(
                    f"Invalid price info for '{resource_type}': "
                    f"expected dict, got {type(price_info).__name__}"
                )
            
            if "price" not in price_info:
                logger.error(f"Missing 'price' field for '{resource_type}' in JSON import")
                raise PricebookError(
                    f"Missing 'price' field for '{resource_type}'"
                )
            
            try:
                price = Decimal(str(price_info["price"]))
            except (InvalidOperation, ValueError) as e:
                logger.error(
                    f"Invalid price value for '{resource_type}': {price_info['price']}",
                    exc_info=True
                )
                raise InvalidPriceError(
                    f"Invalid price value for '{resource_type}': "
                    f"{price_info['price']}"
                ) from e
            
            # Validate price is non-negative
            if price < 0:
                logger.error(f"Negative price in JSON import for '{resource_type}': {price}")
                raise InvalidPriceError(
                    f"Price must be non-negative for '{resource_type}', "
                    f"got {price}"
                )
            
            # Validate decimal precision
            if price.as_tuple().exponent < -6:
                raise InvalidPriceError(
                    f"Price can have at most 6 decimal places for "
                    f"'{resource_type}', got {price}"
                )
            
            currency = price_info.get("currency", "USD")
            
            validated_entries[resource_type] = PriceEntry(
                resource_type=resource_type,
                price_per_unit=price,
                currency=currency,
                updated_at=datetime.utcnow().isoformat() + "Z",
            )
        
        # All validations passed, apply changes
        for resource_type, entry in validated_entries.items():
            self._prices[resource_type] = entry
        
        # Persist to disk
        try:
            self._persist()
        except (OSError, IOError) as e:
            logger.error(f"Failed to persist pricebook to {self.csv_path}: {e}", exc_info=True)
            raise FileWriteError(
                f"Failed to persist pricebook to {self.csv_path}: {e}"
            ) from e
        
        logger.info(f"Imported {len(validated_entries)} prices from JSON")

    def _load_from_csv(self) -> None:
        """
        Load prices from CSV file.
        
        Expected CSV format:
        resource_type,price_per_unit,currency,updated_at
        
        Raises:
            PricebookLoadError: If CSV is malformed or cannot be loaded
        """
        try:
            with open(self.csv_path, 'r', newline='') as f:
                reader = csv.DictReader(f)
                
                # Validate CSV has required columns
                required_columns = {
                    "resource_type",
                    "price_per_unit",
                    "currency",
                    "updated_at"
                }
                if reader.fieldnames is None:
                    raise PricebookLoadError(
                        f"CSV file {self.csv_path} is empty or has no header"
                    )
                
                missing_columns = required_columns - set(reader.fieldnames)
                if missing_columns:
                    raise PricebookLoadError(
                        f"CSV file {self.csv_path} missing required columns: "
                        f"{missing_columns}"
                    )
                
                # Load price entries
                self._prices = {}
                for row_num, row in enumerate(reader, start=2):  # Start at 2 (header is row 1)
                    try:
                        resource_type = row["resource_type"].strip()
                        if not resource_type:
                            logger.warning(
                                f"Skipping row {row_num}: empty resource_type"
                            )
                            continue
                        
                        price_per_unit = Decimal(row["price_per_unit"])
                        currency = row["currency"].strip()
                        updated_at = row["updated_at"].strip()
                        
                        # Validate price is non-negative
                        if price_per_unit < 0:
                            raise InvalidPriceError(
                                f"Row {row_num}: Price must be non-negative, "
                                f"got {price_per_unit}"
                            )
                        
                        entry = PriceEntry(
                            resource_type=resource_type,
                            price_per_unit=price_per_unit,
                            currency=currency,
                            updated_at=updated_at,
                        )
                        
                        self._prices[resource_type] = entry
                        
                    except (InvalidOperation, ValueError, KeyError) as e:
                        raise PricebookLoadError(
                            f"Failed to parse row {row_num} in {self.csv_path}: {e}"
                        ) from e
                
                logger.info(
                    f"Loaded {len(self._prices)} prices from {self.csv_path}"
                )
                
        except FileNotFoundError as e:
            raise PricebookLoadError(
                f"Pricebook file not found: {self.csv_path}"
            ) from e
        except csv.Error as e:
            raise PricebookLoadError(
                f"Failed to parse CSV file {self.csv_path}: {e}"
            ) from e
        except Exception as e:
            if isinstance(e, (PricebookLoadError, InvalidPriceError)):
                raise
            raise PricebookLoadError(
                f"Failed to load pricebook from {self.csv_path}: {e}"
            ) from e

    @retry_on_transient_failure(max_retries=3, base_delay=0.1, backoff_factor=2.0)
    def _persist(self) -> None:
        """
        Persist pricebook to disk using atomic write strategy.
        
        Steps:
        1. Create backup of existing file
        2. Write to temporary file (.tmp)
        3. Flush to disk (fsync)
        4. Atomically rename to target file
        
        Implements retry logic with exponential backoff:
        - Retries up to 3 times on transient failures (OSError, IOError)
        - Uses exponential backoff: 0.1s, 0.2s, 0.4s
        - Fails permanently after max retries
        
        Raises:
            OSError: If write operation fails after all retries
        """
        # Create backup before writing
        self._create_backup()
        
        # Write to temporary file
        tmp_path = self.csv_path.with_suffix('.tmp')
        with open(tmp_path, 'w', newline='') as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "resource_type",
                    "price_per_unit",
                    "currency",
                    "updated_at"
                ]
            )
            writer.writeheader()
            
            # Write price entries sorted by resource_type for consistency
            for resource_type in sorted(self._prices.keys()):
                entry = self._prices[resource_type]
                writer.writerow({
                    "resource_type": entry.resource_type,
                    "price_per_unit": str(entry.price_per_unit),
                    "currency": entry.currency,
                    "updated_at": entry.updated_at,
                })
            
            f.flush()
            os.fsync(f.fileno())  # Force write to disk
        
        # Atomic rename (POSIX guarantees atomicity)
        # On Windows, may need to remove target first
        if os.name == 'nt' and self.csv_path.exists():
            self.csv_path.unlink()
        tmp_path.rename(self.csv_path)

    def _create_backup(self) -> None:
        """
        Create rolling backup of pricebook file.
        
        Rotates backups:
        - pricebook.csv.bak.3 -> deleted
        - pricebook.csv.bak.2 -> pricebook.csv.bak.3
        - pricebook.csv.bak.1 -> pricebook.csv.bak.2
        - pricebook.csv -> pricebook.csv.bak.1
        """
        if not self.csv_path.exists():
            return
        
        try:
            # Delete oldest backup if it exists
            oldest_backup = Path(f"{self.csv_path}.bak.{self.backup_count}")
            if oldest_backup.exists():
                oldest_backup.unlink()
            
            # Rotate existing backups (from newest to oldest)
            for i in range(self.backup_count - 1, 0, -1):
                old_backup = Path(f"{self.csv_path}.bak.{i}")
                new_backup = Path(f"{self.csv_path}.bak.{i + 1}")
                
                if old_backup.exists():
                    old_backup.rename(new_backup)
            
            # Create new backup
            backup_path = Path(f"{self.csv_path}.bak.1")
            shutil.copy2(self.csv_path, backup_path)
            
        except Exception as e:
            # Log warning but don't fail the operation
            # Backup failure shouldn't prevent writes
            logger.warning(f"Failed to create backup of pricebook: {e}")
