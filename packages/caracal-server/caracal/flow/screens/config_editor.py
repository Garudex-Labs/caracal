"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Configuration Editor Screen.

Provides configuration management:
- View configuration
- Edit mode and edition
- Manage PostgreSQL settings
- Configure system settings
"""

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt, Confirm

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.screens._workspace_helpers import get_default_workspace


def show_config_editor(console: Console, state: FlowState) -> None:
    """
    Display configuration editor interface.
    
    CLI Equivalent: caracal config [command]
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Configuration Editor[/]",
            subtitle=f"[{Colors.HINT}]CLI: caracal config[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Build menu
        items = [
            MenuItem("view", "View Configuration", "Show current settings", Icons.INFO),
            MenuItem("mode", "Set Mode", "Development or User mode", Icons.SETTINGS),
            MenuItem("postgres", "PostgreSQL Settings", "Configure database", Icons.DATABASE),
            MenuItem("system", "System Settings", "General configuration", Icons.SETTINGS),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Configuration Options", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "view":
            _view_configuration(console, state)
        elif result.key == "mode":
            _set_mode(console, state)
        elif result.key == "postgres":
            _configure_postgres(console, state)
        elif result.key == "system":
            _configure_system(console, state)


def _view_configuration(console: Console, state: FlowState) -> None:
    """View current configuration."""
    from caracal.deployment.mode import ModeManager
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Current Configuration[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal config list[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        # Mode
        mode_mgr = ModeManager()
        mode = mode_mgr.get_mode()
        mode_str = "Development" if mode.is_dev else "User"
        
        console.print(f"  [{Colors.INFO}]Mode:[/] [{Colors.SUCCESS}]{mode_str}[/]")
        
        # Edition
        edition_adapter = get_deployment_edition_adapter()
        edition_str = edition_adapter.display_name()
        
        console.print(f"  [{Colors.INFO}]Edition:[/] [{Colors.SUCCESS}]{edition_str}[/]")
        console.print()
        
        # Workspace
        config_mgr = ConfigManager()
        default_workspace = get_default_workspace(config_mgr)
        
        if default_workspace:
            console.print(f"  [{Colors.INFO}]Active Workspace:[/] [{Colors.PRIMARY}]{default_workspace.name}[/]")
        else:
            console.print(f"  [{Colors.WARNING}]No workspace configured[/]")
        
        console.print()
        
        # PostgreSQL
        postgres_config = config_mgr.get_postgres_config()
        console.print(f"  [{Colors.INFO}]PostgreSQL:[/]")
        if postgres_config is None:
            console.print(f"    [{Colors.WARNING}]Not configured[/]")
        else:
            console.print(f"    Host: [{Colors.DIM}]{postgres_config.host}:{postgres_config.port}[/]")
            console.print(f"    Database: [{Colors.DIM}]{postgres_config.database}[/]")
            console.print(f"    User: [{Colors.DIM}]{postgres_config.user}[/]")
            console.print(f"    SSL Mode: [{Colors.DIM}]{postgres_config.ssl_mode}[/]")
            console.print(f"    Pool Size: [{Colors.DIM}]{postgres_config.pool_size}[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _set_mode(console: Console, state: FlowState) -> None:
    """Set installation mode."""
    from caracal.deployment.mode import ModeManager, Mode
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Set Installation Mode[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal config mode [dev|user][/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        mode_mgr = ModeManager()
        current_mode = mode_mgr.get_mode()
        
        console.print(f"  [{Colors.INFO}]Current mode:[/] {'Development' if current_mode.is_dev else 'User'}")
        console.print()
        console.print(f"  [{Colors.INFO}]Select mode:[/]")
        console.print(f"    1. Development (load code from repository)")
        console.print(f"    2. User (load code from installed package)")
        console.print()
        
        choice = Prompt.ask(
            f"[{Colors.INFO}]Mode[/]",
            choices=["1", "2"],
            default="2"
        )
        
        new_mode = Mode.DEVELOPMENT if choice == "1" else Mode.USER
        
        if new_mode != current_mode:
            mode_mgr.set_mode(new_mode)
            
            console.print()
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mode set to: {'Development' if new_mode.is_dev else 'User'}[/]")
            console.print(f"  [{Colors.WARNING}]Note: Restart required for changes to take effect[/]")
            
            state.add_recent_action(RecentAction.create(
                "mode_set",
                f"Changed mode to: {'Development' if new_mode.is_dev else 'User'}",
                success=True
            ))
        else:
            console.print()
            console.print(f"  [{Colors.DIM}]Mode unchanged[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _set_edition(console: Console, state: FlowState) -> None:
    """Show auto edition policy information."""
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Edition (Auto)[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal config edition[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_adapter = get_deployment_edition_adapter()

        console.print(f"  [{Colors.INFO}]Current edition:[/] {edition_adapter.display_name()} [dim](auto)[/]")
        console.print()
        console.print(f"  [{Colors.INFO}]Edition is automatically determined by connectivity:[/]")
        console.print(f"    - [{Colors.SUCCESS}]Enterprise[/] when connected via [bold]caracal enterprise login[/bold]")
        console.print(f"    - [{Colors.SUCCESS}]Open Source[/] after [bold]caracal enterprise disconnect[/bold]")
        console.print()
        console.print(f"  [{Colors.DIM}]Manual edition switching is disabled for security and consistency.[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _configure_postgres(console: Console, state: FlowState) -> None:
    """Configure PostgreSQL settings."""
    from caracal.deployment.config_manager import ConfigManager, PostgresConfig
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]PostgreSQL Configuration[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal config set postgres.*[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        current_config = config_mgr.get_postgres_config()
        if current_config is None:
            current_config = PostgresConfig(
                host="localhost",
                port=5432,
                database="caracal",
                user="caracal",
                password_ref="postgres_password",
                ssl_mode="require",
                pool_size=10,
                max_overflow=5,
                pool_timeout=30,
            )
        
        console.print(f"  [{Colors.INFO}]Current PostgreSQL configuration:[/]")
        console.print(f"    Host: {current_config.host}")
        console.print(f"    Port: {current_config.port}")
        console.print(f"    Database: {current_config.database}")
        console.print(f"    User: {current_config.user}")
        console.print()
        
        if not Confirm.ask(f"[{Colors.INFO}]Update PostgreSQL configuration?[/]"):
            return
        
        # Prompt for new values
        console.print()
        host = Prompt.ask(f"[{Colors.INFO}]Host[/]", default=current_config.host)
        port = Prompt.ask(f"[{Colors.INFO}]Port[/]", default=str(current_config.port))
        database = Prompt.ask(f"[{Colors.INFO}]Database[/]", default=current_config.database)
        user = Prompt.ask(f"[{Colors.INFO}]User[/]", default=current_config.user)
        password = Prompt.ask(f"[{Colors.INFO}]Password[/]", password=True)
        
        ssl_mode = Prompt.ask(
            f"[{Colors.INFO}]SSL Mode[/]",
            choices=["disable", "require", "verify-ca", "verify-full"],
            default=current_config.ssl_mode
        )
        
        # Create new config
        new_config = PostgresConfig(
            host=host,
            port=int(port),
            database=database,
            user=user,
            password_ref=current_config.password_ref or "postgres_password",
            ssl_mode=ssl_mode,
            pool_size=current_config.pool_size,
            max_overflow=current_config.max_overflow,
            pool_timeout=current_config.pool_timeout,
        )
        
        # Test connection
        console.print()
        console.print(f"  [{Colors.INFO}]Testing connection...[/]")
        
        # Save configuration and persist password in workspace vault when provided.
        config_mgr.set_postgres_config(new_config)
        if password:
            default_workspace = get_default_workspace(config_mgr)
            if default_workspace is not None:
                config_mgr.store_secret(new_config.password_ref, password, default_workspace.name)
            else:
                console.print(f"  [{Colors.WARNING}]No workspace found; password was not stored[/]")
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL configuration updated[/]")
        
        state.add_recent_action(RecentAction.create(
            "postgres_config",
            "Updated PostgreSQL configuration",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "postgres_config",
            "Failed to update PostgreSQL configuration",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _configure_system(console: Console, state: FlowState) -> None:
    """Configure system settings."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]System Settings[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal config set <key> <value>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    console.print(f"  [{Colors.INFO}]System settings can be configured via:[/]")
    console.print(f"    - Configuration file: ~/.caracal/config.toml")
    console.print(f"    - CLI: caracal config set <key> <value>")
    console.print()
    console.print(f"  [{Colors.HINT}]Common settings:[/]")
    console.print(f"    - log_level: DEBUG, INFO, WARNING, ERROR")
    console.print(f"    - cache_enabled: true, false")
    console.print(f"    - metrics_enabled: true, false")
    console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()
