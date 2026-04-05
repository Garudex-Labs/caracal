"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workspace Manager Screen.

Provides workspace management:
- List workspaces
- Create workspace
- Switch workspace
- Delete workspace
- Export/import workspace
"""

import os
import time
from pathlib import Path
from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt, Confirm

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.screens._workspace_helpers import list_workspace_configs, set_default_workspace


_CONTAINER_RUNTIME_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
_HOST_IO_ROOT_ENV = "CARACAL_HOST_IO_ROOT"
_DEFAULT_HOST_IO_ROOT = Path("/caracal-host-io")


def _in_container_runtime() -> bool:
    return os.environ.get(_CONTAINER_RUNTIME_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def _host_io_root() -> Path:
    return Path(os.environ.get(_HOST_IO_ROOT_ENV, str(_DEFAULT_HOST_IO_ROOT))).resolve(strict=False)


def _resolve_workspace_transfer_path(raw_path: str) -> Path:
    candidate = Path(raw_path).expanduser()
    if not _in_container_runtime():
        return candidate.resolve(strict=False)

    root = _host_io_root()
    if candidate.is_absolute():
        resolved = candidate.resolve(strict=False)
        if resolved == root or root in resolved.parents:
            return resolved
        raise ValueError(
            f"In container runtime, workspace import/export paths must be under {root}."
        )

    return (root / candidate).resolve(strict=False)


def _default_export_path(workspace_name: str) -> str:
    if _in_container_runtime():
        return str((_host_io_root() / f"{workspace_name}_export.tar.gz").resolve(strict=False))
    return f"./{workspace_name}_export.tar.gz"


def _path_scope_label(path: Path) -> str:
    if not _in_container_runtime():
        return "host path"

    root = _host_io_root()
    if path == root or root in path.parents:
        return "container path (host-shared mount)"
    return "container path"


def show_workspace_manager(console: Console, state: FlowState) -> None:
    """
    Display workspace manager interface.
    
    CLI Equivalent: caracal workspace [command]
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Workspace Manager[/]",
            subtitle=f"[{Colors.HINT}]CLI: caracal workspace[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Build menu
        items = [
            MenuItem("list", "List Workspaces", "View all workspaces", Icons.LIST),
            MenuItem("create", "Create Workspace", "Create new workspace", Icons.ADD),
            MenuItem("switch", "Switch Workspace", "Change active workspace", Icons.SWITCH),
            MenuItem("delete", "Delete Workspace", "Remove workspace", Icons.DELETE),
            MenuItem("export", "Export Workspace", "Backup workspace", Icons.EXPORT),
            MenuItem("import", "Import Workspace", "Restore workspace", Icons.IMPORT),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Workspace Operations", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "list":
            _list_workspaces(console, state)
        elif result.key == "create":
            _create_workspace(console, state)
        elif result.key == "switch":
            _switch_workspace(console, state)
        elif result.key == "delete":
            _delete_workspace(console, state)
        elif result.key == "export":
            _export_workspace(console, state)
        elif result.key == "import":
            _import_workspace(console, state)


def _list_workspaces(console: Console, state: FlowState) -> None:
    """List all workspaces."""
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Workspaces[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace list[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        workspaces = list_workspace_configs(config_mgr)
        
        if not workspaces:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspaces found[/]")
        else:
            table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
            table.add_column("Name", style=Colors.PRIMARY)
            table.add_column("Active", style=Colors.SUCCESS)
            table.add_column("Created", style=Colors.DIM)
            
            for ws in workspaces:
                default_mark = f"[{Colors.SUCCESS}]{Icons.SUCCESS}[/]" if ws.is_default else ""
                created = ws.created_at.strftime("%Y-%m-%d") if ws.created_at else "Unknown"
                
                table.add_row(ws.name, default_mark, created)
            
            console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _create_workspace(console: Console, state: FlowState) -> None:
    """Create a new workspace."""
    from caracal.deployment.config_manager import ConfigManager, PostgresConfig
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Create Workspace[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace create <name>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        # Prompt for workspace name
        name = Prompt.ask(f"[{Colors.INFO}]Workspace name[/]")
        
        if not name:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Name cannot be empty[/]")
            input()
            return
        
        # Create workspace with onboarding-style defaults.
        config_mgr = ConfigManager()
        config_mgr.create_workspace(name, template=None)

        # Auto-apply PostgreSQL settings from environment/defaults (no prompt),
        # matching onboarding's non-interactive behavior.
        in_container_runtime = os.getenv("CARACAL_RUNTIME_IN_CONTAINER", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        host = os.getenv("CARACAL_DB_HOST") or ("postgres" if in_container_runtime else "localhost")
        port_raw = os.getenv("CARACAL_DB_PORT") or "5432"
        database = os.getenv("CARACAL_DB_NAME") or "caracal"
        user = os.getenv("CARACAL_DB_USER") or "caracal"
        password = os.getenv("CARACAL_DB_PASSWORD") or ("caracal" if in_container_runtime else "")

        try:
            port = int(port_raw)
        except (TypeError, ValueError):
            port = 5432

        postgres = PostgresConfig(
            host=host,
            port=port,
            database=database,
            user=user,
            password_ref="postgres_password",
            ssl_mode="require",
            pool_size=10,
            max_overflow=5,
            pool_timeout=30,
        )

        # Store secret first so connectivity checks can resolve password_ref.
        if password:
            config_mgr.store_secret("postgres_password", password, name)

        last_error: Optional[Exception] = None
        for _attempt in range(3):
            try:
                config_mgr.set_postgres_config(postgres)
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                # Allow PostgreSQL startup race to settle when runtime is just booting.
                time.sleep(0.8)

        if last_error is not None:
            # Do not block workspace creation when DB is temporarily unavailable.
            console.print(
                f"  [{Colors.WARNING}]{Icons.WARNING} Workspace created, but PostgreSQL auto-configuration could not be validated yet: {last_error}[/]"
            )
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace '{name}' created successfully[/]")
        console.print(f"  [{Colors.DIM}]Active workspace unchanged. Use Switch Workspace to activate it.[/]")
        
        # Record action
        state.add_recent_action(RecentAction.create(
            "workspace_create",
            f"Created workspace: {name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "workspace_create",
            f"Failed to create workspace",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _switch_workspace(console: Console, state: FlowState) -> None:
    """Switch active workspace."""
    from caracal.deployment.config_manager import ConfigManager
    from caracal.flow.state import StatePersistence
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Switch Workspace[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace switch <name>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        from caracal.flow.workspace import set_workspace

        config_mgr = ConfigManager()
        workspaces = list_workspace_configs(config_mgr)
        
        if not workspaces:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspaces available[/]")
            input()
            return
        
        # Build menu of workspaces
        items = []
        for ws in workspaces:
            default_mark = " (current)" if ws.is_default else ""
            items.append(MenuItem(
                ws.name,
                f"{ws.name}{default_mark}",
                f"Created: {ws.created_at.strftime('%Y-%m-%d') if ws.created_at else 'Unknown'}",
                Icons.WORKSPACE
            ))
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Workspace", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            # Persist the current workspace state before switching away.
            StatePersistence().save(state)

            # Switch to selected workspace
            set_default_workspace(config_mgr, result.key)
            set_workspace(config_mgr.get_workspace_path(result.key))

            # Replace persisted state with the selected workspace's state.
            active_state = StatePersistence().load()
            state.onboarding = active_state.onboarding
            state.preferences = active_state.preferences
            state.recent_actions = active_state.recent_actions
            state.favorite_commands = active_state.favorite_commands
            
            console.print()
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Switched to workspace: {result.key}[/]")
            
            state.add_recent_action(RecentAction.create(
                "workspace_switch",
                f"Switched to workspace: {result.key}",
                success=True
            ))
            StatePersistence().save(state)
            
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        input()


def _delete_workspace(console: Console, state: FlowState) -> None:
    """Delete a workspace."""
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Delete Workspace[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace delete <name>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        workspaces = list_workspace_configs(config_mgr)
        
        if not workspaces:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspaces available[/]")
            input()
            return
        
        # Build menu of workspaces
        items = []
        for ws in workspaces:
            if not ws.is_default:  # Don't allow deleting default workspace
                items.append(MenuItem(
                    ws.name,
                    ws.name,
                    f"Created: {ws.created_at.strftime('%Y-%m-%d') if ws.created_at else 'Unknown'}",
                    Icons.WORKSPACE
                ))
        
        if not items:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cannot delete default workspace[/]")
            console.print(f"  [{Colors.HINT}]Switch to another workspace first[/]")
            input()
            return
        
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Workspace to Delete", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            # Confirm deletion
            console.print()
            if Confirm.ask(f"[{Colors.WARNING}]Delete workspace '{result.key}'? This cannot be undone[/]"):
                # Ask about backup
                backup = Confirm.ask(f"[{Colors.INFO}]Create backup before deleting?[/]", default=True)
                
                config_mgr.delete_workspace(result.key, backup=backup)
                
                console.print()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace '{result.key}' deleted[/]")
                
                state.add_recent_action(RecentAction.create(
                    "workspace_delete",
                    f"Deleted workspace: {result.key}",
                    success=True
                ))
            else:
                console.print(f"  [{Colors.DIM}]Deletion cancelled[/]")
            
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        input()


def _export_workspace(console: Console, state: FlowState) -> None:
    """Export workspace to file."""
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Export Workspace[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace export <name> <path>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        config_mgr = ConfigManager()
        workspaces = list_workspace_configs(config_mgr)
        
        if not workspaces:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No workspaces available[/]")
            input()
            return
        
        # Select workspace
        items = []
        for ws in workspaces:
            items.append(MenuItem(
                ws.name,
                ws.name,
                f"Created: {ws.created_at.strftime('%Y-%m-%d') if ws.created_at else 'Unknown'}",
                Icons.WORKSPACE
            ))
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Workspace to Export", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            # Prompt for export path
            console.print()
            if _in_container_runtime():
                console.print(
                    f"  [{Colors.DIM}]Export target is host-shared path under {_host_io_root()}[/]"
                )
            export_path = Prompt.ask(
                f"[{Colors.INFO}]Export path[/]",
                default=_default_export_path(result.key)
            )

            resolved_export_path = _resolve_workspace_transfer_path(export_path)
            resolved_export_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Ask about including secrets
            include_secrets = Confirm.ask(
                f"[{Colors.WARNING}]Include encrypted secrets?[/]",
                default=False
            )

            lock_key = ""
            if include_secrets:
                console.print()
                lock_key = Prompt.ask(
                    f"[{Colors.WARNING}]Archive lock key (required when including secrets)[/]",
                    default="",
                    password=True,
                )
                lock_key_confirm = Prompt.ask(
                    f"[{Colors.WARNING}]Confirm archive lock key[/]",
                    default="",
                    password=True,
                )
                if lock_key != lock_key_confirm:
                    console.print(
                        f"  [{Colors.ERROR}]{Icons.ERROR} Lock keys do not match[/]"
                    )
                    input()
                    return

            normalized_lock_key = lock_key.strip() if lock_key else None
            if include_secrets and not normalized_lock_key:
                console.print(
                    f"  [{Colors.ERROR}]{Icons.ERROR} Archive lock key is required when including secrets[/]"
                )
                input()
                return
            
            # Export
            config_mgr.export_workspace(
                result.key,
                resolved_export_path,
                include_secrets=include_secrets,
                lock_key=normalized_lock_key,
            )
            
            console.print()
            console.print(
                f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace exported to ({_path_scope_label(resolved_export_path)}): {resolved_export_path}[/]"
            )
            
            state.add_recent_action(RecentAction.create(
                "workspace_export",
                f"Exported workspace: {result.key}",
                success=True
            ))
            
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        input()


def _import_workspace(console: Console, state: FlowState) -> None:
    """Import workspace from file."""
    from caracal.deployment.config_manager import ConfigManager
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Import Workspace[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal workspace import <path>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        # Prompt for import path
        if _in_container_runtime():
            console.print(
                f"  [{Colors.DIM}]Import source must be under host-shared path {_host_io_root()}[/]"
            )
        import_path = Prompt.ask(f"[{Colors.INFO}]Import file path[/]")

        resolved_import_path = _resolve_workspace_transfer_path(import_path)

        if not resolved_import_path.exists():
            console.print(
                f"  [{Colors.ERROR}]{Icons.ERROR} File not found ({_path_scope_label(resolved_import_path)}): {resolved_import_path}[/]"
            )
            input()
            return
        
        # Prompt for workspace name (optional)
        console.print()
        name = Prompt.ask(
            f"[{Colors.INFO}]Workspace name (leave empty to use original)[/]",
            default=""
        )

        console.print()
        lock_key = Prompt.ask(
            f"[{Colors.INFO}]Import key (leave empty for unlocked archive)[/]",
            default="",
            password=True,
        )
        normalized_lock_key = lock_key.strip() if lock_key else None
        
        # Import
        config_mgr = ConfigManager()
        config_mgr.import_workspace(
            resolved_import_path,
            name=name if name else None,
            lock_key=normalized_lock_key,
        )
        
        console.print()
        console.print(
            f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace imported successfully from ({_path_scope_label(resolved_import_path)}): {resolved_import_path}[/]"
        )
        
        state.add_recent_action(RecentAction.create(
            "workspace_import",
            f"Imported workspace from: {resolved_import_path}",
            success=True
        ))
    except ValueError as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "workspace_import",
            "Failed to import workspace",
            success=False
        ))
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "workspace_import",
            f"Failed to import workspace",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()
