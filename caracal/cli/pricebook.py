"""
CLI commands for pricebook management.

Provides commands for listing, getting, setting, and importing resource prices.
"""

import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

import click

from caracal.core.pricebook import Pricebook
from caracal.exceptions import (
    CaracalError,
    InvalidPriceError,
    PricebookError,
)


def get_pricebook(config) -> Pricebook:
    """
    Create Pricebook instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        Pricebook instance
    """
    pricebook_path = Path(config.storage.pricebook).expanduser()
    backup_count = config.storage.backup_count
    return Pricebook(str(pricebook_path), backup_count=backup_count)


@click.command('list')
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_prices(ctx, format: str):
    """
    List all resource prices in the pricebook.
    
    Displays all resources with their prices, currencies, and last update times.
    
    Examples:
    
        caracal pricebook list
        
        caracal pricebook list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Suppress logging for JSON output
        if format.lower() == 'json':
            import logging
            logging.getLogger('caracal').setLevel(logging.CRITICAL)
        
        # Create pricebook
        pricebook = get_pricebook(cli_ctx.config)
        
        # Get all prices
        prices = pricebook.get_all_prices()
        
        if not prices:
            click.echo("No prices in pricebook.")
            return
        
        if format.lower() == 'json':
            # JSON output
            output = {
                resource_type: entry.to_dict()
                for resource_type, entry in prices.items()
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Total resources: {len(prices)}")
            click.echo()
            
            # Calculate column widths
            max_resource_len = max(len(entry.resource_type) for entry in prices.values())
            max_price_len = max(len(str(entry.price_per_unit)) for entry in prices.values())
            
            # Ensure minimum widths for headers
            resource_width = max(max_resource_len, len("Resource Type"))
            price_width = max(max_price_len, len("Price/Unit"))
            
            # Print header
            header = (
                f"{'Resource Type':<{resource_width}}  "
                f"{'Price/Unit':>{price_width}}  "
                f"{'Currency':<8}  "
                f"Last Updated"
            )
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print prices sorted by resource type
            for resource_type in sorted(prices.keys()):
                entry = prices[resource_type]
                # Format updated_at to be more readable
                updated = entry.updated_at.replace('T', ' ').replace('Z', '')
                
                click.echo(
                    f"{entry.resource_type:<{resource_width}}  "
                    f"{entry.price_per_unit:>{price_width}}  "
                    f"{entry.currency:<8}  "
                    f"{updated}"
                )
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('get')
@click.option(
    '--resource',
    '-r',
    required=True,
    help='Resource type to retrieve price for',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def get_price(ctx, resource: str, format: str):
    """
    Get price for a specific resource type.
    
    Retrieves and displays the price information for a single resource.
    
    Examples:
    
        caracal pricebook get --resource openai.gpt-5.2.input_tokens
        
        caracal pricebook get -r openai.gpt-5.2.input_tokens --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Suppress logging for JSON output
        if format.lower() == 'json':
            import logging
            logging.getLogger('caracal').setLevel(logging.CRITICAL)
        
        # Create pricebook
        pricebook = get_pricebook(cli_ctx.config)
        
        # Get all prices to check if resource exists
        prices = pricebook.get_all_prices()
        
        if resource not in prices:
            click.echo(
                f"Resource '{resource}' not found in pricebook.\n"
                f"Default price of 0 will be used for this resource.",
                err=True
            )
            sys.exit(1)
        
        entry = prices[resource]
        
        if format.lower() == 'json':
            # JSON output
            click.echo(json.dumps(entry.to_dict(), indent=2))
        else:
            # Table output
            click.echo("Resource Price Details")
            click.echo("=" * 50)
            click.echo(f"Resource:      {entry.resource_type}")
            click.echo(f"Price:         {entry.price_per_unit} {entry.currency} per unit")
            click.echo(f"Last Updated:  {entry.updated_at}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('set')
@click.option(
    '--resource',
    '-r',
    required=True,
    help='Resource type to set price for',
)
@click.option(
    '--price',
    '-p',
    required=True,
    type=str,
    help='Price per unit (e.g., 0.000030)',
)
@click.option(
    '--currency',
    '-c',
    default='USD',
    help='Currency code (default: USD)',
)
@click.pass_context
def set_price(ctx, resource: str, price: str, currency: str):
    """
    Set or update price for a resource type.
    
    Creates or updates the price for a resource in the pricebook.
    Automatically creates a backup before updating.
    
    Examples:
    
        caracal pricebook set --resource openai.gpt-5.2.input_tokens --price 1.75
        
        caracal pricebook set -r custom.api.calls -p 0.01 -c USD
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Validate resource type is not empty
        if not resource or not resource.strip():
            click.echo("Error: Resource type cannot be empty", err=True)
            sys.exit(1)
        
        resource = resource.strip()
        
        # Validate and parse price
        try:
            price_decimal = Decimal(price)
        except (InvalidOperation, ValueError):
            click.echo(
                f"Error: Invalid price '{price}'. Must be a valid number.",
                err=True
            )
            sys.exit(1)
        
        # Validate price is non-negative
        if price_decimal < 0:
            click.echo(
                f"Error: Price must be non-negative, got {price}",
                err=True
            )
            sys.exit(1)
        
        # Validate decimal precision (up to 6 decimal places)
        if price_decimal.as_tuple().exponent < -6:
            click.echo(
                f"Error: Price can have at most 6 decimal places, got {price}",
                err=True
            )
            sys.exit(1)
        
        # Validate currency (v0.1 only supports USD)
        if currency.upper() != 'USD':
            click.echo(
                f"Error: Only 'USD' currency is supported in v0.1, got '{currency}'",
                err=True
            )
            sys.exit(1)
        
        # Create pricebook
        pricebook = get_pricebook(cli_ctx.config)
        
        # Check if this is an update or new entry
        existing_prices = pricebook.get_all_prices()
        is_update = resource in existing_prices
        
        # Set price
        pricebook.set_price(
            resource_type=resource,
            price_per_unit=price_decimal,
            currency=currency.upper()
        )
        
        # Display success message
        action = "updated" if is_update else "set"
        click.echo(f"✓ Price {action} successfully!")
        click.echo()
        click.echo(f"Resource:  {resource}")
        click.echo(f"Price:     {price_decimal} {currency.upper()} per unit")
        
    except InvalidPriceError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('import')
@click.option(
    '--file',
    '-f',
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help='Path to JSON file with prices to import',
)
@click.pass_context
def import_prices(ctx, file: Path):
    """
    Import prices from a JSON file for bulk updates.
    
    Imports multiple resource prices from a JSON file. All prices are validated
    before any changes are applied (atomic operation).
    
    JSON format:
    {
      "openai.gpt-5.2.input_tokens": {
        "price": "1.75",
        "currency": "USD"
      },
      "openai.gpt-5.2.output_tokens": {
        "price": "14.00",
        "currency": "USD"
      }
    }
    
    Examples:
    
        caracal pricebook import --file prices.json
        
        caracal pricebook import -f /path/to/prices.json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Load JSON file
        try:
            with open(file, 'r') as f:
                json_data = json.load(f)
        except json.JSONDecodeError as e:
            click.echo(
                f"Error: Invalid JSON file: {e}",
                err=True
            )
            sys.exit(1)
        except Exception as e:
            click.echo(
                f"Error: Failed to read file '{file}': {e}",
                err=True
            )
            sys.exit(1)
        
        # Validate JSON structure
        if not isinstance(json_data, dict):
            click.echo(
                "Error: JSON file must contain an object with resource types as keys",
                err=True
            )
            sys.exit(1)
        
        if not json_data:
            click.echo("Error: JSON file is empty", err=True)
            sys.exit(1)
        
        # Create pricebook
        pricebook = get_pricebook(cli_ctx.config)
        
        # Import prices (validates all before applying)
        pricebook.import_from_json(json_data)
        
        # Display success message
        click.echo(f"✓ Successfully imported {len(json_data)} prices!")
        click.echo()
        click.echo("Imported resources:")
        for resource_type in sorted(json_data.keys()):
            price_info = json_data[resource_type]
            price = price_info.get("price", "N/A")
            currency = price_info.get("currency", "USD")
            click.echo(f"  {resource_type}: {price} {currency}")
        
    except InvalidPriceError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except PricebookError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
