"""
Provider-scope helpers for Flow (TUI) screens.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from caracal.deployment.config_manager import ConfigManager
from caracal.provider.workspace import (
    list_workspace_action_scopes,
    list_workspace_provider_bindings,
    list_workspace_resource_scopes,
)


def load_provider_scope_catalog(workspace: Optional[str] = None) -> Dict[str, List[str]]:
    """Load provider names/resources/actions for the active workspace."""
    config_manager = ConfigManager()
    active_workspace = workspace or config_manager.get_default_workspace_name()
    if not active_workspace:
        return {"providers": [], "resources": [], "actions": []}

    bindings = list_workspace_provider_bindings(config_manager, active_workspace)
    providers = [binding.provider_name for binding in bindings]
    resources = list_workspace_resource_scopes(config_manager, active_workspace)
    actions = list_workspace_action_scopes(config_manager, active_workspace)
    return {
        "providers": providers,
        "resources": resources,
        "actions": actions,
    }


def scope_items(scopes: List[str]) -> List[Tuple[str, str]]:
    """Convert scopes into (value, description) tuples for UUID-style completion."""
    return [(scope, scope) for scope in scopes]
