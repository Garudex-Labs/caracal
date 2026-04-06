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

import os
import re
from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.layout import Layout

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState
from caracal.flow.screens._workspace_helpers import get_default_workspace


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
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
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
        edition_adapter = get_deployment_edition_adapter()
        edition_str = edition_adapter.display_name()
        table.add_row("Edition:", f"[{Colors.SUCCESS}]{edition_str}[/]")
        
        # Workspace
        config_mgr = ConfigManager()
        default_ws = get_default_workspace(config_mgr)
        if default_ws:
            table.add_row("Workspace:", f"[{Colors.PRIMARY}]{default_ws.name}[/]")
        else:
            table.add_row("Workspace:", f"[{Colors.WARNING}]None configured[/]")
        
        # PostgreSQL status
        db_status = _resolve_database_status(config_mgr)
        if db_status:
            table.add_row("Database:", f"[{Colors.SUCCESS}]{db_status}[/]")
        else:
            table.add_row("Database:", f"[{Colors.WARNING}]Not configured[/]")
        
    except Exception as e:
        table.add_row("Error:", f"[{Colors.ERROR}]{str(e)}[/]")
    
    return table


def _build_activity_info(state: FlowState) -> Table:
    """Build activity information table."""
    from caracal.deployment.enterprise_license import EnterpriseLicenseValidator
    from caracal.deployment.enterprise_sync import EnterpriseSyncClient
    from caracal.flow.workspace import get_workspace
    
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column("Info", style=Colors.DIM)
    
    try:
        validator = EnterpriseLicenseValidator()
        if validator.is_connected():
            sync_status = EnterpriseSyncClient().get_sync_status()
            last_sync = None
            if isinstance(sync_status, dict):
                cached = sync_status.get("last_sync")
                if isinstance(cached, dict):
                    last_sync = cached.get("timestamp")
                elif cached:
                    last_sync = str(cached)

            if last_sync:
                table.add_row(f"[{Colors.INFO}]Last Sync:[/] {last_sync}")
                table.add_row(f"[{Colors.SUCCESS}]Enterprise connected[/]")
            elif isinstance(sync_status, dict) and sync_status.get("error"):
                table.add_row(f"[{Colors.WARNING}]Sync status unavailable: {sync_status['error']}[/]")
            else:
                table.add_row(f"[{Colors.WARNING}]No sync activity yet[/]")
        else:
            table.add_row(f"[{Colors.DIM}]Enterprise not connected[/]")
        
        # Recent actions are workspace-scoped.
        active_workspace = str(get_workspace().root.resolve())
        workspace_actions = [
            action for action in state.recent_actions
            if action.get("workspace") == active_workspace
        ]

        if workspace_actions:
            table.add_row("")
            table.add_row(f"[{Colors.INFO}]Recent Actions:[/]")
            for action in workspace_actions[:3]:
                icon = Icons.SUCCESS if action.get('success', True) else Icons.ERROR
                color = Colors.SUCCESS if action.get('success', True) else Colors.ERROR
                table.add_row(f"  [{color}]{icon}[/] {action.get('description', 'Unknown')}")
        
    except Exception as e:
        table.add_row(f"[{Colors.ERROR}]Error: {str(e)}[/]")
    
    return table


def _resolve_database_status(config_mgr) -> Optional[str]:
    """Resolve database status from deployment config or active workspace config/env."""
    # Prefer deployment-scoped PostgreSQL config when available.
    postgres_config = config_mgr.get_postgres_config()
    if postgres_config is not None:
        return f"{postgres_config.host}:{postgres_config.port}/{postgres_config.database}"

    # Fallback: check active workspace config and DB-related environment variables.
    try:
        from caracal.flow.workspace import get_workspace

        workspace_config_path = get_workspace().config_path
        has_database_section = False

        if workspace_config_path.exists():
            config_text = workspace_config_path.read_text(encoding="utf-8")
            has_database_section = bool(re.search(r"(?m)^\s*database\s*:", config_text))

        env_keys = (
            "CARACAL_DATABASE_URL",
            "CARACAL_DB_HOST",
            "CARACAL_DB_PORT",
            "CARACAL_DB_NAME",
            "CARACAL_DB_USER",
            "CARACAL_DB_PASSWORD",
        )
        has_db_env = any(bool(os.getenv(key)) for key in env_keys)

        if has_database_section or has_db_env:
            from caracal.config import load_config

            runtime_config = load_config()
            runtime_db = getattr(runtime_config, "database", None)
            if runtime_db:
                return f"{runtime_db.host}:{runtime_db.port}/{runtime_db.database}"
    except Exception:
        return None

    return None
