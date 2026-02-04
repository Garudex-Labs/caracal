"""
Caracal Flow Pricebook Screen.

Pricebook management flows:
- List prices
- Set/Update price
- Import prices
"""

import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.screens.main_menu import show_submenu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def run_pricebook_flow(console: Optional[Console] = None) -> None:
    """Run the pricebook management flow."""
    console = console or Console()
    
    while True:
        console.clear()
        
        action = show_submenu("pricebook", console)
        
        if action is None:
            break
        
        console.clear()
        
        if action == "list":
            _list_prices(console)
        elif action == "set":
            _set_price(console)
        elif action == "import":
            _import_prices(console)
            
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()


def _list_prices(console: Console) -> None:
    """List all prices in the pricebook."""
    console.print(Panel(
        f"[{Colors.NEUTRAL}]View all resource pricing[/]",
        title=f"[bold {Colors.INFO}]Pricebook[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.pricebook import get_pricebook
        from caracal.config import load_config
        
        config = load_config()
        pricebook = get_pricebook(config)
        prices = pricebook.get_all_prices()
        
        if not prices:
            console.print(f"  [{Colors.DIM}]Pricebook is empty.[/]")
            return
        
        # Display table
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Resource Type", style=Colors.NEUTRAL)
        table.add_column("Price/Unit", style=Colors.SUCCESS)
        table.add_column("Currency", style=Colors.DIM)
        table.add_column("Last Updated", style=Colors.DIM)
        
        for resource_type in sorted(prices.keys()):
            entry = prices[resource_type]
            updated = entry.updated_at.replace('T', ' ').replace('Z', '')
            table.add_row(
                entry.resource_type,
                f"{entry.price_per_unit}",
                entry.currency,
                updated
            )
            
        console.print(table)
        console.print()
        console.print(f"  [{Colors.DIM}]Total: {len(prices)} resources[/]")
        
    except Exception as e:
        logger.error(f"Error listing prices: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _set_price(console: Console) -> None:
    """Set or update a price."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Set or update resource price[/]",
        title=f"[bold {Colors.INFO}]Set Price[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.pricebook import get_pricebook
        from caracal.config import load_config
        
        config = load_config()
        pricebook = get_pricebook(config)
        
        # Get existing resources for autocomplete
        existing_prices = pricebook.get_all_prices()
        existing_resources = sorted(list(existing_prices.keys()))
        
        # Prompt for resource
        if existing_resources:
            console.print(f"  [{Colors.INFO}]Select existing resource or type new name:[/]")
            resource = prompt.select(
                "Resource Type", 
                choices=existing_resources,
                default=None
            )
            # FlowPrompt.select forces selection from choices, but we want to allow new values.
            # actually prompt.select forces valid choice. 
            # We should use prompt.text with a completer instead if we want free text + suggestions.
            # But the current FlowPrompt.select IS strict. 
            # Let's use prompt.text with a completer if possible, or just text.
            # Existing FlowPrompt doesn't expose generic completer easily in .text method unless passed.
            # The user asked for autocomplete. 
            # Let's try to use prompt.text with a completer constructed from existing_resources.
            
            from prompt_toolkit.completion import WordCompleter
            completer = WordCompleter(existing_resources, ignore_case=True)
            
            resource = prompt.text(
                "Resource Type (Tab for suggestions)", 
                completer=completer,
                required=True
            )
        else:
            resource = prompt.text("Resource Type", required=True)
            
        # Check if updating
        is_update = resource in existing_prices
        current_price = None
        if is_update:
            current_price = existing_prices[resource].price_per_unit
            console.print(f"  [{Colors.DIM}]Current Price: {current_price} USD[/]")
        
        # Prompt for price
        price_val = prompt.number(
            "Price per unit",
            default=float(current_price) if current_price is not None else None,
            min_value=0.0
        )
        
        # Prompt for currency
        currency = prompt.text("Currency", default="USD")
        
        # Confirm
        action = "Update" if is_update else "Create"
        if not prompt.confirm(f"{action} price for {resource} to {price_val} {currency}?", default=True):
            console.print(f"  [{Colors.DIM}]Cancelled.[/]")
            return
            
        # Set price
        pricebook.set_price(
            resource_type=resource,
            price_per_unit=Decimal(str(price_val)),
            currency=currency
        )
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Price {action.lower()}d successfully![/]")
        
    except Exception as e:
        logger.error(f"Error setting price: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _import_prices(console: Console) -> None:
    """Import prices from JSON file."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Bulk import prices from JSON file[/]",
        title=f"[bold {Colors.INFO}]Import Prices[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        file_path_str = prompt.text("JSON File Path", required=True)
        file_path = Path(file_path_str).expanduser()
        
        if not file_path.exists():
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} File not found: {file_path}[/]")
            return
            
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except json.JSONDecodeError:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Invalid JSON file[/]")
            return
            
        if not prompt.confirm(f"Import {len(data)} prices from {file_path.name}?", default=False):
            return
            
        from caracal.cli.pricebook import get_pricebook
        from caracal.config import load_config
        
        config = load_config()
        pricebook = get_pricebook(config)
        
        pricebook.import_from_json(data)
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Imported {len(data)} prices successfully![/]")
        
    except Exception as e:
        logger.error(f"Error importing prices: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
