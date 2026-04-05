"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise Runtime Monitor Screen.

Provides enterprise runtime management:
- View runtime status
- Connect/disconnect enterprise runtime
- Trigger manual runtime sync
"""

from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt, Confirm
from rich.progress import Progress, SpinnerColumn, TextColumn

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.screens._workspace_helpers import get_default_workspace


def show_sync_monitor(console: Console, state: FlowState) -> None:
    """
    Display sync monitor interface.
    
    CLI Equivalent: caracal enterprise [command]
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Enterprise Runtime[/]",
            subtitle=f"[{Colors.HINT}]CLI: caracal enterprise[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Show current sync status
        _show_sync_status(console)
        console.print()
        
        # Build menu
        items = [
            MenuItem("status", "View Runtime Status", "Detailed runtime status", Icons.INFO),
            MenuItem("connect", "Connect Enterprise", "Authenticate to enterprise", Icons.CONNECT),
            MenuItem("disconnect", "Disconnect Enterprise", "Return to Open Source mode", Icons.DISCONNECT),
            MenuItem("sync", "Sync Now", "Trigger runtime sync", Icons.SYNC),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Enterprise Operations", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "status":
            _show_detailed_status(console, state)
        elif result.key == "connect":
            _connect_sync(console, state)
        elif result.key == "disconnect":
            _disconnect_sync(console, state)
        elif result.key == "sync":
            _sync_now(console, state)


def _show_sync_status(console: Console) -> None:
    """Show brief enterprise runtime status."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    try:
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        
        if not default_ws:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspace configured[/]")
            return
        
        if not default_ws.sync_enabled:
            console.print(f"  [{Colors.DIM}]Sync not enabled for workspace: {default_ws.name}[/]")
            return
        
        sync_engine = SyncEngine()
        sync_status = sync_engine.get_sync_status(default_ws.name)
        
        # Build status table
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Label", style=Colors.INFO)
        table.add_column("Value", style=Colors.NEUTRAL)
        
        table.add_row("Workspace:", default_ws.name)
        table.add_row("Remote URL:", sync_status.remote_url or "Not configured")
        
        if sync_status.last_sync_timestamp:
            table.add_row("Last Sync:", sync_status.last_sync_timestamp.strftime("%Y-%m-%d %H:%M:%S"))
        else:
            table.add_row("Last Sync:", f"[{Colors.WARNING}]Never[/]")
        
        pending_count = len(sync_status.pending_operations)
        if pending_count > 0:
            table.add_row("Pending:", f"[{Colors.WARNING}]{pending_count} operations[/]")
        else:
            table.add_row("Pending:", f"[{Colors.SUCCESS}]None[/]")
        
        conflict_count = len(sync_status.conflicts)
        if conflict_count > 0:
            table.add_row("Conflicts:", f"[{Colors.ERROR}]{conflict_count} unresolved[/]")
        
        console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _show_detailed_status(console: Console, state: FlowState) -> None:
    """Show detailed enterprise runtime status."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Enterprise Runtime Status[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal enterprise status[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        
        if not default_ws or not default_ws.sync_enabled:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Sync not enabled[/]")
            input()
            return
        
        sync_engine = SyncEngine()
        sync_status = sync_engine.get_sync_status(default_ws.name)
        
        # Build detailed table
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Property", style=Colors.INFO)
        table.add_column("Value", style=Colors.NEUTRAL)
        
        table.add_row("Workspace", default_ws.name)
        table.add_row("Remote URL", sync_status.remote_url or "Not configured")
        
        if sync_status.last_sync_timestamp:
            table.add_row("Last Sync", sync_status.last_sync_timestamp.strftime("%Y-%m-%d %H:%M:%S"))
        else:
            table.add_row("Last Sync", f"[{Colors.WARNING}]Never[/]")
        
        table.add_row("Pending Operations", str(len(sync_status.pending_operations)))
        table.add_row("Conflicts", str(len(sync_status.conflicts)))
        table.add_row("Local Version", sync_status.local_version or "Unknown")
        table.add_row("Remote Version", sync_status.remote_version or "Unknown")
        
        console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _connect_sync(console: Console, state: FlowState) -> None:
    """Connect enterprise runtime."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    from caracal.deployment.edition import Edition
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
    from caracal.deployment.migration import MigrationManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Connect Enterprise[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal enterprise login <url> <token>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        
        if not default_ws:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspace configured[/]")
            input()
            return
        
        # Prompt for connection details
        url = Prompt.ask(f"[{Colors.INFO}]Enterprise URL[/]")
        token = Prompt.ask(f"[{Colors.INFO}]Authentication token[/]", password=True)
        
        if not url or not token:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} URL and token are required[/]")
            input()
            return
        
        # Connect
        console.print()
        console.print(f"  [{Colors.INFO}]Connecting to enterprise...[/]")
        
        sync_engine = SyncEngine()
        sync_engine.connect(default_ws.name, url, token)

        # Auto-manage edition from connectivity and migrate settings when entering Enterprise.
        try:
            edition_adapter = get_deployment_edition_adapter()
            if not edition_adapter.is_enterprise():
                MigrationManager().migrate_edition(
                    Edition.ENTERPRISE,
                    gateway_url=url,
                    gateway_token=token,
                    migrate_api_keys=True,
                )
        except Exception as migration_error:
            console.print(f"  [{Colors.WARNING}]Migration warning: {migration_error}[/]")
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Connected successfully[/]")
        
        state.add_recent_action(RecentAction.create(
            "enterprise_login",
            f"Connected enterprise runtime for workspace: {default_ws.name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "enterprise_login",
            f"Failed to connect enterprise runtime",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _disconnect_sync(console: Console, state: FlowState) -> None:
    """Disconnect enterprise runtime."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    from caracal.deployment.edition import Edition
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
    from caracal.deployment.migration import MigrationManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Disconnect Enterprise[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal enterprise disconnect[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        
        if not default_ws or not default_ws.sync_enabled:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Sync not enabled[/]")
            input()
            return
        
        edition_adapter = get_deployment_edition_adapter()
        current_is_enterprise = edition_adapter.is_enterprise()

        if current_is_enterprise:
            console.print(f"  [{Colors.WARNING}]Security warning:[/] Disconnecting Enterprise switches to Open Source mode.")
            console.print(f"  [{Colors.WARNING}]Default behavior is a fresh local start without migrating secrets.[/]")
            console.print()

        # Confirm disconnection
        if not Confirm.ask(f"[{Colors.WARNING}]Disconnect enterprise runtime for workspace '{default_ws.name}'?[/]"):
            console.print(f"  [{Colors.DIM}]Cancelled[/]")
            input()
            return

        if current_is_enterprise:
            if not Confirm.ask(f"[{Colors.WARNING}]Confirm switch Enterprise -> Open Source (fresh start)?[/]"):
                console.print(f"  [{Colors.DIM}]Cancelled[/]")
                input()
                return

            # Migrate edition without local secret migration to keep local environment clean by default.
            MigrationManager().migrate_edition(
                Edition.OPENSOURCE,
                migrate_api_keys=False,
            )
        
        # Disconnect
        sync_engine = SyncEngine()
        sync_engine.disconnect(default_ws.name)

        try:
            from caracal.enterprise.license import EnterpriseLicenseValidator

            EnterpriseLicenseValidator().disconnect()
        except Exception:
            pass
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Disconnected successfully[/]")
        if current_is_enterprise:
            console.print(f"  [{Colors.INFO}]Edition switched to Open Source (fresh start policy)[/]")
        
        state.add_recent_action(RecentAction.create(
            "enterprise_disconnect",
            f"Disconnected enterprise runtime for workspace: {default_ws.name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _sync_now(console: Console, state: FlowState) -> None:
    """Trigger enterprise runtime sync."""
    from caracal.deployment.sync_engine import SyncEngine, SyncDirection
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Sync Now[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal enterprise sync[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        
        if not default_ws or not default_ws.sync_enabled:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Sync not enabled[/]")
            input()
            return
        
        # Prompt for direction
        console.print(f"  [{Colors.INFO}]Select sync direction:[/]")
        console.print(f"    1. Bidirectional (push and pull)")
        console.print(f"    2. Push only (upload local changes)")
        console.print(f"    3. Pull only (download remote changes)")
        console.print()
        
        direction_choice = Prompt.ask(
            f"[{Colors.INFO}]Direction[/]",
            choices=["1", "2", "3"],
            default="1"
        )
        
        direction_map = {
            "1": SyncDirection.BIDIRECTIONAL,
            "2": SyncDirection.PUSH,
            "3": SyncDirection.PULL,
        }
        direction = direction_map.get(direction_choice, SyncDirection.BIDIRECTIONAL)
        
        # Perform sync with progress indicator
        console.print()
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task(f"[{Colors.INFO}]Syncing...[/]", total=None)
            
            sync_engine = SyncEngine()
            result = sync_engine.sync_now(default_ws.name, direction=direction)
            
            progress.update(task, completed=True)
        
        # Show results
        console.print()
        if result.success:
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Sync completed successfully[/]")
            console.print(f"    Uploaded: {result.uploaded_count}")
            console.print(f"    Downloaded: {result.downloaded_count}")
            console.print(f"    Conflicts: {result.conflicts_count}")
            console.print(f"    Duration: {result.duration_ms}ms")
            
            state.add_recent_action(RecentAction.create(
                "enterprise_sync",
                f"Synced workspace: {default_ws.name}",
                success=True
            ))
        else:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Sync failed[/]")
            for error in result.errors:
                console.print(f"    - {error}")
            
            state.add_recent_action(RecentAction.create(
                "enterprise_sync",
                f"Sync failed for workspace: {default_ws.name}",
                success=False
            ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


