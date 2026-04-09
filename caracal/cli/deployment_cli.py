"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for deployment architecture management.

Provides command-line interface for mode, edition, workspace, sync, and provider management.
"""

import json
import os
import sys
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import click
import yaml
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn
import structlog

from caracal.deployment import (
    Mode,
    ModeManager,
    Edition,
    ConfigManager,
    WorkspaceConfig,
    PostgresConfig,
    MigrationManager,
    get_deployment_edition_adapter,
    get_version_checker,
)
from caracal.deployment.exceptions import (
    ConfigurationError,
    SecretNotFoundError,
    WorkspaceNotFoundError,
    WorkspaceAlreadyExistsError,
    InvalidWorkspaceNameError,
)
from caracal.provider.definitions import (
    resolve_provider_definition_id,
)
from caracal.provider.catalog import (
    GATEWAY_ONLY_AUTH,
    ProviderCatalogError,
    build_provider_record,
    normalize_auth_scheme as normalize_catalog_auth_scheme,
)
from caracal.provider.credential_store import (
    delete_workspace_provider_credential,
    store_workspace_provider_credential,
)
from caracal.provider.workspace import (
    load_workspace_provider_registry,
    save_workspace_provider_registry,
)
from caracal.mcp.tool_registry_contract import (
    deactivate_invalid_provider_tools,
    list_tool_bindings_by_provider,
)

logger = structlog.get_logger(__name__)
console = Console()

_CONTAINER_RUNTIME_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
_HOST_IO_ROOT_ENV = "CARACAL_HOST_IO_ROOT"
_DEFAULT_HOST_IO_ROOT = Path("/caracal-host-io")


# Output formatting helpers
def format_output(data, format_type: str = "table"):
    """Format output based on requested format."""
    if format_type == "json":
        click.echo(json.dumps(data, indent=2, default=str))
    else:
        # Default to table or text output
        return data


def _in_container_runtime() -> bool:
    return os.environ.get(_CONTAINER_RUNTIME_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def _host_io_root() -> Path:
    return Path(os.environ.get(_HOST_IO_ROOT_ENV, str(_DEFAULT_HOST_IO_ROOT))).resolve(strict=False)


def _resolve_workspace_transfer_path(path: Path) -> Path:
    candidate = Path(path).expanduser()
    if not _in_container_runtime():
        return candidate.resolve(strict=False)

    root = _host_io_root()
    if candidate.is_absolute():
        resolved = candidate.resolve(strict=False)
        if resolved == root or root in resolved.parents:
            return resolved
        raise ValueError(f"In container runtime, workspace import/export paths must be under {root}.")

    return (root / candidate).resolve(strict=False)


def _resolve_workspace_lock_key(lock_key: Optional[str]) -> Optional[str]:
    """Resolve workspace archive lock key from option or environment."""
    candidate = lock_key if lock_key is not None else os.environ.get("CARACAL_WORKSPACE_LOCK_KEY")
    if candidate is None:
        return None
    normalized = candidate.strip()
    return normalized if normalized else None


def _path_scope_label(path: Path) -> str:
    if not _in_container_runtime():
        return "host path"

    root = _host_io_root()
    if path == root or root in path.parents:
        return "container path (host-shared mount)"
    return "container path"


def _resolve_workspace_name(config_manager: ConfigManager, workspace: Optional[str]) -> Optional[str]:
    """Resolve workspace name from explicit option, ConfigManager, or registry default."""
    if workspace:
        return workspace

    try:
        ctx = click.get_current_context(silent=True)
        root_ctx = ctx.find_root() if ctx else None
        ctx_obj = getattr(root_ctx, "obj", None)
        if ctx_obj and hasattr(ctx_obj, "get"):
            for key in ("workspace", "workspace_name"):
                value = ctx_obj.get(key)
                if value:
                    return str(value)

            config_path = ctx_obj.get("config_path")
            if config_path:
                cfg_path = Path(str(config_path)).expanduser()
                parts = cfg_path.parts
                if "workspaces" in parts:
                    idx = parts.index("workspaces")
                    if len(parts) > idx + 1:
                        return parts[idx + 1]
    except Exception:
        logger.debug("workspace_resolution_context_lookup_failed", exc_info=True)

    default_workspace = config_manager.get_default_workspace_name()
    if default_workspace:
        return default_workspace

    config_workspaces = config_manager.list_workspaces()
    if config_workspaces:
        return config_workspaces[0]

    try:
        from caracal.flow.workspace import WorkspaceManager

        flow_workspaces = WorkspaceManager.list_workspaces()
        if flow_workspaces:
            default_ws = next((ws for ws in flow_workspaces if ws.get("default")), None)
            if default_ws and default_ws.get("name"):
                return str(default_ws["name"])
            return flow_workspaces[0].get("name")
    except Exception:
        pass

    return None


def _get_active_workspace_db_message() -> Optional[str]:
    """Return a PostgreSQL configuration message from active workspace config, if present."""
    try:
        ctx = click.get_current_context(silent=True)
        root_ctx = ctx.find_root() if ctx else None
        ctx_obj = getattr(root_ctx, "obj", None)

        if not ctx_obj:
            return None

        runtime_config = ctx_obj.get("config") if hasattr(ctx_obj, "get") else None
        runtime_db = getattr(runtime_config, "database", None)
        if not runtime_db:
            return None

        config_path = ctx_obj.get("config_path") if hasattr(ctx_obj, "get") else None
        has_database_section = False
        if config_path:
            workspace_config_path = Path(str(config_path)).expanduser()
            if workspace_config_path.exists():
                try:
                    with open(workspace_config_path, "r", encoding="utf-8") as handle:
                        raw_config = yaml.safe_load(handle) or {}
                    has_database_section = isinstance(raw_config, dict) and isinstance(raw_config.get("database"), dict)
                except Exception:
                    logger.debug("doctor_workspace_config_parse_failed", config_path=str(workspace_config_path))

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
            return (
                "Configured (workspace): "
                f"{runtime_db.host}:{runtime_db.port}/{runtime_db.database}"
            )
    except Exception:
        logger.debug("doctor_workspace_db_detection_failed", exc_info=True)

    return None


def _revalidate_provider_tool_mappings(provider_name: str) -> list[dict[str, str]]:
    """Deactivate active tools impacted by provider mapping drift after provider updates."""
    from caracal.db.connection import get_db_manager

    db_manager = get_db_manager()
    try:
        with db_manager.session_scope() as db_session:
            return deactivate_invalid_provider_tools(
                db_session=db_session,
                provider_name=provider_name,
            )
    finally:
        db_manager.close()


# Config command group
@click.group(name="config")
def config_group():
    """Manage system configuration."""
    pass


@config_group.command(name="mode")
@click.argument("mode_value", type=click.Choice(["dev", "user"], case_sensitive=False), required=False)
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def config_mode(mode_value: Optional[str], format: str):
    """Get or set installation mode (dev or user)."""
    try:
        mode_manager = ModeManager()
        
        if mode_value:
            # Set mode
            mode = Mode(mode_value.lower())
            mode_manager.set_mode(mode)
            
            if format == "json":
                click.echo(json.dumps({"mode": mode.value, "status": "updated"}))
            else:
                console.print(f"[green]✓[/green] Mode set to: {mode.value}")
        else:
            # Get mode
            mode = mode_manager.get_mode()
            
            if format == "json":
                click.echo(json.dumps({"mode": mode.value}))
            else:
                console.print(f"Current mode: [bold]{mode.value}[/bold]")
                
    except Exception as e:
        logger.error("config_mode_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@config_group.command(name="edition")
@click.argument("edition_value", type=click.Choice(["opensource", "enterprise"], case_sensitive=False), required=False)
@click.option("--gateway-url", help="Gateway URL (required for enterprise)")
@click.option("--gateway-token", help="Gateway JWT token (optional)")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def config_edition(edition_value: Optional[str], gateway_url: Optional[str], gateway_token: Optional[str], format: str):
    """Show explicitly resolved edition state (manual setting is disabled)."""
    try:
        edition_adapter = get_deployment_edition_adapter()

        if edition_value or gateway_url or gateway_token:
            console.print(
                "[red]Error:[/red] Manual edition selection is disabled. "
                "Edition is resolved from explicit gateway execution signals and persisted state."
            )
            console.print("  Use [bold]caracal enterprise login <url> <token>[/bold] to enter Enterprise mode.")
            console.print("  Use [bold]caracal enterprise disconnect[/bold] to return to Open Source mode.")
            sys.exit(1)

        edition = edition_adapter.get_edition()

        if format == "json":
            result = {"edition": edition.value, "mode": "explicit-resolution"}
            if edition == Edition.ENTERPRISE:
                detected_gateway_url = edition_adapter.get_gateway_url()
                if detected_gateway_url:
                    result["enterprise_url"] = detected_gateway_url
            click.echo(json.dumps(result))
        else:
            console.print(f"Current edition: [bold]{edition.value}[/bold] [dim](explicit resolution)[/dim]")
            if edition == Edition.ENTERPRISE:
                detected_gateway_url = edition_adapter.get_gateway_url()
                if detected_gateway_url:
                    console.print(f"  Enterprise URL: {detected_gateway_url}")
                        
    except Exception as e:
        logger.error("config_edition_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@config_group.command(name="set")
@click.argument("key")
@click.argument("value")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def config_set(key: str, value: str, workspace: Optional[str]):
    """Set configuration value."""
    try:
        config_manager = ConfigManager()
        
        # For now, store as secret (can be extended for other config types).
        workspace = _resolve_workspace_name(config_manager, workspace)
        if not workspace:
            console.print("[red]Error:[/red] No workspaces found. Create one first.")
            sys.exit(1)
        
        config_manager.store_secret(key, value, workspace)
        console.print(f"[green]✓[/green] Configuration set: {key}")
        
    except Exception as e:
        logger.error("config_set_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@config_group.command(name="get")
@click.argument("key")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def config_get(key: str, workspace: Optional[str], format: str):
    """Get configuration value."""
    try:
        config_manager = ConfigManager()
        
        workspace = _resolve_workspace_name(config_manager, workspace)
        if not workspace:
            console.print("[red]Error:[/red] No workspaces found. Create one first.")
            sys.exit(1)
        
        value = config_manager.get_secret(key, workspace)
        
        if format == "json":
            click.echo(json.dumps({key: value}))
        else:
            console.print(f"{key}: {value}")
            
    except Exception as e:
        logger.error("config_get_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@config_group.command(name="list")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def config_list(workspace: Optional[str], format: str):
    """List configuration keys."""
    try:
        config_manager = ConfigManager()
        
        workspace = _resolve_workspace_name(config_manager, workspace)
        if not workspace:
            console.print("[red]Error:[/red] No workspaces found. Create one first.")
            sys.exit(1)
        
        # Load vault to get keys
        vault = config_manager._load_vault(workspace)
        keys = list(vault.keys())
        
        if format == "json":
            click.echo(json.dumps({"workspace": workspace, "keys": keys}))
        else:
            console.print(f"Configuration keys in workspace '{workspace}':")
            for key in keys:
                console.print(f"  • {key}")
                
    except Exception as e:
        logger.error("config_list_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


# Workspace command group
@click.group(name="workspace")
def workspace_group():
    """Manage workspaces."""
    pass


@workspace_group.command(name="create")
@click.argument("name")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def workspace_create(name: str, format: str):
    """Create a new workspace."""
    try:
        config_manager = ConfigManager()
        config_manager.create_workspace(name)
        
        if format == "json":
            click.echo(json.dumps({"workspace": name, "status": "created"}))
        else:
            console.print(f"[green]✓[/green] Workspace created: {name}")
                
    except WorkspaceAlreadyExistsError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.error("workspace_create_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@workspace_group.command(name="switch")
@click.argument("name")
def workspace_switch(name: str):
    """Switch active workspace."""
    try:
        config_manager = ConfigManager()
        
        # Verify workspace exists
        if name not in config_manager.list_workspaces():
            console.print(f"[red]Error:[/red] Workspace not found: {name}")
            sys.exit(1)

        # Set as default workspace.
        config_manager.set_default_workspace(name)
        
        console.print(f"[green]✓[/green] Switched to workspace: {name}")
        
    except Exception as e:
        logger.error("workspace_switch_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@workspace_group.command(name="list")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def workspace_list(format: str):
    """List all workspaces."""
    try:
        config_manager = ConfigManager()
        workspaces = config_manager.list_workspaces()
        
        if format == "json":
            workspace_data = []
            for ws in workspaces:
                config = config_manager.get_workspace_config(ws)
                workspace_data.append({
                    "name": ws,
                    "is_default": config.is_default,
                    "created_at": config.created_at.isoformat(),
                })

            click.echo(json.dumps({"workspaces": workspace_data}))
        else:
            if not workspaces:
                console.print("No workspaces found.")
                return
            
            table = Table(title="Workspaces")
            table.add_column("Name", style="cyan")
            table.add_column("Default", style="green")
            table.add_column("Created", style="blue")
            
            for ws in workspaces:
                config = config_manager.get_workspace_config(ws)
                table.add_row(
                    ws,
                    "✓" if config.is_default else "",
                    config.created_at.strftime("%Y-%m-%d %H:%M"),
                )
            
            console.print(table)
            
    except Exception as e:
        logger.error("workspace_list_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@workspace_group.command(name="delete")
@click.argument("name")
@click.option("--backup/--no-backup", default=True, help="Create backup before deletion")
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def workspace_delete(name: str, backup: bool, force: bool):
    """Delete a workspace."""
    try:
        config_manager = ConfigManager()
        
        if not force:
            if not click.confirm(f"Delete workspace '{name}'?"):
                console.print("Cancelled.")
                return
        
        config_manager.delete_workspace(name, backup)
        console.print(f"[green]✓[/green] Workspace deleted: {name}")
        if backup:
            console.print("  Backup created in ~/.caracal/backups/")
            
    except WorkspaceNotFoundError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.error("workspace_delete_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@workspace_group.command(name="export")
@click.argument("name")
@click.argument("path", type=click.Path(path_type=Path))
@click.option("--include-secrets", is_flag=True, help="Include encrypted secrets in export")
@click.option(
    "--lock-key",
    help="Archive lock key. If omitted, reads CARACAL_WORKSPACE_LOCK_KEY env var.",
)
def workspace_export(name: str, path: Path, include_secrets: bool, lock_key: Optional[str]):
    """Export workspace configuration."""
    try:
        config_manager = ConfigManager()
        resolved_path = _resolve_workspace_transfer_path(path)
        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_lock_key = _resolve_workspace_lock_key(lock_key)
        config_manager.export_workspace(
            name,
            resolved_path,
            include_secrets=include_secrets,
            lock_key=resolved_lock_key,
        )
        
        console.print(f"[green]✓[/green] Workspace exported: {name}")
        console.print(f"  Export file ({_path_scope_label(resolved_path)}): {resolved_path}")
        if include_secrets:
            console.print("  [yellow]Warning:[/yellow] Secrets included in export")
        if resolved_lock_key:
            console.print("  [green]Locked:[/green] Archive is protected with import key")
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except WorkspaceNotFoundError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.error("workspace_export_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@workspace_group.command(name="import")
@click.argument("path", type=click.Path(path_type=Path))
@click.option("--name", help="Workspace name (uses name from export if not provided)")
@click.option(
    "--lock-key",
    help="Archive lock key for locked exports. If omitted, reads CARACAL_WORKSPACE_LOCK_KEY env var.",
)
def workspace_import(path: Path, name: Optional[str], lock_key: Optional[str]):
    """Import workspace from backup."""
    try:
        config_manager = ConfigManager()
        resolved_path = _resolve_workspace_transfer_path(path)
        if not resolved_path.exists():
            console.print(
                f"[red]Error:[/red] Import file not found ({_path_scope_label(resolved_path)}): {resolved_path}"
            )
            sys.exit(1)

        resolved_lock_key = _resolve_workspace_lock_key(lock_key)
        config_manager.import_workspace(resolved_path, name=name, lock_key=resolved_lock_key)
        
        console.print(f"[green]✓[/green] Workspace imported")
        console.print(f"  Import file ({_path_scope_label(resolved_path)}): {resolved_path}")
        if name:
            console.print(f"  Workspace name: {name}")
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except WorkspaceAlreadyExistsError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
    except Exception as e:
        logger.error("workspace_import_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


# Enterprise command group
@click.group(name="enterprise")
def enterprise_group():
    """Manage enterprise connectivity and synchronization."""
    pass


@enterprise_group.command(name="login")
@click.argument("url")
@click.argument("token")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def enterprise_login(
    url: str,
    token: str,
    workspace: Optional[str],
):
    """Connect workspace to enterprise backend."""
    try:
        from caracal.deployment.enterprise_license import EnterpriseLicenseValidator
        
        validator = EnterpriseLicenseValidator(enterprise_api_url=url)
        result = validator.validate_license(token)

        if not result.valid:
            console.print(f"[red]Error:[/red] {result.message}")
            sys.exit(1)

        resolved_api_url = result.enterprise_api_url or url
        
        console.print(f"[green]✓[/green] Workspace connected to enterprise")
        console.print(f"  Workspace: {workspace or 'default'}")
        console.print(f"  URL: {resolved_api_url}")
        if result.tier:
            console.print(f"  Tier: {result.tier}")
        console.print("  Credential migration: explicit only")
        console.print("  Next step: run `caracal migrate oss-to-enterprise` to move local credentials into enterprise custody.")
        
    except Exception as e:
        logger.error("enterprise_login_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)

@enterprise_group.command(name="disconnect")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--force", is_flag=True, help="Skip safety confirmation prompts")
def enterprise_disconnect(
    workspace: Optional[str],
    force: bool,
):
    """Disconnect workspace from enterprise backend."""
    try:
        from caracal.deployment.enterprise_license import EnterpriseLicenseValidator
        
        config_manager = ConfigManager()
        
        workspace = _require_workspace(config_manager, workspace)
        
        current_edition = get_deployment_edition_adapter().get_edition()

        if current_edition == Edition.ENTERPRISE and not force:
            console.print("[yellow]Security warning:[/yellow] You are disconnecting Enterprise mode.")
            console.print("  Default behavior is a [bold]fresh Open Source start[/bold] with no secret migration.")
            console.print("  This avoids copying enterprise-managed secrets into local storage by default.")
            console.print()
            if not click.confirm("Proceed with Enterprise disconnect and switch to Open Source fresh start?"):
                console.print("Cancelled.")
                return

        try:
            EnterpriseLicenseValidator().disconnect()
        except Exception as license_error:
            logger.debug("enterprise_disconnect_license_clear_skipped", error=str(license_error))
        
        console.print(f"[green]✓[/green] Workspace disconnected from enterprise")
        console.print(f"  Workspace: {workspace}")
        if current_edition == Edition.ENTERPRISE:
            console.print("  Mode: Open Source (fresh start)")
            console.print("  Credential migration: run `caracal migrate enterprise-to-oss` explicitly if you need a controlled export.")
        
    except Exception as e:
        logger.error("enterprise_disconnect_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@enterprise_group.command(name="sync")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--direction", "-d", type=click.Choice(["push", "pull", "both"]), default="both", help="Sync direction")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def enterprise_sync(workspace: Optional[str], direction: str, format: str):
    """Perform immediate synchronization."""
    try:
        from caracal.deployment.enterprise_sync_payload import build_enterprise_sync_payload
        from caracal.deployment.enterprise_sync import EnterpriseSyncClient
        
        config_manager = ConfigManager()
        
        workspace = _require_workspace(config_manager, workspace)

        if direction != "both":
            console.print("[yellow]Warning:[/yellow] Direction filtering is no longer supported; running full enterprise sync.")

        sync_client = EnterpriseSyncClient()
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task(f"Syncing workspace '{workspace}'...", total=None)
            payload = build_enterprise_sync_payload(
                client_instance_id=sync_client._client_instance_id,
            )
            result = sync_client.upload_payload(payload)
            progress.update(task, completed=True)
        
        if format == "json":
            click.echo(json.dumps({
                "workspace": workspace,
                "success": result.success,
                "synced_counts": result.synced_counts,
                "message": result.message,
                "errors": result.errors,
            }))
        else:
            if result.success:
                console.print(f"[green]✓[/green] Sync completed successfully")
            else:
                console.print(f"[yellow]⚠[/yellow] Sync completed with errors")
            
            for key, value in sorted(result.synced_counts.items()):
                console.print(f"  {key}: {value}")
            console.print(f"  Message: {result.message}")
            
            if result.errors:
                console.print("\n[red]Errors:[/red]")
                for error in result.errors:
                    console.print(f"  • {error}")
        
    except Exception as e:
        logger.error("enterprise_sync_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@enterprise_group.command(name="status")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def enterprise_status(workspace: Optional[str], format: str):
    """Show sync status."""
    try:
        from caracal.deployment.enterprise_license import EnterpriseLicenseValidator
        from caracal.deployment.enterprise_sync import EnterpriseSyncClient
        
        config_manager = ConfigManager()
        
        workspace = _require_workspace(config_manager, workspace)
        
        sync_status = EnterpriseSyncClient().get_sync_status()
        license_info = EnterpriseLicenseValidator().get_license_info()
        
        if format == "json":
            click.echo(json.dumps(
                {
                    "workspace": workspace,
                    "license_active": bool(license_info.get("license_active")),
                    "tier": license_info.get("tier"),
                    "sync_status": sync_status,
                }
            ))
        else:
            console.print(f"Sync Status for workspace '{workspace}':")
            console.print(f"  License active: {'✓' if license_info.get('license_active') else '✗'}")
            if license_info.get("tier"):
                console.print(f"  Tier: {license_info['tier']}")

            if isinstance(sync_status, dict):
                if sync_status.get("error"):
                    console.print(f"  Status: {sync_status.get('error')}")
                else:
                    last_sync = sync_status.get("last_sync")
                    if isinstance(last_sync, dict):
                        console.print(f"  Last sync: {last_sync.get('timestamp', 'Unknown')}")
                    elif last_sync:
                        console.print(f"  Last sync: {last_sync}")

                    if sync_status.get("organization_name"):
                        console.print(f"  Organization: {sync_status['organization_name']}")
                    if sync_status.get("organization_id"):
                        console.print(f"  Organization ID: {sync_status['organization_id']}")
                    if sync_status.get("tier"):
                        console.print(f"  Server tier: {sync_status['tier']}")
        
    except Exception as e:
        logger.error("enterprise_status_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


# Provider command group
@click.group(name="provider")
def provider_group():
    """Manage external service provider configurations."""
    pass


def _parse_metadata_pairs(pairs: tuple[str, ...]) -> Dict[str, str]:
    """Parse repeated --metadata key=value options into a dictionary."""
    metadata: Dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise click.ClickException(f"Invalid metadata entry '{pair}', expected key=value")
        key, value = pair.split("=", 1)
        key = key.strip()
        if not key:
            raise click.ClickException("Metadata key cannot be empty")
        metadata[key] = value.strip()
    return metadata


def _normalize_auth_scheme(auth_scheme: str) -> str:
    """Normalize CLI auth scheme naming to internal representation."""
    try:
        return normalize_catalog_auth_scheme(auth_scheme)
    except ProviderCatalogError as exc:
        raise click.ClickException(str(exc)) from exc


def _resolve_oss_auth_scheme(auth_scheme: str) -> str:
    """Normalize auth scheme and reject gateway-only modes in OSS flows."""
    normalized_auth = _normalize_auth_scheme(auth_scheme)
    if normalized_auth in GATEWAY_ONLY_AUTH:
        raise click.ClickException(
            f"Auth scheme '{auth_scheme}' requires enterprise gateway execution. "
            "Use one of: none, api-key, bearer, basic, header."
        )
    return normalized_auth


def _provider_mode(entry: Dict[str, Any]) -> str:
    definition = entry.get("definition")
    has_resources = isinstance(definition, dict) and bool(definition.get("resources"))
    if entry.get("enforce_scoped_requests") and has_resources:
        return "scoped"
    return "passthrough"


def _provider_credential_status(entry: Dict[str, Any]) -> str:
    auth_scheme = str(entry.get("auth_scheme") or "none")
    if auth_scheme == "none":
        return "not_required"
    return "configured" if entry.get("credential_ref") else "missing"


def _parse_resources(resource_specs: tuple[str, ...]) -> Dict[str, Dict[str, Any]]:
    """Parse --resource entries as <resource_id>[=<description>]."""
    resources: Dict[str, Dict[str, Any]] = {}
    for spec in resource_specs:
        raw = spec.strip()
        if not raw:
            continue
        if "=" in raw:
            resource_id, description = raw.split("=", 1)
        else:
            resource_id, description = raw, raw
        resource_id = resource_id.strip()
        if not resource_id:
            raise click.ClickException(f"Invalid resource spec '{spec}'")
        resources[resource_id] = {"description": description.strip() or resource_id, "actions": {}}
    return resources


def _parse_actions(
    action_specs: tuple[str, ...],
    resources: Dict[str, Dict[str, Any]],
) -> None:
    """
    Parse --action entries as <resource_id>:<action_id>:<method>:<path_prefix>.
    """
    if not action_specs:
        if resources:
            raise click.ClickException("Add at least one --action for each --resource")
        return
    for spec in action_specs:
        parts = spec.split(":", 3)
        if len(parts) != 4:
            raise click.ClickException(
                f"Invalid action spec '{spec}'. Expected <resource_id>:<action_id>:<method>:<path_prefix>"
            )
        resource_id, action_id, method, path_prefix = [p.strip() for p in parts]
        if resource_id not in resources:
            raise click.ClickException(
                f"Action '{spec}' references unknown resource '{resource_id}'. Add it with --resource first."
            )
        if not path_prefix.startswith("/"):
            raise click.ClickException(
                f"Action '{spec}' has invalid path_prefix '{path_prefix}'. It must start with '/'."
            )
        resources[resource_id]["actions"][action_id] = {
            "description": action_id,
            "method": method.upper(),
            "path_prefix": path_prefix,
        }

    for resource_id, payload in resources.items():
        if not payload["actions"]:
            raise click.ClickException(
                f"Resource '{resource_id}' has no actions. Add at least one --action for each resource."
            )

def _merge_resources(
    destination: Dict[str, Dict[str, Any]],
    updates: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """Merge resource/action payloads with replacement semantics per action id."""
    merged = dict(destination)
    for resource_id, payload in updates.items():
        current = merged.setdefault(
            resource_id,
            {"description": payload.get("description") or resource_id, "actions": {}},
        )
        current["description"] = payload.get("description") or current.get("description") or resource_id
        actions = dict(current.get("actions") or {})
        actions.update(payload.get("actions") or {})
        current["actions"] = actions
    return merged

def _build_scoped_definition(
    *,
    name: str,
    definition_id: str,
    service_type: str,
    auth_scheme: str,
    base_url: Optional[str],
    resources: Dict[str, Dict[str, Any]],
    metadata: Dict[str, Any],
) -> Dict[str, Any]:
    if not resources:
        raise click.ClickException(
            "Scoped mode requires at least one --resource and matching --action entries."
        )
    return {
        "definition_id": definition_id,
        "service_type": service_type,
        "display_name": name,
        "auth_scheme": auth_scheme,
        "default_base_url": base_url,
        "resources": resources,
        "metadata": dict(metadata),
    }


def _require_workspace(config_manager: ConfigManager, workspace: Optional[str]) -> str:
    """Resolve workspace or fail with a user-facing error."""
    resolved = _resolve_workspace_name(config_manager, workspace)
    if not resolved:
        raise click.ClickException("No workspaces found. Create one first.")
    return resolved


def _load_workspace_providers(config_manager: ConfigManager, workspace: str) -> Dict[str, Dict[str, Any]]:
    """Load provider registry from workspace metadata."""
    try:
        return load_workspace_provider_registry(config_manager, workspace)
    except WorkspaceNotFoundError:
        logger.warning(
            "workspace_provider_registry_not_found",
            workspace=workspace,
        )
        return {}


def _save_workspace_providers(
    config_manager: ConfigManager,
    workspace: str,
    providers: Dict[str, Dict[str, Any]],
) -> None:
    """Persist provider registry in workspace metadata."""
    save_workspace_provider_registry(config_manager, workspace, providers)


def _build_oss_broker(config_manager: ConfigManager, workspace: str):
    """Build an OSS broker from persisted provider registry entries."""
    from caracal.deployment.broker import Broker, ProviderConfig

    broker = Broker(config_manager=config_manager, workspace=workspace)
    providers = _load_workspace_providers(config_manager, workspace)

    for provider_name, entry in providers.items():
        provider_config = ProviderConfig(
            name=provider_name,
            provider_type=entry.get("service_type", entry.get("provider_type", "api")),
            provider_definition=entry.get("provider_definition"),
            definition=entry.get("definition"),
            credential_ref=entry.get("credential_ref"),
            auth_scheme=entry.get("auth_scheme", "api_key"),
            base_url=entry.get("base_url"),
            timeout_seconds=int(entry.get("timeout_seconds", 30)),
            max_retries=int(entry.get("max_retries", 3)),
            rate_limit_rpm=entry.get("rate_limit_rpm"),
            healthcheck_path=entry.get("healthcheck_path", "/health"),
            default_headers=entry.get("default_headers", {}),
            auth_metadata=entry.get("auth_metadata", {}),
            version=entry.get("version"),
            capabilities=entry.get("capabilities", []),
            tags=entry.get("tags", []),
            access_policy=entry.get("access_policy", {}),
            metadata=entry.get("metadata", {}),
            enforce_scoped_requests=bool(entry.get("enforce_scoped_requests", False)),
        )
        broker.configure_provider(provider_name, provider_config)

    return broker, providers


@provider_group.command(name="add")
@click.argument("name")
@click.option(
    "--mode",
    type=click.Choice(["passthrough", "scoped"]),
    default="passthrough",
    show_default=True,
    help="Provider execution mode",
)
@click.option(
    "--service-type",
    required=True,
    help=(
        "Service type hint (free-form; common values include application, ai, data, "
        "identity, messaging, storage, payments, developer-tools, observability, "
        "infrastructure, internal)"
    ),
)
@click.option(
    "--provider-definition",
    help="Provider definition ID (defaults to provider name)",
)
@click.option("--base-url", required=True, help="Provider base URL")
@click.option(
    "--auth-scheme",
    type=click.Choice([
        "none",
        "api-key",
        "bearer",
        "basic",
        "header",
    ]),
    required=True,
    help="Authentication scheme",
)
@click.option(
    "--resource",
    "resource_specs",
    multiple=True,
    help="Resource definition: <resource_id>[=<description>] (repeatable)",
)
@click.option(
    "--action",
    "action_specs",
    multiple=True,
    help="Action definition: <resource_id>:<action_id>:<method>:<path_prefix> (repeatable)",
)
@click.option("--credential", help="Credential value to store as encrypted secret")
@click.option("--credential-ref", help="Existing secret reference for credential")
@click.option("--auth-header-name", help="Header name for --auth-scheme header")
@click.option("--version", help="Provider API/version label")
@click.option("--tag", "tags", multiple=True, help="Tag (repeatable)")
@click.option("--metadata", "metadata_pairs", multiple=True, help="Metadata key=value (repeatable)")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def provider_add(
    name: str,
    mode: str,
    service_type: str,
    provider_definition: Optional[str],
    base_url: str,
    auth_scheme: str,
    resource_specs: tuple[str, ...],
    action_specs: tuple[str, ...],
    credential: Optional[str],
    credential_ref: Optional[str],
    auth_header_name: Optional[str],
    version: Optional[str],
    tags: tuple[str, ...],
    metadata_pairs: tuple[str, ...],
    workspace: Optional[str],
):
    """Add a provider configuration using passthrough or scoped mode."""
    try:
        config_manager = ConfigManager()
        edition_adapter = get_deployment_edition_adapter()

        workspace = _require_workspace(config_manager, workspace)

        if edition_adapter.uses_gateway_execution():
            raise click.ClickException(
                "Enterprise mode is gateway-managed. Register providers in the gateway/vault instead of local workspace."
            )

        if credential and credential_ref:
            raise click.ClickException("Use either --credential or --credential-ref, not both")

        effective_service_type = service_type.strip().lower()
        if not effective_service_type:
            raise click.ClickException("--service-type is required")

        normalized_auth = _resolve_oss_auth_scheme(auth_scheme)
        resolved_definition_id = resolve_provider_definition_id(
            service_type=effective_service_type,
            requested_definition=provider_definition or name,
        )
        metadata = _parse_metadata_pairs(metadata_pairs)

        if normalized_auth != "none" and not (credential or credential_ref):
            raise click.ClickException(
                "Authenticated providers require --credential or --credential-ref"
            )

        if normalized_auth == "none" and (credential or credential_ref):
            raise click.ClickException("Do not supply credentials when --auth-scheme is none")

        if normalized_auth == "header" and not auth_header_name:
            raise click.ClickException("--auth-header-name is required for --auth-scheme header")

        stored_credential_ref = credential_ref
        if credential:
            stored_credential_ref = store_workspace_provider_credential(
                workspace=workspace,
                provider_id=name,
                value=credential,
            )

        resources = _parse_resources(resource_specs)
        _parse_actions(action_specs, resources)
        if mode == "passthrough" and resources:
            raise click.ClickException(
                "Resource/action definitions are only valid in scoped mode. Use --mode scoped."
            )
        definition = None
        if mode == "scoped":
            definition = _build_scoped_definition(
                name=name,
                definition_id=resolved_definition_id,
                service_type=effective_service_type,
                auth_scheme=normalized_auth,
                base_url=base_url,
                resources=resources,
                metadata=metadata,
            )

        providers = _load_workspace_providers(config_manager, workspace)
        if name in providers:
            raise click.ClickException(
                f"Provider '{name}' already exists. Use 'caracal provider update {name}' instead."
            )
        existing = providers.get(name, {})

        providers[name] = build_provider_record(
            name=name,
            service_type=effective_service_type,
            definition_id=resolved_definition_id,
            auth_scheme=normalized_auth,
            base_url=base_url,
            definition=definition,
            healthcheck_path=str(existing.get("healthcheck_path") or "/health"),
            timeout_seconds=int(existing.get("timeout_seconds") or 30),
            max_retries=int(existing.get("max_retries") or 3),
            rate_limit_rpm=existing.get("rate_limit_rpm"),
            version=version,
            tags=list(tags),
            metadata=metadata,
            auth_header_name=auth_header_name,
            credential_ref=stored_credential_ref,
            existing=existing,
            created_at=existing.get("created_at", datetime.utcnow().isoformat()),
            enforce_scoped_requests=mode == "scoped",
        )

        _save_workspace_providers(config_manager, workspace, providers)

        console.print(f"[green]✓[/green] Provider added: {name}")
        console.print(f"  Workspace: {workspace}")
        console.print(f"  Service Type: {effective_service_type}")
        console.print(f"  Definition: {resolved_definition_id}")
        console.print(f"  Auth Scheme: {normalized_auth}")
        console.print(f"  Mode: {mode}")
        
    except Exception as e:
        logger.error("provider_add_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="update")
@click.argument("name")
@click.option("--service-type", help="Override service type")
@click.option("--provider-definition", help="Override provider definition ID")
@click.option("--base-url", help="Override provider base URL")
@click.option(
    "--auth-scheme",
    type=click.Choice(["none", "api-key", "bearer", "basic", "header"]),
    default=None,
    help="Override authentication scheme",
)
@click.option("--credential", help="Store a new credential value for this provider")
@click.option("--credential-ref", help="Use an existing credential ref")
@click.option("--clear-credential", is_flag=True, help="Remove the configured credential ref")
@click.option("--auth-header-name", help="Override header name for header auth")
@click.option("--health-path", help="Health check path for provider test")
@click.option("--timeout-seconds", type=int, help="Request timeout in seconds")
@click.option("--max-retries", type=int, help="Retry attempts")
@click.option("--rate-limit-rpm", type=int, help="Client-side requests per minute limit")
@click.option("--clear-rate-limit", is_flag=True, help="Clear any rate limit")
@click.option("--version", help="Provider API/version label")
@click.option("--clear-version", is_flag=True, help="Clear provider version label")
@click.option("--tag", "tags", multiple=True, help="Replace tags with the provided set")
@click.option("--clear-tags", is_flag=True, help="Remove all tags")
@click.option("--metadata", "metadata_pairs", multiple=True, help="Metadata key=value (merged into existing metadata)")
@click.option("--clear-metadata", is_flag=True, help="Clear existing metadata before applying --metadata")
@click.option("--mode", type=click.Choice(["passthrough", "scoped"]), help="Set provider execution mode")
@click.option(
    "--resource",
    "resource_specs",
    multiple=True,
    help="Resource definition: <resource_id>[=<description>] (repeatable)",
)
@click.option(
    "--action",
    "action_specs",
    multiple=True,
    help="Action definition: <resource_id>:<action_id>:<method>:<path_prefix> (repeatable)",
)
@click.option("--replace-catalog", is_flag=True, help="Replace scoped resources/actions instead of merging")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def provider_update(
    name: str,
    service_type: Optional[str],
    provider_definition: Optional[str],
    base_url: Optional[str],
    auth_scheme: Optional[str],
    credential: Optional[str],
    credential_ref: Optional[str],
    clear_credential: bool,
    auth_header_name: Optional[str],
    health_path: Optional[str],
    timeout_seconds: Optional[int],
    max_retries: Optional[int],
    rate_limit_rpm: Optional[int],
    clear_rate_limit: bool,
    version: Optional[str],
    clear_version: bool,
    tags: tuple[str, ...],
    clear_tags: bool,
    metadata_pairs: tuple[str, ...],
    clear_metadata: bool,
    mode: Optional[str],
    resource_specs: tuple[str, ...],
    action_specs: tuple[str, ...],
    replace_catalog: bool,
    workspace: Optional[str],
):
    """Update provider connectivity/runtime settings and scoped catalog state."""
    try:
        config_manager = ConfigManager()
        edition_adapter = get_deployment_edition_adapter()

        workspace = _require_workspace(config_manager, workspace)
        if edition_adapter.uses_gateway_execution():
            raise click.ClickException(
                "Enterprise mode is gateway-managed. Register providers in the gateway/vault instead of local workspace."
            )

        providers = _load_workspace_providers(config_manager, workspace)
        existing = providers.get(name)
        if not existing:
            raise click.ClickException(f"Provider not found: {name}")

        if credential and credential_ref:
            raise click.ClickException("Use either --credential or --credential-ref, not both")
        if clear_credential and (credential or credential_ref):
            raise click.ClickException("Use --clear-credential by itself")

        effective_service_type = (
            service_type.strip().lower()
            if service_type
            else str(existing.get("service_type") or "api")
        )
        normalized_auth = _resolve_oss_auth_scheme(auth_scheme or str(existing.get("auth_scheme") or "api_key"))

        if normalized_auth == "none" and (credential or credential_ref):
            raise click.ClickException("Do not supply credentials when --auth-scheme is none")
        if normalized_auth == "header" and not (auth_header_name or (existing.get("auth_metadata") or {}).get("header_name")):
            raise click.ClickException("--auth-header-name is required for --auth-scheme header")

        next_metadata = {} if clear_metadata else dict(existing.get("metadata") or {})
        next_metadata.update(_parse_metadata_pairs(metadata_pairs))

        next_tags = [] if clear_tags else list(existing.get("tags") or [])
        if tags:
            next_tags = list(tags)

        next_base_url = base_url if base_url is not None else existing.get("base_url")
        next_definition_id = resolve_provider_definition_id(
            service_type=effective_service_type,
            requested_definition=provider_definition or str(existing.get("provider_definition") or name),
        )
        next_credential_ref = None if (clear_credential or normalized_auth == "none") else existing.get("credential_ref")

        if clear_credential and normalized_auth != "none" and not (credential or credential_ref):
            raise click.ClickException(
                "Authenticated providers require a configured credential. "
                "Use --auth-scheme none if you want to remove it."
            )

        if credential:
            next_credential_ref = store_workspace_provider_credential(
                workspace=workspace,
                provider_id=name,
                value=credential,
            )
        elif credential_ref:
            next_credential_ref = credential_ref

        if clear_credential or normalized_auth == "none":
            stale_ref = existing.get("credential_ref")
            if stale_ref:
                try:
                    delete_workspace_provider_credential(workspace, stale_ref)
                except SecretNotFoundError:
                    pass
        elif not next_credential_ref:
            raise click.ClickException(
                "Authenticated providers require a configured credential. "
                "Use --credential, --credential-ref, or switch auth to none."
            )

        next_mode = mode or _provider_mode(existing)
        explicit_resources = _parse_resources(resource_specs)
        _parse_actions(action_specs, explicit_resources)

        if next_mode == "passthrough":
            if explicit_resources or replace_catalog:
                raise click.ClickException(
                    "Resource/action catalog changes require --mode scoped."
                )
            definition = None
        else:
            existing_definition = existing.get("definition")
            existing_resources: Dict[str, Dict[str, Any]] = {}
            if isinstance(existing_definition, dict):
                existing_resources = dict(existing_definition.get("resources") or {})
            scoped_resources = {} if replace_catalog else dict(existing_resources)
            scoped_resources = _merge_resources(scoped_resources, explicit_resources)
            definition = _build_scoped_definition(
                name=name,
                definition_id=next_definition_id,
                service_type=effective_service_type,
                auth_scheme=normalized_auth,
                base_url=next_base_url,
                resources=scoped_resources,
                metadata=next_metadata,
            )

        providers[name] = build_provider_record(
            name=name,
            service_type=effective_service_type,
            definition_id=next_definition_id,
            auth_scheme=normalized_auth,
            base_url=next_base_url,
            definition=definition,
            healthcheck_path=health_path or str(existing.get("healthcheck_path") or "/health"),
            timeout_seconds=timeout_seconds if timeout_seconds is not None else int(existing.get("timeout_seconds") or 30),
            max_retries=max_retries if max_retries is not None else int(existing.get("max_retries") or 3),
            rate_limit_rpm=None if clear_rate_limit else (rate_limit_rpm if rate_limit_rpm is not None else existing.get("rate_limit_rpm")),
            version=None if clear_version else (version if version is not None else existing.get("version")),
            tags=next_tags,
            metadata=next_metadata,
            auth_header_name=auth_header_name or (existing.get("auth_metadata") or {}).get("header_name"),
            credential_ref=next_credential_ref,
            existing=existing,
            created_at=existing.get("created_at"),
            enforce_scoped_requests=next_mode == "scoped",
        )
        _save_workspace_providers(config_manager, workspace, providers)

        impacted = _revalidate_provider_tool_mappings(name)

        console.print(f"[green]✓[/green] Provider updated: {name}")
        console.print(f"  Mode: {_provider_mode(providers[name])}")
        console.print(f"  Credential: {_provider_credential_status(providers[name])}")
        if impacted:
            console.print(
                f"[yellow]⚠[/yellow] Deactivated {len(impacted)} mapped tool(s) due provider mapping drift:"
            )
            for item in impacted:
                console.print(f"  • {item['tool_id']}: {item['reason']}")
    except Exception as e:
        logger.error("provider_update_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="download")
@click.argument("name")
@click.argument("path", type=click.Path(path_type=Path))
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def provider_download(name: str, path: Path, workspace: Optional[str]):
    """Download provider configuration as JSON."""
    try:
        config_manager = ConfigManager()
        workspace = _require_workspace(config_manager, workspace)

        providers = _load_workspace_providers(config_manager, workspace)
        provider = providers.get(name)
        if not provider:
            raise click.ClickException(f"Provider not found: {name}")

        output = {
            "provider": provider,
            "exported_at": datetime.utcnow().isoformat(),
            "workspace": workspace,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(output, indent=2), encoding="utf-8")

        console.print(f"[green]✓[/green] Provider downloaded: {name}")
        console.print(f"  Path: {path}")
    except Exception as e:
        logger.error("provider_download_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="import")
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option("--name", help="Override provider name from imported JSON")
@click.option("--credential", help="Store a new credential value for this provider")
@click.option("--credential-ref", help="Use an existing credential ref")
@click.option("--replace", is_flag=True, help="Replace an existing provider with the same name")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def provider_import(
    path: Path,
    name: Optional[str],
    credential: Optional[str],
    credential_ref: Optional[str],
    replace: bool,
    workspace: Optional[str],
):
    """Import provider configuration JSON with validation before storage."""
    try:
        config_manager = ConfigManager()
        edition_adapter = get_deployment_edition_adapter()

        workspace = _require_workspace(config_manager, workspace)
        if edition_adapter.uses_gateway_execution():
            raise click.ClickException(
                "Enterprise mode is gateway-managed. Register providers in the gateway/vault instead of local workspace."
            )

        if credential and credential_ref:
            raise click.ClickException("Use either --credential or --credential-ref, not both")

        raw_payload = json.loads(path.read_text(encoding="utf-8"))
        payload = raw_payload.get("provider") if isinstance(raw_payload, dict) and isinstance(raw_payload.get("provider"), dict) else raw_payload
        if not isinstance(payload, dict):
            raise click.ClickException("Imported JSON must contain an object payload or {\"provider\": {...}}.")

        provider_name = name or payload.get("provider_id") or payload.get("name")
        if not provider_name:
            raise click.ClickException("Imported JSON is missing provider name/provider_id.")

        service_type = str(payload.get("service_type") or "").strip().lower()
        if not service_type:
            raise click.ClickException("Imported JSON is missing service_type.")

        auth_scheme = _resolve_oss_auth_scheme(str(payload.get("auth_scheme") or ""))
        base_url = str(payload.get("base_url") or "").strip()
        if not base_url:
            raise click.ClickException("Imported JSON is missing base_url.")

        definition_id = resolve_provider_definition_id(
            service_type=service_type,
            requested_definition=str(payload.get("provider_definition") or provider_name),
        )

        metadata = dict(payload.get("metadata") or {})
        metadata.pop("starter_pattern", None)
        auth_metadata = dict(payload.get("auth_metadata") or {})
        imported_definition = payload.get("definition")
        scoped_mode = bool(payload.get("enforce_scoped_requests"))
        if not scoped_mode and isinstance(imported_definition, dict) and imported_definition.get("resources"):
            scoped_mode = True

        definition = None
        if scoped_mode:
            resources = {}
            if isinstance(imported_definition, dict):
                resources = dict(imported_definition.get("resources") or {})
            definition = _build_scoped_definition(
                name=str(provider_name),
                definition_id=definition_id,
                service_type=service_type,
                auth_scheme=auth_scheme,
                base_url=base_url,
                resources=resources,
                metadata=metadata,
            )

        providers = _load_workspace_providers(config_manager, workspace)
        existing = providers.get(str(provider_name))
        if existing and not replace:
            raise click.ClickException(
                f"Provider '{provider_name}' already exists. Use --replace to overwrite it."
            )

        stored_credential_ref = credential_ref or payload.get("credential_ref")
        if credential:
            stored_credential_ref = store_workspace_provider_credential(
                workspace=workspace,
                provider_id=str(provider_name),
                value=credential,
            )
        if auth_scheme == "none":
            if credential or credential_ref:
                raise click.ClickException("Do not supply credentials when auth_scheme is none.")
            stored_credential_ref = None
        elif not stored_credential_ref:
            raise click.ClickException(
                "Authenticated imported providers require credential_ref in JSON or --credential/--credential-ref."
            )

        record = build_provider_record(
            name=str(provider_name),
            service_type=service_type,
            definition_id=definition_id,
            auth_scheme=auth_scheme,
            base_url=base_url,
            definition=definition,
            healthcheck_path=str(payload.get("healthcheck_path") or "/health"),
            timeout_seconds=int(payload.get("timeout_seconds") or 30),
            max_retries=int(payload.get("max_retries") or 3),
            rate_limit_rpm=payload.get("rate_limit_rpm"),
            version=payload.get("version"),
            tags=list(payload.get("tags") or []),
            metadata=metadata,
            auth_header_name=str(auth_metadata.get("header_name") or "") or None,
            credential_ref=stored_credential_ref,
            existing=existing,
            created_at=(existing or {}).get("created_at") if existing else payload.get("created_at"),
            enforce_scoped_requests=scoped_mode,
        )

        providers[str(provider_name)] = record
        _save_workspace_providers(config_manager, workspace, providers)

        console.print(f"[green]✓[/green] Provider imported: {provider_name}")
        console.print(f"  Mode: {_provider_mode(record)}")
        console.print(f"  Credential: {_provider_credential_status(record)}")
    except json.JSONDecodeError as e:
        console.print(f"[red]Error:[/red] Invalid JSON: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error("provider_import_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="list")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def provider_list(workspace: Optional[str], format: str):
    """List configured providers."""
    try:
        config_manager = ConfigManager()
        edition_adapter = get_deployment_edition_adapter()

        workspace = _require_workspace(config_manager, workspace)

        def _read_tool_bindings() -> Dict[str, List[str]]:
            try:
                from caracal.db.connection import get_db_manager

                db_manager = get_db_manager()
                try:
                    with db_manager.session_scope() as db_session:
                        return list_tool_bindings_by_provider(db_session=db_session)
                finally:
                    db_manager.close()
            except Exception:
                return {}

        tool_bindings = _read_tool_bindings()

        providers_data: List[Dict[str, Any]] = []

        if edition_adapter.uses_gateway_execution():
            from caracal.deployment.gateway_client import GatewayClient

            gateway_url = edition_adapter.require_gateway_url()

            gateway_client = GatewayClient(
                gateway_url=gateway_url,
                config_manager=config_manager,
                workspace=workspace,
            )
            try:
                providers = asyncio.run(gateway_client.get_available_providers())
            finally:
                asyncio.run(gateway_client.close())

            providers_data = [
                {
                    "name": provider.name,
                    "service_type": provider.service_type,
                    "auth_scheme": provider.auth_scheme,
                    "base_url": provider.metadata.get("base_url") if isinstance(provider.metadata, dict) else None,
                    "version": provider.version,
                    "status": provider.status,
                    "tags": provider.tags,
                    "provider_definition": provider.provider_definition,
                    "resources": provider.resources,
                    "actions": provider.actions,
                    "tool_bindings": tool_bindings.get(provider.name, []),
                }
                for provider in providers
            ]
        else:
            broker, registry = _build_oss_broker(config_manager, workspace)
            providers = broker.list_providers()
            for provider in providers:
                stored = registry.get(provider.name, {})
                providers_data.append(
                    {
                        "name": provider.name,
                        "service_type": provider.service_type,
                        "provider_definition": stored.get("provider_definition"),
                        "auth_scheme": provider.auth_scheme,
                        "base_url": provider.base_url,
                        "credential_status": _provider_credential_status(stored),
                        "mode": _provider_mode(stored),
                        "version": provider.version,
                        "status": provider.status,
                        "tags": stored.get("tags", []),
                        "provider_definition": stored.get("provider_definition"),
                        "resources": stored.get("resources", []),
                        "actions": stored.get("actions", []),
                        "tool_bindings": tool_bindings.get(provider.name, []),
                    }
                )
        
        if format == "json":
            click.echo(json.dumps({"workspace": workspace, "providers": providers_data}))
        else:
            if not providers_data:
                console.print(f"No providers configured for workspace '{workspace}'")
                return
            
            table = Table(title=f"Providers for workspace '{workspace}'")
            table.add_column("Name", style="cyan")
            table.add_column("Definition", style="yellow")
            table.add_column("Auth", style="blue")
            table.add_column("Endpoint", style="magenta")
            table.add_column("Credential", style="green")
            table.add_column("Mode", style="white")
            table.add_column("Tools", style="yellow")
            
            for provider in providers_data:
                provider_tool_bindings = list(provider.get("tool_bindings") or [])
                if not provider_tool_bindings:
                    tools_text = "-"
                elif len(provider_tool_bindings) <= 2:
                    tools_text = ", ".join(provider_tool_bindings)
                else:
                    tools_text = f"{len(provider_tool_bindings)} tools ({', '.join(provider_tool_bindings[:2])}...)"

                table.add_row(
                    provider["name"],
                    provider.get("provider_definition") or "custom",
                    provider.get("auth_scheme") or "n/a",
                    provider.get("base_url") or "configured",
                    provider.get("credential_status") or "managed",
                    provider.get("mode") or provider.get("status") or "configured",
                    tools_text,
                )
            
            console.print(table)
        
    except Exception as e:
        logger.error("provider_list_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="test")
@click.argument("name")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
def provider_test(name: str, workspace: Optional[str]):
    """Test provider connectivity."""
    try:
        config_manager = ConfigManager()
        edition_adapter = get_deployment_edition_adapter()

        workspace = _require_workspace(config_manager, workspace)
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task(f"Testing provider '{name}'...", total=None)

            if edition_adapter.uses_gateway_execution():
                from caracal.deployment.gateway_client import GatewayClient

                gateway_url = edition_adapter.require_gateway_url()

                gateway_client = GatewayClient(
                    gateway_url=gateway_url,
                    config_manager=config_manager,
                    workspace=workspace,
                )
                try:
                    gateway_health = asyncio.run(gateway_client.check_connection())
                    providers = asyncio.run(gateway_client.get_available_providers())
                finally:
                    asyncio.run(gateway_client.close())

                selected = next((p for p in providers if p.name == name), None)
                is_healthy = bool(gateway_health.healthy and selected and selected.available)
                error_message = None
                if not gateway_health.healthy:
                    error_message = gateway_health.error
                elif not selected:
                    error_message = "Provider not found in gateway registry"
                elif not selected.available:
                    error_message = "Provider is currently unavailable"
            else:
                broker, _ = _build_oss_broker(config_manager, workspace)
                try:
                    health = asyncio.run(broker.test_provider(name))
                finally:
                    asyncio.run(broker.close())

                is_healthy = health.healthy
                error_message = health.error

            progress.update(task, completed=True)
        
        if is_healthy:
            console.print(f"[green]✓[/green] Provider '{name}' is healthy")
        else:
            console.print(f"[red]✗[/red] Provider '{name}' is unhealthy")
            if error_message:
                console.print(f"  Error: {error_message}")
        if not edition_adapter.uses_gateway_execution():
            console.print(f"  Reachable: {'yes' if health.reachable else 'no'}")
            console.print(f"  Status: {health.status_code if health.status_code is not None else 'n/a'}")
            console.print(f"  Latency: {health.latency_ms:.1f}ms")
            console.print(f"  Auth injected: {'yes' if health.auth_injected else 'no'}")
        
    except Exception as e:
        logger.error("provider_test_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@provider_group.command(name="remove")
@click.argument("name")
@click.option("--workspace", "-w", help="Workspace name (default: current workspace)")
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def provider_remove(name: str, workspace: Optional[str], force: bool):
    """Remove a provider configuration."""
    try:
        config_manager = ConfigManager()

        workspace = _require_workspace(config_manager, workspace)

        providers = _load_workspace_providers(config_manager, workspace)
        if name not in providers:
            raise click.ClickException(f"Provider not found: {name}")
        
        if not force:
            if not click.confirm(f"Remove provider '{name}'?"):
                console.print("Cancelled.")
                return

        provider = providers.pop(name)
        _save_workspace_providers(config_manager, workspace, providers)

        # Remove provider credential secret if managed by this registry.
        credential_ref = provider.get("credential_ref")
        if credential_ref:
            try:
                delete_workspace_provider_credential(workspace, credential_ref)
            except SecretNotFoundError:
                pass
        
        console.print(f"[green]✓[/green] Provider removed: {name}")
        
    except Exception as e:
        logger.error("provider_remove_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


# Migration and maintenance commands
@click.command(name="migrate")
@click.option("--from", "from_type", type=click.Choice(["repo"]), default="repo", help="Migration source type")
@click.option("--backup/--no-backup", default=True, help="Create backup before migration")
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def migrate_command(from_type: str, backup: bool, force: bool):
    """Migrate from repository-based installation to package-based."""
    try:
        if not force:
            console.print("[yellow]Warning:[/yellow] This will migrate your Caracal installation.")
            console.print("A backup will be created before migration.")
            if not click.confirm("Continue with migration?"):
                console.print("Cancelled.")
                return
        
        migration_manager = MigrationManager()
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Migrating installation...", total=None)
            
            if from_type == "repo":
                result = migration_manager.migrate_from_repository(backup=backup)
            
            progress.update(task, completed=True)
        
        if result.success:
            console.print(f"[green]✓[/green] Migration completed successfully")
            if backup:
                console.print(f"  Backup created at: {result.backup_path}")
        else:
            console.print(f"[red]✗[/red] Migration failed")
            for error in result.errors:
                console.print(f"  • {error}")
        
    except Exception as e:
        logger.error("migrate_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@click.command(name="doctor")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def doctor_command(format: str):
    """Run system health checks."""
    try:
        config_manager = ConfigManager()
        mode_manager = ModeManager()
        edition_adapter = get_deployment_edition_adapter()
        
        checks = []
        
        # Check 1: Configuration directory
        try:
            if config_manager.CONFIG_DIR.exists():
                checks.append({
                    "name": "Configuration Directory",
                    "status": "pass",
                    "message": f"Found at {config_manager.CONFIG_DIR}"
                })
            else:
                checks.append({
                    "name": "Configuration Directory",
                    "status": "fail",
                    "message": "Not found"
                })
        except Exception as e:
            checks.append({
                "name": "Configuration Directory",
                "status": "fail",
                "message": str(e)
            })
        
        # Check 2: Mode configuration
        try:
            mode = mode_manager.get_mode()
            checks.append({
                "name": "Mode Configuration",
                "status": "pass",
                "message": f"Mode: {mode.value}"
            })
        except Exception as e:
            checks.append({
                "name": "Mode Configuration",
                "status": "fail",
                "message": str(e)
            })
        
        # Check 3: Edition configuration
        try:
            edition = edition_adapter.get_edition()
            checks.append({
                "name": "Edition Configuration",
                "status": "pass",
                "message": f"Edition: {edition.value}"
            })
        except Exception as e:
            checks.append({
                "name": "Edition Configuration",
                "status": "fail",
                "message": str(e)
            })
        
        # Check 4: Workspaces
        try:
            workspaces = config_manager.list_workspaces()
            if workspaces:
                checks.append({
                    "name": "Workspaces",
                    "status": "pass",
                    "message": f"Found {len(workspaces)} workspace(s)"
                })
            else:
                checks.append({
                    "name": "Workspaces",
                    "status": "warn",
                    "message": "No workspaces found"
                })
        except Exception as e:
            checks.append({
                "name": "Workspaces",
                "status": "fail",
                "message": str(e)
            })
        
        # Check 5: PostgreSQL configuration
        try:
            postgres_config = config_manager.get_postgres_config()
            if postgres_config:
                checks.append({
                    "name": "PostgreSQL Configuration",
                    "status": "pass",
                    "message": f"Configured: {postgres_config.host}:{postgres_config.port}"
                })
            else:
                workspace_db_message = _get_active_workspace_db_message()
                if workspace_db_message:
                    checks.append({
                        "name": "PostgreSQL Configuration",
                        "status": "pass",
                        "message": workspace_db_message,
                    })
                else:
                    checks.append({
                        "name": "PostgreSQL Configuration",
                        "status": "warn",
                        "message": "Not configured"
                    })
        except Exception as e:
            checks.append({
                "name": "PostgreSQL Configuration",
                "status": "fail",
                "message": str(e)
            })
        
        # Output results
        if format == "json":
            overall_status = "healthy"
            if any(c["status"] == "fail" for c in checks):
                overall_status = "unhealthy"
            elif any(c["status"] == "warn" for c in checks):
                overall_status = "degraded"
            
            click.echo(json.dumps({
                "overall_status": overall_status,
                "checks": checks,
                "timestamp": datetime.now().isoformat()
            }))
        else:
            console.print("\n[bold]System Health Check[/bold]\n")
            
            for check in checks:
                status_icon = {
                    "pass": "[green]✓[/green]",
                    "warn": "[yellow]⚠[/yellow]",
                    "fail": "[red]✗[/red]"
                }[check["status"]]
                
                console.print(f"{status_icon} {check['name']}")
                console.print(f"  {check['message']}\n")
            
            # Overall status
            if any(c["status"] == "fail" for c in checks):
                console.print("[red]Overall Status: Unhealthy[/red]")
            elif any(c["status"] == "warn" for c in checks):
                console.print("[yellow]Overall Status: Degraded[/yellow]")
            else:
                console.print("[green]Overall Status: Healthy[/green]")
        
    except Exception as e:
        logger.error("doctor_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@click.command(name="version")
@click.option("--check-updates", is_flag=True, help="Check for available updates")
@click.option("--format", "-f", type=click.Choice(["table", "json"]), default="table", help="Output format")
def version_command(check_updates: bool, format: str):
    """Show version information."""
    try:
        from caracal._version import __version__
        
        version_checker = get_version_checker()
        local_version = version_checker.parse_version(__version__)
        
        if format == "json":
            result = {
                "local_version": str(local_version),
                "major": local_version.major,
                "minor": local_version.minor,
                "patch": local_version.patch
            }
            
            if check_updates:
                # Check for updates (placeholder - would need actual implementation)
                result["updates_available"] = False
            
            click.echo(json.dumps(result))
        else:
            console.print(f"Caracal version: [bold]{local_version}[/bold]")
            
            if check_updates:
                console.print("\n[yellow]Note:[/yellow] Update checking not yet implemented")
        
    except Exception as e:
        logger.error("version_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)



@click.command(name="completion")
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish"]))
def completion_command(shell: str):
    """Generate shell completion script."""
    try:
        # Generate completion script based on shell type
        if shell == "bash":
            script = """
# Caracal bash completion
_caracal_completion() {
    local IFS=$'\\n'
    COMPREPLY=( $( env COMP_WORDS="${COMP_WORDS[*]}" \\
                   COMP_CWORD=$COMP_CWORD \\
                   _CARACAL_COMPLETE=complete $1 ) )
    return 0
}

complete -F _caracal_completion -o default caracal
"""
        elif shell == "zsh":
            script = """
# Caracal zsh completion
#compdef caracal

_caracal_completion() {
    eval $(env COMMANDLINE="${words[1,$CURRENT]}" _CARACAL_COMPLETE=complete-zsh caracal)
}

if [[ "$(basename -- ${(%):-%x})" != "_caracal" ]]; then
    compdef _caracal_completion caracal
fi
"""
        elif shell == "fish":
            script = """
# Caracal fish completion
function __fish_caracal_complete
    set -lx _CARACAL_COMPLETE fish_complete
    set -lx COMP_WORDS (commandline -opc) (commandline -ct)
    caracal
end

complete --no-files --command caracal --arguments '(__fish_caracal_complete)'
"""
        else:
            console.print(f"[red]Error:[/red] Unsupported shell: {shell}")
            sys.exit(1)
        
        click.echo(script)
        
        # Print installation instructions
        console.print(f"\n[green]To enable completion, add this to your {shell} config:[/green]")
        if shell == "bash":
            console.print("  eval \"$(caracal completion bash)\"")
            console.print("  # Or add to ~/.bashrc")
        elif shell == "zsh":
            console.print("  eval \"$(caracal completion zsh)\"")
            console.print("  # Or add to ~/.zshrc")
        elif shell == "fish":
            console.print("  caracal completion fish > ~/.config/fish/completions/caracal.fish")
        
    except Exception as e:
        logger.error("completion_failed", error=str(e))
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)
