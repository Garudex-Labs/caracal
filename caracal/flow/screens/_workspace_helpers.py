"""Helpers for workspace data used by Flow screens."""

from typing import List, Optional

from caracal.deployment.config_manager import ConfigManager, WorkspaceConfig
from caracal.deployment.exceptions import WorkspaceNotFoundError
from caracal.flow.workspace import get_workspace


def list_workspace_configs(config_mgr: ConfigManager) -> List[WorkspaceConfig]:
    """Return workspace configs for all known workspace names."""
    workspaces: List[WorkspaceConfig] = []
    for name in config_mgr.list_workspaces():
        try:
            workspaces.append(config_mgr.get_workspace_config(name))
        except Exception:
            # Skip broken workspace entries so the UI can keep working.
            continue
    return workspaces


def get_default_workspace(config_mgr: ConfigManager) -> Optional[WorkspaceConfig]:
    """Return default workspace config, or the first available workspace."""
    workspaces = list_workspace_configs(config_mgr)
    default_ws = next((ws for ws in workspaces if ws.is_default), None)
    if default_ws is not None:
        return default_ws
    return workspaces[0] if workspaces else None


def get_active_workspace_name(config_mgr: ConfigManager) -> Optional[str]:
    """Return the runtime-active workspace name, falling back to default config.

    Flow can switch workspace in-memory before metadata persistence catches up,
    so prefer the current runtime workspace when it maps to a known workspace.
    """
    try:
        workspace_names = set(config_mgr.list_workspaces())
        runtime_workspace = get_workspace().root.name
        if runtime_workspace in workspace_names:
            return runtime_workspace
    except Exception:
        pass

    default_workspace = get_default_workspace(config_mgr)
    if default_workspace is not None:
        return default_workspace.name
    return None


def set_default_workspace(config_mgr: ConfigManager, workspace_name: str) -> None:
    """Mark exactly one workspace as default."""
    workspaces = list_workspace_configs(config_mgr)
    found = False

    for ws in workspaces:
        should_be_default = ws.name == workspace_name
        if ws.is_default != should_be_default:
            ws.is_default = should_be_default
            config_mgr.set_workspace_config(ws.name, ws)
        if should_be_default:
            found = True

    if not found:
        raise WorkspaceNotFoundError(f"Workspace not found: {workspace_name}")
