"""
CLI helpers for provider-driven resource/action scope completion and validation.
"""

from __future__ import annotations

from typing import Iterable, List, Optional

import click

from caracal.deployment.config_manager import ConfigManager
from caracal.provider.workspace import (
    ensure_scopes_in_workspace_catalog,
    list_workspace_action_scopes,
    list_workspace_provider_bindings,
    list_workspace_resource_scopes,
)


def get_workspace_from_ctx(ctx: click.Context) -> str:
    """Resolve active workspace from click context and ConfigManager fallback."""
    config_manager = ConfigManager()

    if ctx is not None:
        root = ctx.find_root()
        obj = getattr(root, "obj", None)
        if obj and hasattr(obj, "get"):
            workspace = obj.get("workspace")
            if workspace:
                return str(workspace)

    default_workspace = config_manager.get_default_workspace_name()
    if default_workspace:
        return default_workspace

    workspaces = config_manager.list_workspaces()
    if not workspaces:
        raise click.ClickException(
            "No workspaces found. Create one first with 'caracal workspace create <name>'."
        )
    return workspaces[0]


def list_provider_names(workspace: str) -> List[str]:
    """List configured provider names for workspace."""
    config_manager = ConfigManager()
    bindings = list_workspace_provider_bindings(config_manager, workspace)
    return [binding.provider_name for binding in bindings]


def provider_name_shell_complete(
    ctx: click.Context,
    _param: click.Parameter,
    incomplete: str,
):
    """Shell completion for provider names."""
    from click.shell_completion import CompletionItem

    try:
        workspace = get_workspace_from_ctx(ctx)
        providers = list_provider_names(workspace)
    except Exception:
        providers = []

    return [
        CompletionItem(provider)
        for provider in providers
        if provider.startswith(incomplete)
    ]


def resource_scope_shell_complete(
    ctx: click.Context,
    _param: click.Parameter,
    incomplete: str,
):
    """Shell completion for resource scopes derived from configured providers."""
    from click.shell_completion import CompletionItem

    try:
        workspace = get_workspace_from_ctx(ctx)
        provider_filter = _selected_provider_filter(ctx)
        resources = list_workspace_resource_scopes(
            ConfigManager(),
            workspace,
            providers=provider_filter,
        )
    except Exception:
        resources = []

    return [
        CompletionItem(scope)
        for scope in resources
        if scope.startswith(incomplete)
    ]


def action_scope_shell_complete(
    ctx: click.Context,
    _param: click.Parameter,
    incomplete: str,
):
    """Shell completion for action scopes derived from configured providers."""
    from click.shell_completion import CompletionItem

    try:
        workspace = get_workspace_from_ctx(ctx)
        provider_filter = _selected_provider_filter(ctx)
        actions = list_workspace_action_scopes(
            ConfigManager(),
            workspace,
            providers=provider_filter,
        )
    except Exception:
        actions = []

    return [
        CompletionItem(scope)
        for scope in actions
        if scope.startswith(incomplete)
    ]


def validate_provider_scopes(
    workspace: str,
    resource_scopes: Iterable[str],
    action_scopes: Iterable[str],
    providers: Optional[Iterable[str]] = None,
) -> None:
    """Validate scopes against the provider catalog in a workspace."""
    config_manager = ConfigManager()
    bindings = list_workspace_provider_bindings(config_manager, workspace)
    if providers:
        provider_set = set(providers)
        bindings = [binding for binding in bindings if binding.provider_name in provider_set]
    if not bindings:
        raise click.ClickException(
            "No providers configured for the active workspace. "
            "Configure providers first with 'caracal provider add ...'."
        )
    scoped_bindings = [binding for binding in bindings if binding.is_scoped]
    if not scoped_bindings:
        raise click.ClickException(
            "No scoped providers are configured for the active workspace. "
            "Create a passthrough provider with 'caracal provider add ...' and then add scopes with "
            "'caracal provider enrich ...' before issuing provider-scoped authorities."
        )
    ensure_scopes_in_workspace_catalog(resource_scopes, action_scopes, scoped_bindings)


def _selected_provider_filter(ctx: click.Context) -> List[str]:
    """Best-effort lookup of selected provider option values in current context."""
    if ctx is None:
        return []
    params = getattr(ctx, "params", {}) or {}
    value = params.get("provider")
    if value is None:
        return []
    if isinstance(value, tuple):
        return [str(v) for v in value if v]
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return [str(value)]
