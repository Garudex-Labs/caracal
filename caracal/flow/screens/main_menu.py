"""
Caracal Flow Main Menu.

Central navigation hub for all Caracal Flow features:
- Principal Management
- Authority Policy
- Authority Ledger
- Mandate Manager
- Delegation Center
- Enterprise
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
        key="principals",
        label="Principal Hub",
        description="Register, list, and manage principal identities",
        icon=Icons.AGENT,
    ),
    MenuItem(
        key="policies",
        label="Authority Policy",
        description="Create and manage authority policies",
        icon=Icons.POLICY,
    ),
    MenuItem(
        key="ledger",
        label="Authority Ledger",
        description="Query authority events and view audit trail",
        icon=Icons.LEDGER,
    ),
    MenuItem(
        key="mandates",
        label="Mandate Manager",
        description="Issue, validate, and revoke execution mandates",
        icon=Icons.MONEY,
    ),
    MenuItem(
        key="delegation",
        label=" Delegation Center",
        description="Manage mandate delegation and relationships",
        icon="🏛",
    ),
    MenuItem(
        key="enterprise",
        label="Enterprise",
        description="Enterprise features and license management",
        icon="⭐",
    ),
    MenuItem(
        key="settings",
        label="Settings & Config",
        description="Configure Caracal, manage infrastructure, and check service health",
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
    """Show system status in header with real service checks."""
    import socket
    from caracal.flow.theme import Icons

    status_items = []

    try:
        from caracal.config import load_config
        config = load_config()

        # Database status
        if config.database.type == "sqlite":
            status_items.append((Icons.SUCCESS, "DB: SQLite", Colors.SUCCESS))
        else:
            try:
                sock = socket.create_connection(
                    (config.database.host, config.database.port), timeout=1
                )
                sock.close()
                status_items.append((Icons.SUCCESS, "DB: PostgreSQL", Colors.SUCCESS))
            except Exception:
                status_items.append((Icons.ERROR, "DB: Unreachable", Colors.ERROR))

    except Exception:
        status_items.append((Icons.SUCCESS, "System Ready", Colors.SUCCESS))

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
        "principals": [
            MenuItem(key="register", label="Register New Principal", 
                    description="Create a new principal identity", icon=""),
            MenuItem(key="list", label="List Principals", 
                    description="View all registered principals", icon=""),
            MenuItem(key="get", label="Get Principal Details", 
                    description="View details for a specific principal", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "policies": [
            MenuItem(key="create", label="Create Policy", 
                    description="Create a new authority policy", icon=""),
            MenuItem(key="list", label="List Policies", 
                    description="View all authority policies", icon=""),
            MenuItem(key="status", label="Policy Status", 
                    description="Check policy enforcement status", icon=""),
            MenuItem(key="history", label="Policy History", 
                    description="View policy change audit trail", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "ledger": [
            MenuItem(key="query", label="Query Events", 
                    description="Search authority events with filters", icon=""),
            MenuItem(key="summary", label="Authority Summary", 
                    description="View aggregated authority decisions", icon=""),
            MenuItem(key="chain", label="Delegation Chain", 
                    description="Visualize mandate relationships", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "mandates": [
            MenuItem(key="list", label="List Mandates", 
                    description="View all execution mandates", icon=""),
            MenuItem(key="issue", label="Issue Mandate", 
                    description="Create a new execution mandate", icon=""),
            MenuItem(key="validate", label="Validate Mandate", 
                    description="Check mandate validity", icon=""),
            MenuItem(key="revoke", label="Revoke Mandate", 
                    description="Revoke an execution mandate", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "delegation": [
            MenuItem(key="generate", label="Delegate Mandate", 
                    description="Create delegated mandate", icon=""),
            MenuItem(key="list", label="List Delegations", 
                    description="View delegation relationships", icon=""),
            MenuItem(key="validate", label="Validate Chain", 
                    description="Check delegation chain validity", icon=""),
            MenuItem(key="revoke", label="Revoke Delegation", 
                    description="Revoke a delegated mandate", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "enterprise": [
            MenuItem(key="status", label="Enterprise Status", 
                    description="View enterprise license status", icon=""),
            MenuItem(key="connect", label="Connect Enterprise", 
                    description="Connect to Caracal Enterprise", icon=""),
            MenuItem(key="features", label="Enterprise Features", 
                    description="View available enterprise features", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "settings": [
            MenuItem(key="view", label="View Configuration", 
                    description="Display current settings and enabled services", icon=""),
            MenuItem(key="edit", label="Edit Configuration", 
                    description="Open config in system editor", icon=""),
            MenuItem(key="infra", label="Infrastructure Setup", 
                    description="Manage Docker services (start/stop containers)", icon=""),
            MenuItem(key="db-status", label="Database Status", 
                    description="Check database connection", icon=""),
            MenuItem(key="service-health", label="Service Health", 
                    description="Check status of all enabled services", icon=""),
            MenuItem(key="backup", label="Backup Data", 
                    description="Create a backup archive", icon=""),
            MenuItem(key="restore", label="Restore Data", 
                    description="Restore from backup", icon=""),
            MenuItem(key="back", label="Back to Main Menu", 
                    description="", icon=Icons.ARROW_LEFT),
        ],
        "help": [
            MenuItem(key="docs", label="View Documentation", 
                    description="Open Caracal docs", icon=""),
            MenuItem(key="shortcuts", label="Keyboard Shortcuts", 
                    description="View all shortcuts", icon=""),
            MenuItem(key="about", label="About Caracal", 
                    description="Version and license info", icon=""),
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
        "principals": "Principal Hub",
        "policies": "Authority Policy",
        "ledger": "Authority Ledger",
        "mandates": "Mandate Manager",
        "delegation": "Delegation Center",
        "enterprise": "Enterprise",
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
