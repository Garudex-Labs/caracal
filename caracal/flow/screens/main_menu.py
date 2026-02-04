"""
Caracal Flow Main Menu.

Central navigation hub for all Caracal Flow features:
- Agent Management
- Policy Management
- Ledger Explorer
- Pricebook Editor
- Delegation Center
- Settings & Config
- Help & Tutorials
"""

from typing import Optional

from rich.console import Console
from rich.panel import Panel

from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons


# Main menu items
MAIN_MENU_ITEMS = [
    MenuItem(
        key="agents",
        label="Agent Management",
        description="Register, list, and manage AI agent identities",
        icon=Icons.AGENT,
    ),
    MenuItem(
        key="policies",
        label="Policy Management",
        description="Create and manage budget policies",
        icon=Icons.POLICY,
    ),
    MenuItem(
        key="ledger",
        label="Ledger Explorer",
        description="Query spending history and view summaries",
        icon=Icons.LEDGER,
    ),
    MenuItem(
        key="pricebook",
        label="Pricebook Editor",
        description="Manage resource prices",
        icon=Icons.MONEY,
    ),
    MenuItem(
        key="delegation",
        label=" Delegation Center",
        description="Manage delegation tokens and relationships",
        icon="🏛",
    ),
    MenuItem(
        key="settings",
        label="Settings & Config",
        description="Configure Caracal and manage database",
        icon=Icons.SETTINGS,
    ),
    MenuItem(
        key="help",
        label="Help & Tutorials",
        description="View documentation and guides",
        icon=Icons.HELP,
    ),
]


def show_main_menu(
    console: Optional[Console] = None,
    show_status: bool = True,
) -> Optional[str]:
    """
    Display the main menu and return selected action.
    
    Args:
        console: Rich console
        show_status: Whether to show system status header
    
    Returns:
        Selected menu key, or None if user quits
    """
    console = console or Console()
    
    # Optional status header
    if show_status:
        _show_status_header(console)
    
    # Create and run menu
    menu = Menu(
        title="Main Menu",
        subtitle="Select an option to get started",
        items=MAIN_MENU_ITEMS,
        show_hints=True,
    )
    
    result = menu.run()
    return result.key if result else None


def _show_status_header(console: Console) -> None:
    """Show system status in header."""
    # This would ideally fetch real status from the system
    # For now, show a placeholder
    from caracal.flow.theme import Icons
    
    status_items = [
        (Icons.SUCCESS, "System Ready", Colors.SUCCESS),
    ]
    
    console.print()
    for icon, text, color in status_items:
        console.print(f"  [{color}]{icon} {text}[/]")
    console.print()


def get_submenu_items(category: str) -> list[MenuItem]:
    """
    Get menu items for a subcategory.
    
    Args:
        category: Main menu category key
    
    Returns:
        List of menu items for the subcategory
    """
    submenus = {
        "agents": [
            MenuItem(key="register", label="Register New Agent", 
                    description="Create a new agent identity", icon="➕"),
            MenuItem(key="list", label="List Agents", 
                    description="View all registered agents", icon="📋"),
            MenuItem(key="get", label="Get Agent Details", 
                    description="View details for a specific agent", icon="🔍"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "policies": [
            MenuItem(key="create", label="Create Policy", 
                    description="Create a new budget policy", icon="➕"),
            MenuItem(key="list", label="List Policies", 
                    description="View all policies", icon="📋"),
            MenuItem(key="status", label="Policy Status", 
                    description="Check budget utilization", icon="📜"),
            MenuItem(key="history", label="Policy History", 
                    description="View policy change audit trail", icon="📜"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "ledger": [
            MenuItem(key="query", label="Query Events", 
                    description="Search ledger events with filters", icon="🔍"),
            MenuItem(key="summary", label="Spending Summary", 
                    description="View aggregated spending", icon="📜"),
            MenuItem(key="chain", label="Delegation Chain", 
                    description="Visualize agent relationships", icon="🏛"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "pricebook": [
            MenuItem(key="list", label="List Prices", 
                    description="View all resource prices", icon="📋"),
            MenuItem(key="set", label="Set Price", 
                    description="Set or update a resource price", icon="✏️"),
            MenuItem(key="import", label="Import Prices", 
                    description="Bulk import from file", icon="📥"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "delegation": [
            MenuItem(key="generate", label=" Generate Token", 
                    description="Create delegation token", icon="🛡️"),
            MenuItem(key="list", label="List Delegations", 
                    description="View delegation relationships", icon="📑"),
            MenuItem(key="validate", label=" Validate Token", 
                    description="Check token validity", icon="🏷️"),
            MenuItem(key="revoke", label="Revoke Delegation", 
                    description="Revoke a delegated budget", icon="🚫"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "settings": [
            MenuItem(key="view", label="View Configuration", 
                    description="Display current settings", icon="👁"),
            MenuItem(key="db-status", label="Database Status", 
                    description="Check database connection", icon="🗄"),
            MenuItem(key="backup", label="Backup Data", 
                    description="Create a backup archive", icon="💾"),
            MenuItem(key="restore", label="Restore Data", 
                    description="Restore from backup", icon="📥"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "help": [
            MenuItem(key="docs", label="View Documentation", 
                    description="Open Caracal docs", icon="📖"),
            MenuItem(key="shortcuts", label="Keyboard Shortcuts", 
                    description="View all shortcuts", icon="⌨"),
            MenuItem(key="about", label="About Caracal", 
                    description="Version and license info", icon="ℹ"),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
    }
    
    return submenus.get(category, [])


def show_submenu(category: str, console: Optional[Console] = None) -> Optional[str]:
    """
    Show a submenu for a category.
    
    Args:
        category: Main menu category key
        console: Rich console
    
    Returns:
        Selected action key, or None if back/quit
    """
    console = console or Console()
    
    items = get_submenu_items(category)
    if not items:
        return None
    
    titles = {
        "agents": "Agent Management",
        "policies": "Policy Management",
        "ledger": "Ledger Explorer",
        "pricebook": "Pricebook Editor",
        "delegation": "Delegation Center",
        "settings": "Settings & Config",
        "help": "Help & Tutorials",
    }
    
    menu = Menu(
        title=titles.get(category, category.title()),
        items=items,
        show_hints=True,
    )
    
    result = menu.run()
    
    if result and result.key != "back":
        return result.key
    return None
