"""
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
    Display welcome screen and wait for user action using a menu.
    
    Returns:
        Action key: 'continue', 'new', or 'quit'
    """
    from caracal.flow.components.menu import Menu, MenuItem
    
    console = console or Console()
    
    # Define menu items
    items = [
        MenuItem(
            key="continue",
            label="Continue with Existing Configuration",
            description="Skip onboarding and launch with existing settings",
            icon=Icons.ARROW_RIGHT
        ),
        MenuItem(
            key="new",
            label="Onboarding Wizard",
            description="Set up principals, policies, and first mandate",
            icon=Icons.AUTHORITY
        ),
        MenuItem(
            key="quit",
            label="Quit",
            description="",
            icon="",
        ),
    ]
    
    # Build the banner header with version inline
    banner = BANNER_COMPACT if (console.width < 75) else BANNER
    
    menu = Menu(
        title="",
        items=items,
        show_hints=True,
    )
    
    # Show banner + menu together with no extra gap
    while True:
        console.clear()
        console.print(f"[{Colors.PRIMARY}]{banner}[/]", end="")
        console.print(f"  [{Colors.DIM}]v{__version__}[/]")
        
        result = menu.run()
        
        if result:
            return result.key
            
        return "quit"
