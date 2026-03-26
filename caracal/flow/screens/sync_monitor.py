"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Sync Monitor Screen.

Provides sync management:
- View sync status
- Connect/disconnect sync
- Trigger manual sync
- View conflict history
- Configure auto-sync
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
    
    CLI Equivalent: caracal sync [command]
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Sync Monitor[/]",
            subtitle=f"[{Colors.HINT}]CLI: caracal sync[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Show current sync status
        _show_sync_status(console)
        console.print()
        
        # Build menu
        items = [
            MenuItem("status", "View Sync Status", "Detailed sync information", Icons.INFO),
            MenuItem("connect", "Connect Sync", "Connect to enterprise", Icons.CONNECT),
            MenuItem("disconnect", "Disconnect Sync", "Disconnect from enterprise", Icons.DISCONNECT),
            MenuItem("sync", "Sync Now", "Trigger manual sync", Icons.SYNC),
            MenuItem("conflicts", "View Conflicts", "Show conflict history", Icons.WARNING),
            MenuItem("auto", "Configure Auto-Sync", "Enable/disable auto-sync", Icons.SETTINGS),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Sync Operations", items=items)
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
        elif result.key == "conflicts":
            _view_conflicts(console, state)
        elif result.key == "auto":
            _configure_auto_sync(console, state)


def _show_sync_status(console: Console) -> None:
    """Show brief sync status."""
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
        table.add_row("Remote URL:", default_ws.sync_url or "Not configured")
        
        if sync_status.last_sync:
            table.add_row("Last Sync:", sync_status.last_sync.strftime("%Y-%m-%d %H:%M:%S"))
        else:
            table.add_row("Last Sync:", f"[{Colors.WARNING}]Never[/]")
        
        if sync_status.pending_operations > 0:
            table.add_row("Pending:", f"[{Colors.WARNING}]{sync_status.pending_operations} operations[/]")
        else:
            table.add_row("Pending:", f"[{Colors.SUCCESS}]None[/]")
        
        if sync_status.conflicts_count > 0:
            table.add_row("Conflicts:", f"[{Colors.ERROR}]{sync_status.conflicts_count} unresolved[/]")
        
        console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _show_detailed_status(console: Console, state: FlowState) -> None:
    """Show detailed sync status."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Sync Status[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync status[/]",
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
        table.add_row("Remote URL", default_ws.sync_url or "Not configured")
        table.add_row("Sync Direction", default_ws.sync_direction.value if default_ws.sync_direction else "bidirectional")
        table.add_row("Auto-Sync", "Enabled" if default_ws.auto_sync_interval else "Disabled")
        
        if default_ws.auto_sync_interval:
            table.add_row("Auto-Sync Interval", f"{default_ws.auto_sync_interval}s")
        
        if sync_status.last_sync:
            table.add_row("Last Sync", sync_status.last_sync.strftime("%Y-%m-%d %H:%M:%S"))
        else:
            table.add_row("Last Sync", f"[{Colors.WARNING}]Never[/]")
        
        table.add_row("Pending Operations", str(sync_status.pending_operations))
        table.add_row("Conflicts", str(sync_status.conflicts_count))
        table.add_row("Local Version", sync_status.local_version or "Unknown")
        table.add_row("Remote Version", sync_status.remote_version or "Unknown")
        
        console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _connect_sync(console: Console, state: FlowState) -> None:
    """Connect sync to enterprise."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    from caracal.deployment.edition import EditionManager, Edition
    from caracal.deployment.migration import MigrationManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Connect Sync[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync connect <url> <token>[/]",
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
            current_edition = EditionManager().get_edition()
            if current_edition != Edition.ENTERPRISE:
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
            "sync_connect",
            f"Connected sync for workspace: {default_ws.name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "sync_connect",
            f"Failed to connect sync",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _disconnect_sync(console: Console, state: FlowState) -> None:
    """Disconnect sync from enterprise."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    from caracal.deployment.edition import EditionManager, Edition
    from caracal.deployment.migration import MigrationManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Disconnect Sync[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync disconnect[/]",
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
        
        current_edition = EditionManager().get_edition()

        if current_edition == Edition.ENTERPRISE:
            console.print(f"  [{Colors.WARNING}]Security warning:[/] Disconnecting Enterprise switches to Open Source mode.")
            console.print(f"  [{Colors.WARNING}]Default behavior is a fresh local start without migrating secrets.[/]")
            console.print()

        # Confirm disconnection
        if not Confirm.ask(f"[{Colors.WARNING}]Disconnect sync for workspace '{default_ws.name}'?[/]"):
            console.print(f"  [{Colors.DIM}]Cancelled[/]")
            input()
            return

        if current_edition == Edition.ENTERPRISE:
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
        if current_edition == Edition.ENTERPRISE:
            console.print(f"  [{Colors.INFO}]Edition switched to Open Source (fresh start policy)[/]")
        
        state.add_recent_action(RecentAction.create(
            "sync_disconnect",
            f"Disconnected sync for workspace: {default_ws.name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _sync_now(console: Console, state: FlowState) -> None:
    """Trigger manual sync."""
    from caracal.deployment.sync_engine import SyncEngine, SyncDirection
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Sync Now[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync now[/]",
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
                "sync_now",
                f"Synced workspace: {default_ws.name}",
                success=True
            ))
        else:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Sync failed[/]")
            for error in result.errors:
                console.print(f"    - {error}")
            
            state.add_recent_action(RecentAction.create(
                "sync_now",
                f"Sync failed for workspace: {default_ws.name}",
                success=False
            ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _view_conflicts(console: Console, state: FlowState) -> None:
    """View conflict history."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Conflict History[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync conflicts[/]",
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
        conflicts = sync_engine.get_conflict_history(default_ws.name, limit=20)
        
        if not conflicts:
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} No conflicts found[/]")
        else:
            table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
            table.add_column("Entity", style=Colors.PRIMARY)
            table.add_column("Type", style=Colors.INFO)
            table.add_column("Local Time", style=Colors.DIM)
            table.add_column("Remote Time", style=Colors.DIM)
            table.add_column("Resolution", style=Colors.NEUTRAL)
            
            for conflict in conflicts:
                resolution = conflict.resolution.value if conflict.resolution else "Pending"
                resolution_color = Colors.SUCCESS if conflict.resolution else Colors.WARNING
                
                table.add_row(
                    conflict.entity_id[:20] + "..." if len(conflict.entity_id) > 20 else conflict.entity_id,
                    conflict.entity_type,
                    conflict.local_timestamp.strftime("%Y-%m-%d %H:%M"),
                    conflict.remote_timestamp.strftime("%Y-%m-%d %H:%M"),
                    f"[{resolution_color}]{resolution}[/]"
                )
            
            console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _configure_auto_sync(console: Console, state: FlowState) -> None:
    """Configure auto-sync settings."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Configure Auto-Sync[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal sync auto-enable / auto-disable[/]",
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
        
        # Show current status
        if default_ws.auto_sync_interval:
            console.print(f"  [{Colors.INFO}]Auto-sync is currently enabled[/]")
            console.print(f"  Interval: {default_ws.auto_sync_interval} seconds")
        else:
            console.print(f"  [{Colors.DIM}]Auto-sync is currently disabled[/]")
        
        console.print()
        
        # Prompt for action
        if default_ws.auto_sync_interval:
            if Confirm.ask(f"[{Colors.INFO}]Disable auto-sync?[/]"):
                sync_engine = SyncEngine()
                sync_engine.disable_auto_sync(default_ws.name)
                
                console.print()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Auto-sync disabled[/]")
                
                state.add_recent_action(RecentAction.create(
                    "auto_sync_disable",
                    f"Disabled auto-sync for workspace: {default_ws.name}",
                    success=True
                ))
        else:
            if Confirm.ask(f"[{Colors.INFO}]Enable auto-sync?[/]"):
                interval = Prompt.ask(
                    f"[{Colors.INFO}]Sync interval (seconds)[/]",
                    default="300"
                )
                
                try:
                    interval_int = int(interval)
                    if interval_int < 60:
                        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Minimum interval is 60 seconds[/]")
                        interval_int = 60
                    
                    sync_engine = SyncEngine()
                    sync_engine.enable_auto_sync(default_ws.name, interval_seconds=interval_int)
                    
                    console.print()
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Auto-sync enabled (interval: {interval_int}s)[/]")
                    
                    state.add_recent_action(RecentAction.create(
                        "auto_sync_enable",
                        f"Enabled auto-sync for workspace: {default_ws.name}",
                        success=True
                    ))
                except ValueError:
                    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Invalid interval value[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()
