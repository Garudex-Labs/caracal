"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Onboarding Screen.

First-run setup wizard with:
- Step 1: Configuration path selection
- Step 2: Database setup (optional)
- Step 3: First principal registration
- Skip options with actionable to-dos
"""

import os
from pathlib import Path
from typing import Any, Optional

from rich.console import Console

from caracal.cli.provider_scopes import validate_provider_scopes
from caracal.deployment.config_manager import ConfigManager
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.components.wizard import Wizard, WizardStep
from caracal.flow.screens._provider_scope_helpers import load_provider_scope_catalog
from caracal.flow.state import FlowState, StatePersistence
from caracal.flow.theme import Colors, Icons
from caracal.identity.service import IdentityService
from caracal.pathing import ensure_source_tree, source_of
from caracal.runtime.host_io import (
    host_io_root,
    in_container_runtime,
    map_common_host_io_path,
    normalize_optional_text,
)
from caracal.storage.layout import resolve_caracal_home


def _find_env_file() -> Optional[Path]:
    """Find the .env file by searching multiple locations.
    
    Search order:
    1. Current working directory
    2. Project root (walk up from this file to find pyproject.toml/setup.py)
    3. Source directories of CWD (up to 5 levels)
    
    Returns:
        Path to .env file, or None if not found.
    """
    # 1. Current working directory
    cwd_env = Path.cwd() / ".env"
    if cwd_env.exists():
        return cwd_env
    
    # 2. Project root — walk up from this source file
    try:
        source_dir = source_of(Path(__file__).resolve())
        for _ in range(10):  # max 10 levels up
            candidate = source_dir / ".env"
            if candidate.exists():
                return candidate
            # Check if this looks like a project root
            if (source_dir / "pyproject.toml").exists() or (source_dir / "setup.py").exists():
                # We're at project root but no .env — stop looking upward
                break
            ancestor = source_of(source_dir)
            if ancestor == source_dir:  # filesystem root
                break
            source_dir = ancestor
    except Exception:
        pass
    
    # 3. Walk up from CWD (handles running from subdirectories)
    try:
        current = Path.cwd()
        for _ in range(5):
            ancestor = source_of(current)
            if ancestor == current:
                break
            current = ancestor
            candidate = current / ".env"
            if candidate.exists():
                return candidate
    except Exception:
        pass
    
    return None


def _resolve_active_workspace_name() -> str:
    """Resolve the active workspace name for shared provider scope validation."""
    config_manager = ConfigManager()
    workspace_name = config_manager.get_default_workspace_name()
    if workspace_name:
        return str(workspace_name)

    workspaces = config_manager.list_workspaces()
    if not workspaces:
        raise RuntimeError("No active workspace found for provider scope validation")
    return str(workspaces[0])


def _get_db_config_from_env() -> dict:
    """Load database configuration from runtime env and .env.

    Precedence:
    1. Runtime environment variables (CCL_DB_*)
    2. .env file values
    3. Sensible defaults

    In container runtime mode, defaults are container-aware so onboarding can
    proceed without requiring a local .env file.
    """
    running_in_container = in_container_runtime()
    config = {
        "host": "postgres" if running_in_container else "localhost",
        "port": 5432,
        "database": "caracal",
        "username": "caracal",
        "password": "caracal" if running_in_container else "",
    }
    loaded_from_env_file = False
    loaded_from_runtime_env = False

    def _set_config_value(key: str, raw_value: str) -> None:
        value = raw_value.strip()
        if key == "port":
            try:
                config[key] = int(value)
            except ValueError:
                return
            return
        config[key] = value

    try:
        env_path = _find_env_file()
        if env_path and env_path.exists():
            import re
            content = env_path.read_text()
            mapping = {
                "host": r"^CCL_DB_HOST=(.*)$",
                "port": r"^CCL_DB_PORT=(.*)$",
                "database": r"^CCL_DB_NAME=(.*)$",
                "username": r"^CCL_DB_USER=(.*)$",
                "password": r"^CCL_DB_PASSWORD=(.*)$",
            }
            for key, pattern in mapping.items():
                match = re.search(pattern, content, re.MULTILINE)
                if match:
                    _set_config_value(key, match.group(1))
                    loaded_from_env_file = True
            config["_env_path"] = str(env_path)  # Track where we loaded from

        runtime_mapping = {
            "host": "CCL_DB_HOST",
            "port": "CCL_DB_PORT",
            "database": "CCL_DB_NAME",
            "username": "CCL_DB_USER",
            "password": "CCL_DB_PASSWORD",
        }
        for key, env_var in runtime_mapping.items():
            raw = os.environ.get(env_var)
            if raw is None or raw == "":
                continue
            _set_config_value(key, raw)
            loaded_from_runtime_env = True

        if loaded_from_runtime_env and loaded_from_env_file:
            config["_env_source"] = "runtime environment + .env file"
        elif loaded_from_runtime_env:
            config["_env_source"] = "runtime environment"
        elif loaded_from_env_file:
            config["_env_source"] = ".env file"
    except Exception:
        pass
    return config


def _save_db_config_to_env(config: dict) -> bool:
    """Save database configuration back to .env file."""
    try:
        env_path = _find_env_file()
        if env_path is None:
            # No existing .env found — create one in CWD
            env_path = Path.cwd() / ".env"
        if env_path.exists():
            import re
            content = env_path.read_text()
            mapping = {
                "CCL_DB_HOST": config.get("host", "localhost"),
                "CCL_DB_PORT": str(config.get("port", 5432)),
                "CCL_DB_NAME": config.get("database", "caracal"),
                "CCL_DB_USER": config.get("username", "caracal"),
                "CCL_DB_PASSWORD": config.get("password", ""),
            }
            for key, val in mapping.items():
                if re.search(f"^{key}=", content, re.MULTILINE):
                    content = re.sub(f"^{key}=.*$", f"{key}={val}", content, flags=re.MULTILINE)
                else:
                    content += f"\n{key}={val}"
            # Credentials stored in .env by design; restrict permissions to owner-only.
            env_path.write_text(content)  # lgtm[py/clear-text-storage-of-sensitive-data]
            try:
                env_path.chmod(0o600)
            except Exception:
                pass
            return True
        else:
            # Create a new .env file with database config
            lines = [
                "# Caracal Core - Environment Variables",
                "# Database Configuration",
                f"CCL_DB_HOST={config.get('host', 'localhost')}",
                f"CCL_DB_PORT={config.get('port', 5432)}",
                f"CCL_DB_NAME={config.get('database', 'caracal')}",
                f"CCL_DB_USER={config.get('username', 'caracal')}",
                f"CCL_DB_PASSWORD={config.get('password', '')}",
                "",
            ]
            # Credentials stored in .env by design; restrict permissions to owner-only.
            env_path.write_text("\n".join(lines))  # lgtm[py/clear-text-storage-of-sensitive-data]
            try:
                env_path.chmod(0o600)
            except Exception:
                pass
            return True
    except Exception:
        pass
    return False


def _test_db_connection(config: dict) -> tuple[bool, str]:
    """Test PostgreSQL connection with given config."""
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=config.get("host", "localhost"),
            port=int(config.get("port", 5432)),
            database=config.get("database", "caracal"),
            user=config.get("username", "caracal"),
            password=config.get("password", ""),
            connect_timeout=5
        )
        conn.close()
        return True, ""
    except Exception as e:
        return False, str(e)


def _sync_workspace_selection(workspace_name: str) -> None:
    """Best-effort synchronization of selected workspace across all selectors."""
    try:
        from caracal.flow.workspace import WorkspaceManager

        WorkspaceManager.set_default_workspace(workspace_name)
    except Exception:
        pass

    try:
        from caracal.deployment.config_manager import ConfigManager

        config_manager = ConfigManager()
        if workspace_name in config_manager.list_workspaces():
            config_manager.set_default_workspace(workspace_name)
    except Exception:
        pass


def _resolve_workspace_import_path(path: str) -> Path:
    normalized_path = path.strip().replace("\r", "").replace("\n", "")
    candidate = Path(normalized_path).expanduser()
    resolved = candidate.resolve(strict=False)

    # Outside container runtime, use the exact user-provided path.
    if not in_container_runtime():
        return resolved

    # In container runtime, prefer direct paths that already exist.
    if resolved.exists():
        return resolved

    # In container runtime, help users by mapping common host-export paths.
    root = host_io_root()
    mapped = map_common_host_io_path(resolved, root)
    if mapped is not None:
        return mapped

    # For relative paths in container runtime, treat them as host-io-root relative.
    if not candidate.is_absolute():
        return (root / candidate).resolve(strict=False)

    return resolved


def _step_workspace(wizard: Wizard) -> Any:
    """Step 0: Workspace selection/creation/deletion/import.
    
    CRITICAL: This step cannot be skipped. A workspace must be selected
    or created before proceeding to the main menu, as it defines where
    all configuration and data will be stored.
    
    Returns:
        str: Path to the selected/created workspace

    Raises:
        RuntimeError: If the workspace action is not handled (menu out of sync)
        KeyboardInterrupt: If user cancels (propagates to caller)
    """
    console = wizard.console
    prompt = FlowPrompt(console)
    
    from caracal.flow.workspace import WorkspaceManager, set_workspace
    
    console.print(f"  [{Colors.NEUTRAL}]Caracal can manage multiple workspaces (organizations).")
    console.print(f"  [{Colors.DIM}]Each workspace has its own configuration, data, and agents.[/]")
    console.print()
    
    # List existing workspaces
    workspaces = WorkspaceManager.list_workspaces()
    
    if workspaces:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Existing workspaces:[/]")
        console.print()
        
        from rich.table import Table
        table = Table(show_header=True, header_style=f"bold {Colors.PRIMARY}", border_style=Colors.DIM)
        table.add_column("#", style=Colors.NEUTRAL, width=4)
        table.add_column("Name", style=Colors.INFO)
        table.add_column("Path", style=Colors.DIM)
        
        for idx, workspace in enumerate(workspaces, 1):
            table.add_row(str(idx), workspace["name"], workspace["path"])
        
        console.print(table)
        console.print()
    
    # Present options
    choices = []
    if workspaces:
        choices.append("Select existing workspace")
    choices.extend([
        "Create new workspace",
        "Import workspace",
    ])
    if workspaces:
        choices.append("Delete workspace")
        choices.append("Delete all workspaces")
    
    action = prompt.select(
        "What would you like to do?",
        choices=choices,
    )
    
    # Handle workspace selection
    if action == "Select existing workspace":
        workspace_names = [workspace["name"] for workspace in workspaces]
        selected_name = prompt.select(
            "Select workspace",
            choices=workspace_names,
        )
        
        selected_workspace = next(workspace for workspace in workspaces if workspace["name"] == selected_name)
        workspace_path = Path(selected_workspace["path"])
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Selected workspace: {selected_name}[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        
        # Set the selected workspace as active
        set_workspace(workspace_path)
        _sync_workspace_selection(selected_name)
        wizard.context["workspace_path"] = str(workspace_path)
        wizard.context["workspace_name"] = selected_name
        wizard.context["workspace_existing"] = True
        
        # flow_state.json: if onboarding completed, later steps can auto-skip
        state_file = workspace_path / "flow_state.json"
        if state_file.exists():
            try:
                import json as _json
                state_data = _json.loads(state_file.read_text())
                ob = state_data.get("onboarding", {})
                if ob.get("completed", False):
                    wizard.context["previously_onboarded"] = True
                    wizard.context["completed_steps"] = ob.get("steps_completed", [])
            except Exception:
                pass
        
        return str(workspace_path)
    
    elif action == "Create new workspace":
        console.print()
        workspace_name = prompt.text(
            "Workspace name",
            default="my-workspace",
        )
        
        # Always create new workspaces under canonical CCL_HOME/workspaces.
        default_base = resolve_caracal_home(require_explicit=False) / "workspaces"
        workspace_path = default_base / workspace_name.lower().replace(" ", "-")
        
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Creating workspace: {workspace_name}[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        
        # Create directory
        ensure_source_tree(workspace_path)
        
        # Register workspace
        WorkspaceManager.register_workspace(workspace_name, workspace_path)
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace created and registered[/]")
        
        # Set the new workspace as active
        set_workspace(workspace_path)
        _sync_workspace_selection(workspace_name)
        wizard.context["workspace_path"] = str(workspace_path)
        wizard.context["workspace_name"] = workspace_name
        wizard.context["workspace_existing"] = False
        wizard.context["fresh_start"] = True
        
        return str(workspace_path)

    elif action == "Import workspace":
        from caracal.deployment.config_manager import ConfigManager

        console.print()
        if in_container_runtime():
            console.print(
                f"  [{Colors.DIM}]Tip: In container runtime, host-shared files are usually under {host_io_root()}[/]"
            )

        import_path_text = prompt.text("Import file path")

        try:
            resolved_import_path = _resolve_workspace_import_path(import_path_text)
        except ValueError as e:
            console.print()
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} {e}[/]")
            console.print()
            return _step_workspace(wizard)

        if not resolved_import_path.exists():
            console.print()
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} File not found: {resolved_import_path}[/]")
            console.print()
            return _step_workspace(wizard)

        console.print()
        imported_name_override = prompt.text(
            "Workspace name (leave empty to use original)",
            default="",
            required=False,
        ).strip()

        import_lock_key = prompt.password(
            "Import key (leave empty for unlocked archive)",
            default="",
        )
        normalized_import_lock_key = normalize_optional_text(import_lock_key)

        existing_names = set(ConfigManager().list_workspaces())

        try:
            config_manager = ConfigManager()
            config_manager.import_workspace(
                resolved_import_path,
                name=imported_name_override if imported_name_override else None,
                lock_key=normalized_import_lock_key,
            )
        except Exception as e:
            console.print()
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to import workspace: {e}[/]")
            console.print()
            return _step_workspace(wizard)

        imported_name = imported_name_override
        if not imported_name:
            updated_names = set(config_manager.list_workspaces())
            new_names = sorted(updated_names - existing_names)
            if len(new_names) == 1:
                imported_name = new_names[0]

        console.print()
        console.print(
            f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace imported from: {resolved_import_path}[/]"
        )

        if imported_name:
            try:
                workspace_path = config_manager.get_workspace_path(imported_name)
                set_workspace(workspace_path)
                _sync_workspace_selection(imported_name)
                wizard.context["workspace_path"] = str(workspace_path)
                wizard.context["workspace_name"] = imported_name
                wizard.context["workspace_existing"] = True
                wizard.context["exit_onboarding_after_workspace_import"] = True

                # Imported archives may not include full runtime config. Seed it
                # so returning directly to main menu does not land in a broken state.
                try:
                    _initialize_caracal_dir(workspace_path, wipe=False)
                    wizard.context["config_path"] = str(workspace_path)

                    config_file = workspace_path / "config.yaml"
                    if config_file.exists():
                        import yaml

                        with open(config_file, "r") as f:
                            config_yaml = yaml.safe_load(f) or {}

                        db_section = config_yaml.get("database") if isinstance(config_yaml, dict) else None
                        if not db_section:
                            env_config = _get_db_config_from_env()
                            env_issues = _validate_env_config(dict(env_config))
                            if not env_issues:
                                schema_name = _resolve_workspace_schema(imported_name, wizard.context)
                                config_yaml["database"] = {
                                    "type": "postgresql",
                                    "host": env_config["host"],
                                    "port": env_config["port"],
                                    "database": env_config["database"],
                                    "user": env_config["username"],
                                    "password": env_config["password"],
                                    "schema": schema_name,
                                }
                                with open(config_file, "w") as f:
                                    yaml.safe_dump(config_yaml, f, default_flow_style=False, sort_keys=False)
                except Exception:
                    pass

                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Selected workspace: {imported_name}[/]")
                console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")

                # Importing an existing workspace should return directly to the main menu.
                wizard.cancel()
                return str(workspace_path)
            except Exception:
                pass

        console.print(f"  [{Colors.INFO}]{Icons.INFO} Choose the imported workspace from the list.[/]")
        console.print()
        return _step_workspace(wizard)
    
    elif action == "Delete workspace":
        workspace_names = [workspace["name"] for workspace in workspaces]
        selected_name = prompt.select(
            "Select workspace to delete",
            choices=workspace_names,
        )
        
        selected_workspace = next(workspace for workspace in workspaces if workspace["name"] == selected_name)
        workspace_path = Path(selected_workspace["path"])
        
        console.print()
        console.print(f"  [{Colors.WARNING}]⚠️  WARNING: This will delete workspace '{selected_name}'[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        console.print()
        
        delete_files = prompt.confirm(
            "Also delete workspace directory from disk?",
            default=False,
        )
        
        confirm = prompt.confirm(
            f"Are you sure you want to delete '{selected_name}'?",
            default=False,
        )
        
        if confirm:
            WorkspaceManager.delete_workspace(
                workspace_path,
                delete_directory=delete_files,
            )
            console.print()
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace deleted[/]")
            console.print()
            
            # Restart workspace selection
            return _step_workspace(wizard)
        else:
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Deletion cancelled[/]")
            console.print()
            # Restart workspace selection
            return _step_workspace(wizard)

    elif action == "Delete all workspaces":
        console.print()
        console.print(f"  [{Colors.WARNING}]⚠️  WARNING: This will remove ALL registered workspaces[/]")
        console.print(f"  [{Colors.DIM}]Count: {len(workspaces)} workspace(s)[/]")
        console.print()

        delete_files = prompt.confirm(
            "Also delete all workspace directories from disk?",
            default=False,
        )

        confirm = prompt.confirm(
            "Are you sure you want to delete all workspaces?",
            default=False,
        )

        if confirm:
            deleted_count = WorkspaceManager.delete_all_workspaces(
                delete_directories=delete_files,
            )
            console.print()
            console.print(
                f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Deleted {deleted_count} workspace(s)[/]"
            )
            console.print()
            return _step_workspace(wizard)

        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Bulk deletion cancelled[/]")
        console.print()
        return _step_workspace(wizard)

    # Unhandled action — keep in sync with workspace menu choices
    console.print()
    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} No workspace action selected[/]")
    raise RuntimeError("Workspace selection is required to continue")


def _step_config(wizard: Wizard) -> Any:
    """Step 1: Configuration setup."""
    console = wizard.console

    from caracal.flow.workspace import get_workspace

    workspace_path = wizard.context.get("workspace_path")
    if workspace_path:
        config_path = Path(workspace_path)
    else:
        config_path = get_workspace().root

    # Keep workspace config aligned with hard-cut requirements before any
    # downstream load/validation paths run.
    try:
        _normalize_workspace_merkle_hardcut_config(config_path)
    except Exception:
        pass
    
    # If workspace was just created, initialize fresh config
    if wizard.context.get("workspace_existing") is False:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Initializing new workspace configuration...[/]")
        
        try:
            _initialize_caracal_dir(config_path, wipe=True)
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration initialized at {config_path}[/]")
        except Exception as e:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed: {e}[/]")
            raise
        
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    
    if wizard.context.get("workspace_existing") and config_path.exists() and (config_path / "config.yaml").exists():
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Using existing configuration at {config_path}[/]")
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    
    console.print(f"  [{Colors.NEUTRAL}]Caracal stores its configuration and data files in a directory.")
    console.print(f"  [{Colors.DIM}]Location: {config_path}[/]")
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Initializing configuration...[/]")
    
    try:
        _initialize_caracal_dir(config_path, wipe=False)
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration initialized at {config_path}[/]")
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to initialize: {e}[/]")
        raise


def _initialize_caracal_dir(path: Path, wipe: bool = False) -> None:
    """Initialize Caracal directory structure."""
    if wipe and path.exists():
        import shutil
        # Wipe data files but keep the directory
        for item in path.iterdir():
            if item.is_file():
                item.unlink()
            elif item.is_dir() and item.name != "backups":
                shutil.rmtree(item)

    # Create directories
    ensure_source_tree(path)
    (path / "backups").mkdir(exist_ok=True)
    (path / "logs").mkdir(exist_ok=True)
    (path / "cache").mkdir(exist_ok=True)
    (path / "keys").mkdir(exist_ok=True)
    
    # Create default config if needed
    config_path = path / "config.yaml"
    if not config_path.exists():
        import yaml

        vault_key_ref = os.environ.get("CCL_VAULT_MERKLE_SIGNING_KEY_REF", "")
        vault_public_key_ref = os.environ.get("CCL_VAULT_MERKLE_PUB_KEY_REF", "")
        default_config = {
            "storage": {
                "backup_dir": str(path / "backups"),
                "backup_count": 3,
            },
            "defaults": {
                "time_window": "daily",
            },
            "logging": {
                "level": "INFO",
                "file": str(path / "logs" / "caracal.log"),
            },
            "redis": {
                "host": "localhost",
                "port": 6379,
                "db": 0,
            },
            "merkle": {
                "signing_backend": "vault",
                "signing_algorithm": "ES256",
                "vault_key_ref": vault_key_ref,
                "vault_public_key_ref": vault_public_key_ref,
            },
        }
        with open(config_path, "w") as f:
            f.write("# Caracal Core Configuration\n\n")
            yaml.safe_dump(default_config, f, default_flow_style=False, sort_keys=False)

    _normalize_workspace_merkle_hardcut_config(path)
    
    # All authority data is managed by PostgreSQL.
    
    # Note: SQLite no longer supported — PostgreSQL only.
    # Legacy .db files are left in place (harmless) for manual cleanup.


def _resolve_workspace_schema(workspace_name: str, context: dict) -> str:
    """Return a stable, strongly-isolated schema for the workspace.

    Schema format: ``workspace_<slug>_<created_ts>_<hash>``.
    This prevents schema collisions when users delete and recreate a workspace
    with the same name.
    """
    import hashlib
    import re as _re

    slug = _re.sub(r"[^a-z0-9_]", "_", (workspace_name or "workspace").lower()).strip("_")
    slug = slug or "workspace"

    from datetime import datetime as _dt
    from uuid import uuid4 as _uuid4

    created_tag = _dt.utcnow().strftime("%Y%m%d%H%M%S")
    workspace_path = context.get("workspace_path") or ""
    entropy_nonce = ""

    try:
        from caracal.deployment.config_manager import ConfigManager
        cfg_mgr = ConfigManager()
        workspace_cfg = cfg_mgr.get_workspace_config(workspace_name)
        created_tag = workspace_cfg.created_at.strftime("%Y%m%d%H%M%S")
        if not workspace_path:
            workspace_path = str(cfg_mgr.get_workspace_path(workspace_name))
    except Exception:
        entropy_nonce = _uuid4().hex[:8]

    entropy_src = f"{workspace_name}|{workspace_path}|{created_tag}|{entropy_nonce}"
    suffix = hashlib.sha1(entropy_src.encode("utf-8")).hexdigest()[:8]

    max_slug_len = 63 - len("workspace__") - len(created_tag) - len(suffix)
    safe_slug = slug[:max(8, max_slug_len)]
    return f"workspace_{safe_slug}_{created_tag}_{suffix}"


def _select_persisted_workspace_schema(
    existing_schema: Optional[str],
    proposed_schema: str,
) -> str:
    """Preserve any existing schema to keep workspace data stable across UX paths."""
    normalized_existing = str(existing_schema or "").strip()
    if normalized_existing:
        return normalized_existing
    return proposed_schema


def _normalize_workspace_merkle_hardcut_config(workspace_path: Path) -> None:
    """Normalize workspace config to hard-cut Merkle vault signing settings."""
    config_file = workspace_path / "config.yaml"
    if not config_file.exists():
        return

    try:
        import yaml

        config_yaml = yaml.safe_load(config_file.read_text()) or {}
        if not isinstance(config_yaml, dict):
            return

        merkle = config_yaml.get("merkle")
        if not isinstance(merkle, dict):
            merkle = {}

        vault_key_ref = os.environ.get("CCL_VAULT_MERKLE_SIGNING_KEY_REF", "")
        vault_public_key_ref = os.environ.get("CCL_VAULT_MERKLE_PUB_KEY_REF", "")

        updated_merkle = dict(merkle)
        updated_merkle["signing_backend"] = "vault"
        updated_merkle["signing_algorithm"] = updated_merkle.get("signing_algorithm") or "ES256"
        updated_merkle["vault_key_ref"] = (
            updated_merkle.get("vault_key_ref")
            or vault_key_ref
            or "${CCL_VAULT_MERKLE_SIGNING_KEY_REF}"
        )
        updated_merkle["vault_public_key_ref"] = (
            updated_merkle.get("vault_public_key_ref")
            or vault_public_key_ref
            or "${CCL_VAULT_MERKLE_PUB_KEY_REF}"
        )
        updated_merkle.pop("private_key_path", None)

        if merkle != updated_merkle:
            config_yaml["merkle"] = updated_merkle
            with open(config_file, "w") as f:
                yaml.safe_dump(config_yaml, f, default_flow_style=False, sort_keys=False)
    except Exception:
        return


def _validate_env_config(config: dict) -> list[str]:
    """Validate that all required PostgreSQL env vars are properly set.
    
    Required: CCL_DB_NAME, CCL_DB_USER, CCL_DB_PASSWORD,
    CCL_DB_PORT (valid range).
    Optional: CCL_DB_HOST (defaults to 'localhost' which is fine).
    
    Returns a list of missing/invalid fields. Empty list means all valid.
    """
    issues = []
    # host is optional — defaults to localhost which is valid for local setups
    if not config.get("database"):
        issues.append("CCL_DB_NAME is missing or empty")
    if not config.get("username"):
        issues.append("CCL_DB_USER is missing or empty")
    if not config.get("password"):
        issues.append("CCL_DB_PASSWORD is missing or empty — required for PostgreSQL")
    port = config.get("port")
    if not isinstance(port, int) or port < 1 or port > 65535:
        issues.append(f"CCL_DB_PORT has invalid value: {port}")
    return issues


def _start_postgresql(console: Console, method: str = "auto") -> tuple[bool, str]:
    """Attempt to start PostgreSQL automatically.
    
    Tries multiple methods in order:
    1. docker compose -f deploy/docker-compose.yml up -d postgres
    2. systemctl start postgresql     (if systemd is available)
    3. pg_ctl start                   (direct pg_ctl)
    
    Args:
        console: Rich console for output
        method: "auto" tries all, or "docker", "systemctl", "pg_ctl"
    
    Returns:
        (success: bool, message: str)
    """
    import subprocess
    import shutil
    import time
    
    compose_file = _find_deploy_compose_file()
    methods_to_try = []
    
    if method == "auto":
        # Check which methods are available
        if compose_file is not None and shutil.which("docker"):
            methods_to_try.append("docker")
        if shutil.which("systemctl"):
            methods_to_try.append("systemctl")
        if shutil.which("pg_ctl"):
            methods_to_try.append("pg_ctl")
    else:
        methods_to_try = [method]
    
    if not methods_to_try:
        return False, "No method available to start PostgreSQL (no docker, systemctl, or pg_ctl found)"
    
    for m in methods_to_try:
        if m == "docker":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via docker compose...[/]")
            try:
                result = subprocess.run(
                    ["docker", "compose", "-f", str(compose_file), "up", "-d", "postgres"],
                    capture_output=True, text=True, timeout=60,
                )
                if result.returncode == 0:
                    # Wait for PostgreSQL to become ready
                    console.print(f"  [{Colors.INFO}]{Icons.INFO} Waiting for PostgreSQL to become ready...[/]")
                    for i in range(15):  # wait up to 15 seconds
                        time.sleep(1)
                        check = subprocess.run(
                            ["docker", "compose", "-f", str(compose_file), "exec", "-T", "postgres",
                             "pg_isready", "-U", "caracal"],
                            capture_output=True, text=True, timeout=5,
                        )
                        if check.returncode == 0:
                            return True, "PostgreSQL started via docker compose"
                    return False, f"Docker container started but PostgreSQL not ready after 15s. Logs:\n{result.stderr}"
                else:
                    console.print(f"  [{Colors.DIM}]docker compose failed: {result.stderr.strip()}[/]")
            except subprocess.TimeoutExpired:
                console.print(f"  [{Colors.DIM}]docker compose timed out[/]")
            except FileNotFoundError:
                pass
        
        elif m == "systemctl":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via systemctl...[/]")
            try:
                result = subprocess.run(
                    ["sudo", "systemctl", "start", "postgresql"],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode == 0:
                    time.sleep(2)
                    return True, "PostgreSQL started via systemctl"
                else:
                    console.print(f"  [{Colors.DIM}]systemctl failed: {result.stderr.strip()}[/]")
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
        
        elif m == "pg_ctl":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via pg_ctl...[/]")
            try:
                result = subprocess.run(
                    ["pg_ctl", "start", "-D", "/var/lib/postgresql/data", "-l", "/tmp/pg.log"],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode == 0:
                    time.sleep(2)
                    return True, "PostgreSQL started via pg_ctl"
                else:
                    console.print(f"  [{Colors.DIM}]pg_ctl failed: {result.stderr.strip()}[/]")
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
    
    return False, "All start methods failed. Please start PostgreSQL manually."


def _find_deploy_compose_file() -> Optional[Path]:
    """Find the canonical deploy compose file from the current working tree."""
    for base in (Path.cwd(), *Path.cwd().parents):
        candidate = base / "deploy" / "docker-compose.yml"
        if candidate.exists():
            return candidate
    return None


def _load_existing_db_config(wizard: Wizard, console: Console) -> Any:
    """Try to load database config from an existing workspace's config.yaml.
    
    Returns the database context dict if found, or None if no DB config exists
    (so the caller should fall through to the normal setup flow).
    """
    workspace_path = wizard.context.get("workspace_path")
    if not workspace_path:
        return None
    
    config_file = Path(workspace_path) / "config.yaml"
    if not config_file.exists():
        return None
    
    try:
        import yaml
        with open(config_file, "r") as f:
            config_yaml = yaml.safe_load(f) or {}
        
        db_section = config_yaml.get("database")
        if not db_section:
            return None
        
        env_config = {
            "host": db_section.get("host", "localhost"),
            "port": int(db_section.get("port", 5432)),
            "database": db_section.get("database", "caracal"),
            "username": db_section.get("user", "caracal"),
            "password": db_section.get("password", ""),
            "schema": str(db_section.get("schema", "")).strip(),
        }
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Using existing PostgreSQL configuration[/]")
        console.print(f"  [{Colors.DIM}]  Host:     {env_config['host']}:{env_config['port']}[/]")
        console.print(f"  [{Colors.DIM}]  Database: {env_config['database']}[/]")
        console.print(f"  [{Colors.DIM}]  User:     {env_config['username']}[/]")
        wizard.context["database"] = {**env_config, "type": "postgresql"}
        wizard.context["database_auto_configured"] = True
        return wizard.context["database"]
    except Exception:
        return None


def _step_database(wizard: Wizard) -> Any:
    """Step 2: Database setup — PostgreSQL only.
    
    Logic:
    - If existing workspace with database already configured, use it silently.
    - Validate env vars from .env; prompt user to fix if missing
    - Auto-start PostgreSQL if not running
    - Test connection; on failure show clear errors
    - Loop until PostgreSQL works — no fallback
    
    Database is mandatory. This step cannot be skipped.
    """
    console = wizard.console
    prompt = FlowPrompt(console)
    
    if wizard.context.get("workspace_existing"):
        db_result = _load_existing_db_config(wizard, console)
        if db_result is not None:
            return db_result
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Configuring PostgreSQL database...[/]")
    console.print()
    console.print(f"  [{Colors.NEUTRAL}]Caracal uses PostgreSQL as its database backend.[/]")
    console.print(f"  [{Colors.DIM}]Each workspace gets its own isolated PostgreSQL schema.[/]")
    console.print()
    
    while True:
        # 1. Load and validate env config
        env_config = _get_db_config_from_env()
        env_source = env_config.pop("_env_source", None)
        env_path_used = env_config.pop("_env_path", None)
        env_issues = _validate_env_config(env_config)

        if env_source:
            console.print(f"  [{Colors.DIM}]Loaded DB config from: {env_source}[/]")
            if env_path_used:
                console.print(f"  [{Colors.DIM}]Loaded .env from: {env_path_used}[/]")
        elif env_path_used:
            console.print(f"  [{Colors.DIM}]Loaded .env from: {env_path_used}[/]")
        else:
            console.print(f"  [{Colors.WARNING}]⚠️  No .env file found in current directory or project root[/]")
        console.print()
        
        if env_issues:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} PostgreSQL environment configuration incomplete:[/]")
            for issue in env_issues:
                console.print(f"    [{Colors.WARNING}]• {issue}[/]")
            console.print()
            host_hint = "postgres" if in_container_runtime() else "localhost"
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Please set these variables in runtime env or your .env file:[/]")
            console.print(f"  [{Colors.DIM}]  CCL_DB_HOST={host_hint}[/]")
            console.print(f"  [{Colors.DIM}]  CCL_DB_PORT=5432[/]")
            console.print(f"  [{Colors.DIM}]  CCL_DB_NAME=caracal[/]")
            console.print(f"  [{Colors.DIM}]  CCL_DB_USER=caracal[/]")
            console.print(f"  [{Colors.DIM}]  CCL_DB_PASSWORD=<your_password>[/]")
            console.print()
            
            fix_choice = prompt.select(
                "How would you like to proceed?",
                choices=[
                    "Enter credentials now (saves to .env)",
                    "I've updated .env — retry",
                ],
            )
            
            if fix_choice == "Enter credentials now (saves to .env)":
                console.print()
                pg_host = prompt.text("Host", default=env_config.get("host", "localhost"))
                pg_port = prompt.number("Port", default=env_config.get("port", 5432), min_value=1)
                pg_database = prompt.text("Database name", default=env_config.get("database", "caracal"))
                pg_user = prompt.text("Username", default=env_config.get("username", "caracal"))
                pg_password = prompt.text("Password", default="", hide_input=True)
                
                env_config = {
                    "host": pg_host,
                    "port": int(pg_port),
                    "database": pg_database,
                    "username": pg_user,
                    "password": pg_password,
                }
                
                if _save_db_config_to_env(env_config):
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Credentials saved to .env[/]")
                else:
                    console.print(f"  [{Colors.WARNING}]⚠️  Could not save to .env — please update manually[/]")
                console.print()
            else:
                # User says they updated .env — loop to re-read
                console.print()
                continue
            
            # Re-validate after user input
            env_issues = _validate_env_config(env_config)
            if env_issues:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Configuration still incomplete:[/]")
                for issue in env_issues:
                    console.print(f"    [{Colors.WARNING}]• {issue}[/]")
                console.print()
                continue
        
        # 2. Config is valid — show what we'll connect to
        console.print(f"  [{Colors.INFO}]{Icons.INFO} PostgreSQL configuration:[/]")
        console.print(f"  [{Colors.DIM}]  Host:     {env_config['host']}:{env_config['port']}[/]")
        console.print(f"  [{Colors.DIM}]  Database: {env_config['database']}[/]")
        console.print(f"  [{Colors.DIM}]  User:     {env_config['username']}[/]")
        console.print()
        
        # 3. Test connection
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Testing PostgreSQL connection...[/]")
        success, error = _test_db_connection(env_config)
        
        if success:
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL connected successfully![/]")
            console.print(f"  [{Colors.DIM}]Using PostgreSQL for data storage[/]")
            console.print()
            
            wizard.context["database"] = {**env_config, "type": "postgresql"}
            wizard.context["database_auto_configured"] = True
            return wizard.context["database"]
        
        # 4. Connection failed — show clear error and attempt auto-start
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} PostgreSQL connection failed![/]")
        console.print()
        
        _show_connection_error_details(console, error, env_config)
        
        # 5. Try to auto-start PostgreSQL if it looks like a connection issue
        is_connection_issue = any(phrase in error.lower() for phrase in [
            "connection refused", "could not connect", "timeout",
            "no such file or directory", "is the server running",
        ])
        
        if is_connection_issue:
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Attempting to start PostgreSQL automatically...[/]")
            start_ok, start_msg = _start_postgresql(console)
            
            if start_ok:
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} {start_msg}[/]")
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Re-testing connection...[/]")
                
                success2, error2 = _test_db_connection(env_config)
                if success2:
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL connected successfully![/]")
                    console.print(f"  [{Colors.DIM}]Using PostgreSQL for data storage[/]")
                    console.print()
                    
                    wizard.context["database"] = {**env_config, "type": "postgresql"}
                    wizard.context["database_auto_configured"] = True
                    return wizard.context["database"]
                else:
                    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Connection still failing after start: {error2}[/]")
            else:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Auto-start failed: {start_msg}[/]")
            console.print()
        
        # 6. PostgreSQL still not working — loop until resolved
        #    Let user fix the issue and retry
        console.print(f"  [{Colors.WARNING}]⚠️  PostgreSQL must be running to continue.[/]")
        console.print(f"  [{Colors.DIM}]Fix the issue above and retry — database integrity matters.[/]")
        console.print()
        
        action = prompt.select(
            "How would you like to proceed?",
            choices=[
                "Retry connection (after fixing the issue)",
                "Enter different credentials",
                "Start PostgreSQL manually (then retry)",
            ],
        )
        
        if action == "Enter different credentials":
            console.print()
            pg_host = prompt.text("Host", default=env_config.get("host", "localhost"))
            pg_port = prompt.number("Port", default=env_config.get("port", 5432), min_value=1)
            pg_database = prompt.text("Database name", default=env_config.get("database", "caracal"))
            pg_user = prompt.text("Username", default=env_config.get("username", "caracal"))
            pg_password = prompt.text("Password", default="", hide_input=True)
            
            env_config = {
                "host": pg_host,
                "port": int(pg_port),
                "database": pg_database,
                "username": pg_user,
                "password": pg_password,
            }
            
            # Save new creds to .env
            if _save_db_config_to_env(env_config):
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Credentials saved to .env[/]")
            console.print()
            
        elif action == "Start PostgreSQL manually (then retry)":
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Common commands to start PostgreSQL:[/]")
            console.print(f"  [{Colors.DIM}]  docker compose -f deploy/docker-compose.yml up -d postgres[/]")
            console.print(f"  [{Colors.DIM}]  sudo systemctl start postgresql[/]")
            console.print(f"  [{Colors.DIM}]  brew services start postgresql@16[/]")
            console.print()
            console.print(f"  [{Colors.HINT}]Start PostgreSQL in another terminal, then press Enter to retry...[/]")
            input()
        else:
            # "Retry connection" — just loop
            console.print()
        
        # Loop back to retry


def _show_connection_error_details(console: Console, error: str, config: dict) -> None:
    """Show detailed, actionable error messages based on the connection error."""
    console.print(f"  [{Colors.DIM}]Error: {error}[/]")
    console.print()


def _is_container_runtime() -> bool:
    """Return True when Flow is running inside the runtime container."""
    return in_container_runtime()


def _persist_workspace_db_password(config_file: Optional[Path], password: str) -> None:
    """Persist recovered DB password to workspace config.yaml when available."""
    if not config_file or not config_file.exists():
        return

    try:
        import yaml

        with open(config_file, "r") as f:
            config_yaml = yaml.safe_load(f) or {}

        db_section = config_yaml.get("database") or {}
        db_section["password"] = password
        config_yaml["database"] = db_section

        with open(config_file, "w") as f:
            yaml.dump(config_yaml, f, default_flow_style=False)
    except Exception:
        # Best-effort persistence only; onboarding should continue when auth is recovered.
        pass


def _try_runtime_password_fallback(
    console: Console,
    config: dict,
    config_file: Optional[Path],
) -> tuple[bool, Optional[str]]:
    """Attempt known container defaults when persisted DB password drifts."""
    current_password = config.get("password", "")
    candidates = ["caracal"]

    for candidate in candidates:
        if candidate == current_password:
            continue

        probe_config = {**config, "password": candidate}
        ok, _ = _test_db_connection(probe_config)
        if ok:
            console.print(
                f"  [{Colors.INFO}]{Icons.INFO} Using recovered runtime database credentials.[/]"
            )
            _persist_workspace_db_password(config_file, candidate)
            return True, candidate

    return False, None


def _step_principal(wizard: Wizard) -> Any:
    """Step 3: Register first principal."""
    console = wizard.console
    prompt = FlowPrompt(console)

    # Principal registration is only required during fresh onboarding for
    # newly created workspaces. Selecting an existing workspace should never
    # force identity creation in this flow.
    if wizard.context.get("workspace_existing"):
        console.print(
            f"  [{Colors.INFO}]{Icons.INFO} Existing workspace selected — skipping principal registration.[/]"
        )
        return None
    
    if wizard.context.get("previously_onboarded") and "principal" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal already registered in this workspace.[/]")
        # Marker object so later steps treat principal registration as satisfied.
        wizard.context["first_principal"] = {"_existing": True}
        return wizard.context["first_principal"]
    
    def validate_email(value: str) -> tuple[bool, str]:
        import re
        if re.match(r"^[^@]+@[^@]+\.[^@]+$", value):
            return True, ""
        return False, "Please enter a valid email address."
    
    console.print(f"  [{Colors.NEUTRAL}]Let's register your first principal.")
    console.print(f"  [{Colors.DIM}]This will be the first human, orchestrator, worker, or service you want to start with.[/]")
    console.print()
    
    principal_kind = prompt.select(
        "Principal kind",
        choices=["human", "orchestrator", "worker", "service"],
    )
    
    name = prompt.text(
        "Principal name",
    )
    
    owner = prompt.text(
        "Owner email",
        validator=validate_email,
    )
    
    # Store for later
    wizard.context["first_principal"] = {
        "name": name,
        "owner": owner,
        "kind": principal_kind,
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Principal will be registered after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Name: {name}[/]")
    console.print(f"  [{Colors.DIM}]Owner: {owner}[/]")
    console.print(f"  [{Colors.DIM}]Kind: {principal_kind}[/]")
    
    return wizard.context["first_principal"]


def _step_policy(wizard: Wizard) -> Any:
    """Step 4: Create first authority policy."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    if wizard.context.get("previously_onboarded") and "policy" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy already configured in this workspace.[/]")
        wizard.context["first_policy"] = {"_existing": True}
        return wizard.context["first_policy"]
    
    # Check dependency: principal must be created first
    principal_info = wizard.context.get("first_principal")
    if not principal_info:
        # Silently skip - no need to prompt user since principal wasn't registered
        return None
    
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Now let's create an authority policy for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Policies define how mandates can be issued.[/]")
    console.print()
    
    # Ask whether the user wants to create a policy now or skip
    create_now = prompt.confirm(
        "Create an authority policy now?",
        default=False,
    )

    if not create_now:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping policy creation. You can create policies later from the main menu.[/]")
        return None

    # Collect realistic inputs (no dummy defaults)
    max_validity = prompt.number(
        "Maximum mandate validity (seconds)",
        default=3600,
        min_value=60,
    )

    scope_catalog = load_provider_scope_catalog()
    providers = scope_catalog["providers"]
    resources = scope_catalog["resources"]
    actions_catalog = scope_catalog["actions"]

    if not providers:
        console.print()
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured in this workspace.[/]"
        )
        console.print(
            f"  [{Colors.INFO}]{Icons.INFO} Skipping policy creation until a provider is configured.[/]"
        )
        return None

    provider_choice = prompt.select(
        "Scope provider",
        choices=providers + ["all"],
        default=providers[0],
    )
    if provider_choice != "all":
        prefix = f"provider:{provider_choice}:"
        resources = [scope for scope in resources if scope.startswith(prefix)]
        actions_catalog = [scope for scope in actions_catalog if scope.startswith(prefix)]

    resource_patterns: list[str] = []
    while True:
        remaining = [r for r in resources if r not in resource_patterns]
        if not remaining:
            break
        choice = prompt.select(
            f"Resource scope {len(resource_patterns) + 1}",
            choices=remaining + ["done"],
            default=remaining[0],
        )
        if choice == "done":
            break
        resource_patterns.append(choice)

    actions: list[str] = []
    while True:
        remaining = [a for a in actions_catalog if a not in actions]
        if not remaining:
            break
        choice = prompt.select(
            f"Action scope {len(actions) + 1}",
            choices=remaining + ["done"],
            default=remaining[0],
        )
        if choice == "done":
            break
        actions.append(choice)

    if not resource_patterns or not actions:
        console.print()
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Policy creation skipped because no provider scopes were selected.[/]"
        )
        return None

    workspace_name = _resolve_active_workspace_name()
    providers_for_validation = [provider_choice] if provider_choice != "all" else None
    validate_provider_scopes(
        workspace=workspace_name,
        resource_scopes=resource_patterns,
        action_scopes=actions,
        providers=providers_for_validation,
    )

    wizard.context["first_policy"] = {
        "max_validity_seconds": int(max_validity),
        "resource_patterns": resource_patterns,
        "actions": actions,
    }

    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Policy will be created after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Max mandate validity (seconds): {int(max_validity)}s[/]")

    return wizard.context["first_policy"]


def _step_mandate(wizard: Wizard) -> Any:
    """Step 5: Issue first mandate."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    if wizard.context.get("previously_onboarded") and "mandate" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate already issued in this workspace.[/]")
        wizard.context["first_mandate"] = {"_existing": True}
        return wizard.context["first_mandate"]
    
    # Check dependency: policy must be created first
    policy_info = wizard.context.get("first_policy")
    if not policy_info:
        # Silently skip - no need to prompt user since policy wasn't created
        return None
    
    principal_info = wizard.context.get("first_principal", {})
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Let's issue an execution mandate for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Mandates grant specific execution rights for a limited time.[/]")
    console.print()
    
    # Ask whether the user wants to issue a mandate now or skip
    issue_now = prompt.confirm(
        "Issue a mandate now?",
        default=False,
    )

    if not issue_now:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping mandate issuance. You can issue mandates later from the main menu.[/]")
        return None

    validity = prompt.number(
        "Mandate validity (seconds)",
        default=1800,
        min_value=60,
    )

    resource_candidates = policy_info.get("resource_patterns", [])
    action_candidates = policy_info.get("actions", [])

    resource_scope: list[str] = []
    while True:
        remaining = [r for r in resource_candidates if r not in resource_scope]
        if not remaining:
            break
        choice = prompt.select(
            f"Mandate resource scope {len(resource_scope) + 1}",
            choices=remaining + ["done"],
            default=remaining[0],
        )
        if choice == "done":
            break
        resource_scope.append(choice)

    action_scope: list[str] = []
    while True:
        remaining = [a for a in action_candidates if a not in action_scope]
        if not remaining:
            break
        choice = prompt.select(
            f"Mandate action scope {len(action_scope) + 1}",
            choices=remaining + ["done"],
            default=remaining[0],
        )
        if choice == "done":
            break
        action_scope.append(choice)

    if not resource_scope or not action_scope:
        console.print()
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Mandate issuance skipped because no provider scopes were selected.[/]"
        )
        return None

    workspace_name = _resolve_active_workspace_name()
    validate_provider_scopes(
        workspace=workspace_name,
        resource_scopes=resource_scope,
        action_scopes=action_scope,
        providers=None,
    )

    wizard.context["first_mandate"] = {
        "validity_seconds": int(validity),
        "resource_scope": resource_scope,
        "action_scope": action_scope,
    }

    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Mandate will be issued after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Validity: {int(validity)}s[/]")

    return wizard.context["first_mandate"]


def _step_validate(wizard: Wizard) -> Any:
    """Step 6: Validate mandate demo."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    if wizard.context.get("previously_onboarded") and "validate" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Validation already completed in this workspace.[/]")
        wizard.context["validate_demo"] = False
        return True
    
    # Check dependency: mandate must be issued first
    mandate_info = wizard.context.get("first_mandate")
    if not mandate_info:
        # Silently skip - no need to prompt user since mandate wasn't issued
        wizard.context["validate_demo"] = False
        return None
    
    console.print(f"  [{Colors.NEUTRAL}]Finally, we'll demonstrate mandate validation.")
    console.print(f"  [{Colors.DIM}]This shows how authority is checked before execution.[/]")
    console.print()

    run_demo = prompt.confirm(
        "Run the validation demo now?",
        default=False,
    )

    if not run_demo:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping validation demo. You can run validation from the main menu later.[/]")
        wizard.context["validate_demo"] = False
        return False

    console.print(f"  [{Colors.INFO}]{Icons.INFO} Validation demo will run after setup completes.[/]")
    wizard.context["validate_demo"] = True
    return True


def run_onboarding(
    console: Optional[Console] = None,
    state: Optional[FlowState] = None,
) -> dict[str, Any]:
    """
    Run the onboarding wizard.
    
    Args:
        console: Rich console
        state: Application state
    
    Returns:
        Dictionary of collected information
    """
    console = console or Console()
    
    # Define wizard steps
    steps = [
        WizardStep(
            key="workspace",
            title="Workspace Setup",
            description="Select, create, delete, or import a workspace",
            action=_step_workspace,
            skippable=False,
        ),
        WizardStep(
            key="config",
            title="Configuration Setup",
            description="Set up Caracal's configuration directory and files",
            action=_step_config,
            skippable=False,
        ),
        WizardStep(
            key="database",
            title="Database Setup",
            description="Automatic database configuration with fail-safe fallback",
            action=_step_database,
            skippable=False,
        ),
        WizardStep(
            key="principal",
            title="Register First Principal",
            description="Create your first principal identity (new workspaces)",
            action=_step_principal,
            skippable=True,
            skip_message="You can register principals later from the main menu",
        ),
    ]
    
    wizard = Wizard(
        title="Welcome to Caracal Flow",
        steps=steps,
        console=console,
    )
    
    results = wizard.run()
    
    # Validate that workspace was selected (critical requirement)
    if not wizard.context.get("workspace_path"):
        console.print()
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} No workspace selected. Cannot proceed without a workspace.[/]")
        console.print(f"  [{Colors.INFO}]{Icons.INFO} A workspace is required to store your configuration and data.[/]")
        console.print()
        results["workspace_configured"] = False
        return results
    
    results["workspace_configured"] = True

    if wizard.context.get("exit_onboarding_after_workspace_import"):
        results["imported_workspace"] = True
        return results
    
    # Show summary
    wizard.show_summary()
    
    # Persist changes
    try:
        from pathlib import Path
        from caracal.config import load_config
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.db.models import Principal, AuthorityPolicy
        from caracal.core.identity import PrincipalRegistry
        from datetime import datetime
        from uuid import UUID, uuid4
        from caracal.flow.workspace import get_workspace
        
        # Load fresh config (in case it was just initialized)
        config = load_config()
        
        # Save database configuration if provided
        db_config_data = results.get("database")
        workspace_name = wizard.context.get("workspace_name", "default")
        # Derive or resolve workspace schema name.
        workspace_schema = _resolve_workspace_schema(workspace_name, wizard.context)
        if isinstance(db_config_data, dict) and db_config_data.get("schema"):
            workspace_schema = _select_persisted_workspace_schema(
                db_config_data.get("schema"),
                workspace_schema,
            )
        
        config_file: Optional[Path] = None

        if db_config_data and isinstance(db_config_data, dict) and db_config_data.get("type") == "postgresql":
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Saving database configuration...[/]")
            
            # Update config file with database settings
            import yaml
            
            config_path = wizard.context.get("config_path", get_workspace().root)
            config_file = Path(config_path) / "config.yaml"
            
            if config_file.exists():
                with open(config_file, 'r') as f:
                    config_yaml = yaml.safe_load(f) or {}

                # Preserve previously configured schema for this workspace.
                existing_schema = (
                    (config_yaml.get('database') or {}).get('schema')
                    if isinstance(config_yaml, dict)
                    else None
                )
                workspace_schema = _select_persisted_workspace_schema(
                    existing_schema,
                    workspace_schema,
                )
                
                # Update database section — include schema for workspace isolation
                config_yaml['database'] = {
                    'type': 'postgresql',
                    'host': db_config_data['host'],
                    'port': db_config_data['port'],
                    'database': db_config_data['database'],
                    'user': db_config_data['username'],
                    'password': db_config_data['password'],
                    'schema': workspace_schema,
                }
                
                with open(config_file, 'w') as f:
                    yaml.dump(config_yaml, f, default_flow_style=False)
                
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL configuration saved to config.yaml[/]")
                console.print(f"  [{Colors.DIM}]Schema: {workspace_schema}[/]")
                
                # Reload config
                config = load_config()
        
        # Setup database connection — PostgreSQL only
        if isinstance(db_config_data, dict) and db_config_data.get("type") == "postgresql":
            # PostgreSQL was successfully configured in wizard
            db_config = DatabaseConfig(
                host=db_config_data.get('host', 'localhost'),
                port=int(db_config_data.get('port', 5432)),
                database=db_config_data.get('database', 'caracal'),
                user=db_config_data.get('username', 'caracal'),
                password=db_config_data.get('password', ''),
                schema=workspace_schema,
            )
        elif hasattr(config, 'database') and config.database:
            # Fall back to existing config if wizard didn't produce new data
            db_config = DatabaseConfig(
                host=getattr(config.database, 'host', 'localhost'),
                port=getattr(config.database, 'port', 5432),
                database=getattr(config.database, 'database', 'caracal'),
                user=getattr(config.database, 'user', 'caracal'),
                password=getattr(config.database, 'password', ''),
                schema=getattr(config.database, 'schema', workspace_schema),
            )
        else:
            # Use env-var-based defaults via get_db_manager()
            db_config = DatabaseConfig(schema=workspace_schema)
        
        # Initialize database — try to connect, auto-start PostgreSQL if needed
        db_manager = None
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            try:
                db_manager = DatabaseConnectionManager(db_config)
                db_manager.initialize()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database initialized successfully[/]")
                break
            except Exception as e:
                err_str = str(e).lower()
                is_connection_error = (
                    "connection refused" in err_str
                    or "could not connect" in err_str
                    or "no password supplied" in err_str
                    or "operationalerror" in err_str
                )
                is_auth_error = ("password" in err_str or "authentication" in err_str)

                # In container mode, a persisted Postgres volume can retain the default
                # password even after .env changes. Recover automatically when possible.
                if is_auth_error and _is_container_runtime():
                    runtime_config = {
                        "host": db_config.host,
                        "port": int(db_config.port),
                        "database": db_config.database,
                        "username": db_config.user,
                        "password": db_config.password,
                    }
                    recovered, recovered_password = _try_runtime_password_fallback(
                        console,
                        runtime_config,
                        config_file,
                    )
                    if recovered and recovered_password:
                        db_config.password = recovered_password
                        if isinstance(db_config_data, dict):
                            db_config_data["password"] = recovered_password
                        console.print(f"  [{Colors.DIM}]Retrying database connection...[/]")
                        continue
                
                if is_connection_error and (not is_auth_error) and attempt < max_attempts:
                    console.print()
                    console.print(f"  [{Colors.WARNING}]{Icons.WARNING} PostgreSQL is not reachable. Attempting to start it automatically...[/]")
                    start_ok, start_msg = _start_postgresql(console)
                    if start_ok:
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} {start_msg}[/]")
                        console.print(f"  [{Colors.INFO}]{Icons.INFO} Retrying database connection...[/]")
                        continue
                    else:
                        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Could not auto-start PostgreSQL: {start_msg}[/]")
                
                # Final failure — show a clean error, not a massive traceback
                console.print()
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Database initialization failed.[/]")
                console.print()
                
                # Show helpful diagnostics
                if "connection refused" in err_str:
                    console.print(f"  [{Colors.INFO}]PostgreSQL is not running. Start it with:[/]")
                    console.print(f"    [{Colors.DIM}]docker compose -f deploy/docker-compose.yml up -d postgres[/]")
                    console.print(f"    [{Colors.DIM}]sudo systemctl start postgresql[/]")
                elif "password" in err_str or "authentication" in err_str:
                    console.print(f"  [{Colors.INFO}]Authentication failed. Check your .env credentials:[/]")
                    console.print(f"    [{Colors.DIM}]CCL_DB_USER, CCL_DB_PASSWORD in .env[/]")
                elif "does not exist" in err_str:
                    console.print(f"  [{Colors.INFO}]Database or role missing. Create them with:[/]")
                    console.print(f"    [{Colors.DIM}]createdb caracal && createuser caracal[/]")
                else:
                    console.print(f"  [{Colors.DIM}]Error: {e}[/]")
                
                console.print()
                console.print(f"  [{Colors.HINT}]Fix the issue and re-run onboarding.[/]")
                console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
                input()
                return results
        
        # Only clean database if explicitly requested or if it's a new workspace with fresh start
        # Do NOT clean database if it was auto-configured from .env without user confirmation
        should_clean = (
            wizard.context.get("fresh_start") and 
            not wizard.context.get("database_auto_configured")
        )
        
        if should_clean:
            try:
                console.print()
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Cleaning database for fresh start...[/]")
                # Use the clear_database method for a clean wipe
                db_manager.clear_database()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database cleaned - starting with empty tables[/]")
            except Exception as e:
                console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Failed to clean database: {e}[/]")
                console.print(f"  [{Colors.DIM}]Continuing with existing data...[/]")
        
        # Handle Principal Registration
        principal_data = results.get("principal")
        principal_id = None
        
        if principal_data and not principal_data.get("_existing"):
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Finalizing setup...[/]")
            
            try:
                with db_manager.session_scope() as db_session:
                    # Check if principal already exists
                    existing = db_session.query(Principal).filter_by(
                        name=principal_data["name"]
                    ).first()
                    
                    if existing:
                        principal_id = existing.principal_id
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal already exists, reusing.[/]")
                        console.print(f"  [{Colors.DIM}]Principal ID: {principal_id}[/]")
                    else:
                        console.print(f"  [{Colors.INFO}]{Icons.INFO} Generating cryptographic keys...[/]")

                        registry = PrincipalRegistry(db_session)
                        identity_service = IdentityService(principal_registry=registry)
                        identity = identity_service.register_principal(
                            name=principal_data["name"],
                            owner=principal_data["owner"],
                            principal_kind=principal_data["kind"],
                            metadata=None,
                            generate_keys=True,
                        )

                        principal_id = UUID(str(identity.principal_id))
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal registered successfully.[/]")
                        console.print(f"  [{Colors.DIM}]Principal ID: {principal_id}[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to register principal: {e}[/]")
        
        # Handle Authority Policy Creation
        policy_data = results.get("policy")
        if policy_data and not policy_data.get("_existing") and principal_id:
            try:
                with db_manager.session_scope() as db_session:
                    # Check if a policy already exists for this principal
                    existing_policy = db_session.query(AuthorityPolicy).filter_by(
                        principal_id=principal_id,
                        active=True,
                    ).first()
                    
                    if existing_policy:
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy already exists, skipping.[/]")
                    else:
                        policy = AuthorityPolicy(
                            policy_id=uuid4(),
                            principal_id=principal_id,
                            max_validity_seconds=policy_data["max_validity_seconds"],
                            allowed_resource_patterns=policy_data["resource_patterns"],
                            allowed_actions=policy_data["actions"],
                            allow_delegation=True,
                            max_network_distance=3,
                            created_at=datetime.utcnow(),
                            created_by=principal_data["owner"] if principal_data else "system",
                            active=True,
                        )
                        
                        db_session.add(policy)
                        
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy created successfully.[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to create policy: {e}[/]")
        
        # Issue first mandate if requested (create mandate record in DB)
        mandate_data = results.get("mandate")
        if mandate_data and not mandate_data.get("_existing") and principal_id:
            try:
                console.print()
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Issuing first mandate for {principal_data['name']}...[/]")
                from caracal.core.mandate import MandateManager

                with db_manager.session_scope() as db_session:
                    mandate_manager = MandateManager(db_session)

                    # Use provided scopes or fall back to policy defaults
                    resource_scope = mandate_data.get("resource_scope") or policy_data.get("resource_patterns", [])
                    action_scope = mandate_data.get("action_scope") or policy_data.get("actions", [])
                    validity_seconds = int(mandate_data.get("validity_seconds", 900))

                    mandate = mandate_manager.issue_mandate(
                        issuer_id=principal_id,
                        subject_id=principal_id,
                        resource_scope=resource_scope,
                        action_scope=action_scope,
                        validity_seconds=validity_seconds,
                    )

                    # Record mandate id in results/context for visibility
                    results["mandate_id"] = str(mandate.mandate_id)
                    wizard.context["first_mandate"]["mandate_id"] = str(mandate.mandate_id)

                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate issued successfully.[/]")
                    console.print(f"  [{Colors.DIM}]Mandate ID: {mandate.mandate_id}[/]")

            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to issue mandate: {e}[/]")

        # Close database connection
        if db_manager:
            db_manager.close()
                
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error during configuration: {e}[/]")
        import logging
        logging.getLogger(__name__).debug("Onboarding config error", exc_info=True)

    # Update state
    if state:
        state.onboarding.mark_complete()
        for step in steps:
            if step.status.value == "completed":
                state.onboarding.mark_step_complete(step.key)
            elif step.status.value == "skipped":
                state.onboarding.mark_step_skipped(step.key)
        
        # Save state
        persistence = StatePersistence()
        persistence.save(state)
    
    # Show next steps
    _show_next_steps(console, results, wizard.context)
    
    return results


def _show_next_steps(console: Console, results: dict, context: dict) -> None:
    """Show actionable next steps after onboarding."""
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Next Steps:[/]")
    console.print()
    
    todos = []
    
    # Check what was skipped
    if results.get("principal") is None:
        todos.append(("Register a principal", "caracal authority register --name my-principal --owner user@example.com"))
    
    # Provider-backed authority flow: provider -> policy -> mandate -> ledger
    todos.append((
        "Add a provider",
        "caracal provider add <name> --resource <id> --action <resource:action:method:path> --credential <secret>",
    ))
    todos.append((
        "Create an authority policy",
        "caracal policy create --principal-id <uuid> --max-validity-seconds 3600 --resource-pattern \"provider:<name>:resource:<id>\" --action \"provider:<name>:action:invoke\"",
    ))
    todos.append((
        "Issue an execution mandate",
        "caracal authority issue --issuer-id <uuid> --subject-id <uuid> --resource-scope \"provider:<name>:resource:<id>\" --action-scope \"provider:<name>:action:invoke\" --validity-seconds 3600",
    ))
    todos.append(("Explore your authority ledger", "caracal authority-ledger query"))
    
    for i, (title, cmd) in enumerate(todos, 1):
        console.print(f"  [{Colors.NEUTRAL}]{i}. {title}[/]")
        console.print(f"     [{Colors.DIM}]{cmd}[/]")
        console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue to the main menu...[/]")
    input()
