"""
Provider definition and scope utilities.

This package defines provider-driven resource/action contracts shared by
broker (open source) and gateway (enterprise) execution paths.
"""

from .definitions import (
    ProviderActionDefinition,
    ProviderDefinition,
    ProviderResourceDefinition,
    ScopeParseError,
    build_action_scope,
    build_resource_scope,
    get_provider_definition,
    list_provider_definition_ids,
    list_provider_definitions,
    parse_provider_scope,
    resolve_provider_definition_id,
)
from .workspace import (
    WorkspaceProviderBinding,
    ensure_scopes_in_workspace_catalog,
    list_workspace_action_scopes,
    list_workspace_provider_bindings,
    list_workspace_resource_scopes,
    load_workspace_provider_registry,
    save_workspace_provider_registry,
)

__all__ = [
    "ProviderActionDefinition",
    "ProviderDefinition",
    "ProviderResourceDefinition",
    "ScopeParseError",
    "WorkspaceProviderBinding",
    "build_action_scope",
    "build_resource_scope",
    "ensure_scopes_in_workspace_catalog",
    "get_provider_definition",
    "list_provider_definition_ids",
    "list_provider_definitions",
    "list_workspace_action_scopes",
    "list_workspace_provider_bindings",
    "list_workspace_resource_scopes",
    "load_workspace_provider_registry",
    "parse_provider_scope",
    "resolve_provider_definition_id",
    "save_workspace_provider_registry",
]
