"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Welcome Screen.

Displays:
- ASCII art banner
- Version info
- Quick action menu
"""

from typing import Optional

from rich.console import Console

from caracal._version import __version__
from caracal.flow.theme import BANNER, BANNER_COMPACT, Colors, Icons


def show_welcome(
    console: Optional[Console] = None,
    compact: bool = False,
) -> None:
    """
    Display the welcome screen.
    
    Args:
        console: Rich console (creates new if not provided)
        compact: Use compact banner for small terminals
    """
    pass


def wait_for_action(console: Optional[Console] = None) -> str:
    """
    Display welcome screen and proceed to workspace setup.
    
    Returns:
        Action key: always returns 'new' to start workspace setup
    """
    console = console or Console()
    
    # Build the banner header with version inline
    banner = BANNER_COMPACT if (console.width < 75) else BANNER
    
    console.clear()
    console.print(f"[{Colors.PRIMARY}]{banner}[/]", end="")
    console.print(f"  [{Colors.DIM}]v{__version__}[/]")
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting Caracal Flow...[/]")
    console.print()
    
    # Wait for user to press enter
    console.print(f"  [{Colors.HINT}]Press Enter to continue or Ctrl+C to quit...[/]")
    try:
        input()
    except (KeyboardInterrupt, EOFError):
        return "quit"
    
    return "new"
