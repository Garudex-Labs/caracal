"""
Workspace provider registry helpers.

These helpers centralize reading/writing provider configurations and deriving
provider-scoped resource/action catalogs for CLI and TUI flows.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from caracal.deployment.config_manager import ConfigManager
from caracal.deployment.exceptions import WorkspaceNotFoundError
from caracal.provider.definitions import (
    build_action_scope,
    build_resource_scope,
    parse_provider_scope,
    provider_definition_from_mapping,
    resolve_provider_definition_id,
)


@dataclass(frozen=True)
class WorkspaceProviderBinding:
    """Provider binding in a workspace."""

    provider_name: str
    service_type: str
    definition_id: str
    entry: Dict[str, Any]

    @property
    def definition(self):
        definition_payload = self.entry.get("definition")
        if isinstance(definition_payload, dict):
            return provider_definition_from_mapping(
                definition_payload,
                default_definition_id=self.definition_id,
                default_service_type=self.service_type,
                default_display_name=self.provider_name,
                default_auth_scheme=str(self.entry.get("auth_scheme") or "api_key"),
                default_base_url=self.entry.get("base_url"),
            )
        raise ValueError(
            f"Provider '{self.provider_name}' is missing structured definition payload"
        )

    def list_resource_scopes(self) -> List[str]:
        return [
            build_resource_scope(self.provider_name, resource_id)
            for resource_id in self.definition.list_resource_ids()
        ]

    def list_action_scopes(self) -> List[str]:
        return [
            build_action_scope(self.provider_name, action_id)
            for action_id in self.definition.list_action_ids()
        ]


def load_workspace_provider_registry(
    config_manager: ConfigManager,
    workspace: str,
) -> Dict[str, Dict[str, Any]]:
    """Load provider registry from workspace metadata."""
    try:
        config = config_manager.get_workspace_config(workspace)
    except WorkspaceNotFoundError:
        return {}

    metadata = dict(config.metadata or {})
    providers = metadata.get("providers", {})

    if isinstance(providers, list):
        normalized: Dict[str, Dict[str, Any]] = {}
        for item in providers:
            if isinstance(item, dict) and item.get("name"):
                normalized[str(item["name"])] = dict(item)
        return normalized

    return providers if isinstance(providers, dict) else {}


def save_workspace_provider_registry(
    config_manager: ConfigManager,
    workspace: str,
    providers: Dict[str, Dict[str, Any]],
) -> None:
    """Persist provider registry in workspace metadata."""
    config = config_manager.get_workspace_config(workspace)
    metadata = dict(config.metadata or {})
    metadata["provider_registry"] = {
        "mode": "provider_definition_v1",
        "version": "v2",
        "updated_at": datetime.utcnow().isoformat(),
    }
    metadata["providers"] = providers
    config.metadata = metadata
    config_manager.set_workspace_config(workspace, config)


def list_workspace_provider_bindings(
    config_manager: ConfigManager,
    workspace: str,
) -> List[WorkspaceProviderBinding]:
    """Return sorted provider bindings for a workspace."""
    providers = load_workspace_provider_registry(config_manager, workspace)
    bindings: List[WorkspaceProviderBinding] = []
    for provider_name in sorted(providers.keys()):
        entry = dict(providers[provider_name] or {})
        definition_id = resolve_provider_definition_id(
            service_type=entry.get("service_type"),
            requested_definition=entry.get("provider_definition"),
        )
        bindings.append(
            WorkspaceProviderBinding(
                provider_name=provider_name,
                service_type=str(entry.get("service_type") or "api"),
                definition_id=definition_id,
                entry=entry,
            )
        )
    return bindings


def list_workspace_resource_scopes(
    config_manager: ConfigManager,
    workspace: str,
    providers: Optional[Iterable[str]] = None,
) -> List[str]:
    """Return all resource scopes for configured providers."""
    provider_filter = {p for p in (providers or [])}
    scopes: List[str] = []
    for binding in list_workspace_provider_bindings(config_manager, workspace):
        if provider_filter and binding.provider_name not in provider_filter:
            continue
        scopes.extend(binding.list_resource_scopes())
    return sorted(scopes)


def list_workspace_action_scopes(
    config_manager: ConfigManager,
    workspace: str,
    providers: Optional[Iterable[str]] = None,
) -> List[str]:
    """Return all action scopes for configured providers."""
    provider_filter = {p for p in (providers or [])}
    scopes: List[str] = []
    for binding in list_workspace_provider_bindings(config_manager, workspace):
        if provider_filter and binding.provider_name not in provider_filter:
            continue
        scopes.extend(binding.list_action_scopes())
    return sorted(scopes)


def ensure_scopes_in_workspace_catalog(
    resource_scopes: Iterable[str],
    action_scopes: Iterable[str],
    bindings: Iterable[WorkspaceProviderBinding],
) -> None:
    """
    Validate all resource/action scopes exist in configured provider catalog.

    Raises ValueError when any scope is unknown.
    """
    binding_list = list(bindings)
    allowed_resources = {
        scope
        for binding in binding_list
        for scope in binding.list_resource_scopes()
    }
    allowed_actions = {
        scope
        for binding in binding_list
        for scope in binding.list_action_scopes()
    }

    unknown_resources = [scope for scope in resource_scopes if scope not in allowed_resources]
    unknown_actions = [scope for scope in action_scopes if scope not in allowed_actions]

    if unknown_resources or unknown_actions:
        message_parts = []
        if unknown_resources:
            message_parts.append(f"Unknown resource scope(s): {', '.join(unknown_resources)}")
        if unknown_actions:
            message_parts.append(f"Unknown action scope(s): {', '.join(unknown_actions)}")
        raise ValueError("; ".join(message_parts))

    for scope in resource_scopes:
        parsed = parse_provider_scope(scope)
        if parsed["kind"] != "resource":
            raise ValueError(f"Expected resource scope, got: {scope}")
    for scope in action_scopes:
        parsed = parse_provider_scope(scope)
        if parsed["kind"] != "action":
            raise ValueError(f"Expected action scope, got: {scope}")


def split_scope_by_provider(scope: str) -> Tuple[str, str]:
    """Return (provider_name, identifier) for canonical provider scope."""
    parsed = parse_provider_scope(scope)
    return parsed["provider_name"], parsed["identifier"]
