"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deployment Dashboard Screen.

Provides overview of:
- Current mode and edition
- Active workspace
- Sync status
- Recent activity
- System health
"""

from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.layout import Layout

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState


def show_deployment_dashboard(console: Console, state: FlowState) -> Optional[str]:
    """
    Display deployment dashboard with system overview.
    
    Returns:
        Action to take (None to go back)
    """
    console.clear()
    
    # Create layout
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
        Layout(name="footer", size=3),
    )
    
    # Header
    layout["header"].update(Panel(
        f"[{Colors.PRIMARY}]Deployment Dashboard[/]",
        style=Colors.INFO,
    ))
    
    # Body - split into sections
    body_layout = Layout()
    body_layout.split_row(
        Layout(name="left"),
        Layout(name="right"),
    )
    
    # Left column: Mode, Edition, Workspace
    left_content = _build_system_info()
    body_layout["left"].update(Panel(left_content, title="System Info", border_style=Colors.PRIMARY))
    
    # Right column: Sync status and recent activity
    right_content = _build_activity_info(state)
    body_layout["right"].update(Panel(right_content, title="Activity", border_style=Colors.PRIMARY))
    
    layout["body"].update(body_layout)
    
    # Footer
    layout["footer"].update(Panel(
        f"[{Colors.HINT}]Press Enter to continue | q to go back[/]",
        style=Colors.DIM,
    ))
    
    console.print(layout)
    
    # Wait for input
    try:
        response = input().strip().lower()
        if response == 'q':
            return None
    except (KeyboardInterrupt, EOFError):
        return None
    
    return None


def _build_system_info() -> Table:
    """Build system information table."""
    from caracal.deployment.mode import ModeManager
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.config_manager import ConfigManager
    
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column("Label", style=Colors.INFO)
    table.add_column("Value", style=Colors.NEUTRAL)
    
    try:
        # Mode
        mode_mgr = ModeManager()
        mode = mode_mgr.get_mode()
        mode_str = "Development" if mode.is_dev else "User"
        table.add_row("Mode:", f"[{Colors.SUCCESS}]{mode_str}[/]")
        
        # Edition
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        edition_str = "Enterprise" if edition.is_enterprise else "Open Source"
        table.add_row("Edition:", f"[{Colors.SUCCESS}]{edition_str}[/]")
        
        # Workspace
        config_mgr = ConfigManager()
        workspaces = config_mgr.list_workspaces()
        default_ws = next((ws for ws in workspaces if ws.is_default), None)
        if default_ws:
            table.add_row("Workspace:", f"[{Colors.PRIMARY}]{default_ws.name}[/]")
        else:
            table.add_row("Workspace:", f"[{Colors.WARNING}]None configured[/]")
        
        # PostgreSQL status
        postgres_config = config_mgr.get_postgres_config()
        table.add_row("Database:", f"[{Colors.SUCCESS}]{postgres_config.host}:{postgres_config.port}[/]")
        
    except Exception as e:
        table.add_row("Error:", f"[{Colors.ERROR}]{str(e)}[/]")
    
    return table


def _build_activity_info(state: FlowState) -> Table:
    """Build activity information table."""
    from caracal.deployment.sync_engine import SyncEngine
    from caracal.deployment.config_manager import ConfigManager
    
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column("Info", style=Colors.DIM)
    
    try:
        config_mgr = ConfigManager()
        workspaces = config_mgr.list_workspaces()
        default_ws = next((ws for ws in workspaces if ws.is_default), None)
        
        if default_ws and default_ws.sync_enabled:
            # Sync status
            sync_engine = SyncEngine()
            sync_status = sync_engine.get_sync_status(default_ws.name)
            
            if sync_status.last_sync:
                table.add_row(f"[{Colors.INFO}]Last Sync:[/] {sync_status.last_sync.strftime('%Y-%m-%d %H:%M:%S')}")
            else:
                table.add_row(f"[{Colors.WARNING}]Never synced[/]")
            
            if sync_status.pending_operations > 0:
                table.add_row(f"[{Colors.WARNING}]Pending: {sync_status.pending_operations} operations[/]")
            else:
                table.add_row(f"[{Colors.SUCCESS}]All synced[/]")
        else:
            table.add_row(f"[{Colors.DIM}]Sync not enabled[/]")
        
        # Recent actions
        if state.recent_actions:
            table.add_row("")
            table.add_row(f"[{Colors.INFO}]Recent Actions:[/]")
            for action in state.recent_actions[:3]:
                icon = Icons.SUCCESS if action.get('success', True) else Icons.ERROR
                color = Colors.SUCCESS if action.get('success', True) else Colors.ERROR
                table.add_row(f"  [{color}]{icon}[/] {action.get('description', 'Unknown')}")
        
    except Exception as e:
        table.add_row(f"[{Colors.ERROR}]Error: {str(e)}[/]")
    
    return table
