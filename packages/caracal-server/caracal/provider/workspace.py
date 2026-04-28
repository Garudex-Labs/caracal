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

    @property
    def has_definition(self) -> bool:
        definition_payload = self.entry.get("definition")
        if not isinstance(definition_payload, dict):
            return False
        return bool(definition_payload.get("resources"))

    @property
    def is_scoped(self) -> bool:
        return bool(self.entry.get("enforce_scoped_requests")) and self.has_definition

    def list_resource_scopes(self) -> List[str]:
        if not self.is_scoped:
            return []
        return [
            build_resource_scope(self.provider_name, resource_id)
            for resource_id in self.definition.list_resource_ids()
        ]

    def list_action_scopes(self) -> List[str]:
        if not self.is_scoped:
            return []
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
    if not isinstance(providers, dict):
        raise ValueError(
            "Workspace provider registry must be a dictionary under metadata.providers"
        )

    normalized: Dict[str, Dict[str, Any]] = {}
    for provider_name, entry in providers.items():
        normalized_name = str(provider_name or "").strip()
        if not normalized_name:
            raise ValueError("Workspace provider registry contains an empty provider key")
        if not isinstance(entry, dict):
            raise ValueError(
                f"Workspace provider registry entry '{normalized_name}' must be an object"
            )
        normalized[normalized_name] = dict(entry)

    return normalized


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


def _runtime_provider_payload(
    *,
    workspace: str,
    provider_name: str,
    entry: Dict[str, Any],
) -> Dict[str, Any]:
    base_url = str(entry.get("base_url") or "").strip()
    if not base_url:
        raise ValueError(
            f"Provider '{provider_name}' must define a non-empty base_url for runtime sync"
        )

    service_type = str(entry.get("service_type") or "").strip().lower()
    if not service_type:
        raise ValueError(
            f"Provider '{provider_name}' must define a non-empty service_type for runtime sync"
        )

    auth_scheme = str(entry.get("auth_scheme") or "").strip().lower()
    if not auth_scheme:
        raise ValueError(
            f"Provider '{provider_name}' must define a non-empty auth_scheme for runtime sync"
        )

    provider_definition = str(entry.get("provider_definition") or "").strip()
    if not provider_definition:
        raise ValueError(
            f"Provider '{provider_name}' must define a non-empty provider_definition for runtime sync"
        )

    scoped_flag = entry.get("enforce_scoped_requests", False)
    if not isinstance(scoped_flag, bool):
        raise ValueError(
            f"Provider '{provider_name}' must set enforce_scoped_requests as a boolean"
        )

    enabled_flag = entry.get("enabled", True)
    if not isinstance(enabled_flag, bool):
        raise ValueError(
            f"Provider '{provider_name}' must set enabled as a boolean"
        )

    definition_payload = entry.get("definition")
    normalized_definition = dict(definition_payload or {}) if isinstance(definition_payload, dict) else {}
    if scoped_flag:
        resources = normalized_definition.get("resources")
        if not isinstance(resources, dict) or not resources:
            raise ValueError(
                f"Provider '{provider_name}' is scoped and requires definition.resources for runtime sync"
            )

    access_policy = dict(entry.get("access_policy") or {})
    scopes = entry.get("scopes")
    if not isinstance(scopes, list):
        fallback_scopes = access_policy.get("scopes")
        scopes = list(fallback_scopes) if isinstance(fallback_scopes, list) else []

    provider_metadata = dict(entry.get("metadata") or {})
    if "workspace" not in provider_metadata:
        provider_metadata["workspace"] = workspace

    managed_by = entry.get("managed_by")
    if managed_by is None:
        managed_by = f"workspace:{workspace}"

    return {
        "provider_id": provider_name,
        "name": str(entry.get("name") or provider_name),
        "base_url": base_url,
        "service_type": service_type,
        "auth_scheme": auth_scheme,
        "version": entry.get("version"),
        "capabilities": list(entry.get("capabilities") or []),
        "tags": list(entry.get("tags") or []),
        "provider_metadata": provider_metadata,
        "provider_definition": provider_definition,
        "definition": normalized_definition,
        "resources": list(entry.get("resources") or []),
        "actions": list(entry.get("actions") or []),
        "enforce_scoped_requests": scoped_flag,
        "auth_metadata": dict(entry.get("auth_metadata") or {}),
        "provider_layer": str(entry.get("provider_layer") or "user_provider"),
        "template_id": entry.get("template_id"),
        "managed_by": managed_by,
        "credential_storage": str(entry.get("credential_storage") or "workspace_vault"),
        "allowed_paths": list(entry.get("allowed_paths") or []),
        "scopes": scopes,
        "tls_pin": entry.get("tls_pin"),
        "credential_ref": entry.get("credential_ref"),
        "healthcheck_path": str(entry.get("healthcheck_path") or "/health"),
        "timeout_seconds": int(entry.get("timeout_seconds") or 30),
        "max_retries": int(entry.get("max_retries") or 3),
        "rate_limit_rpm": entry.get("rate_limit_rpm"),
        "default_headers": dict(entry.get("default_headers") or {}),
        "access_policy": access_policy,
        "enabled": enabled_flag,
    }


def sync_workspace_provider_registry_runtime(
    *,
    workspace: str,
    providers: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Validate workspace providers and refresh affected MCP tool bindings."""
    from caracal.db.connection import get_db_manager
    from caracal.mcp.tool_registry_contract import deactivate_invalid_provider_tools

    normalized_providers: Dict[str, Dict[str, Any]] = {}
    for provider_name, entry in providers.items():
        normalized_name = str(provider_name or "").strip()
        if not normalized_name:
            continue
        normalized_providers[normalized_name] = dict(entry or {})

    stats = {
        "validated": 0,
        "active": len(normalized_providers),
        "deactivated_tools": 0,
        "impacted": [],
    }

    for provider_name, entry in normalized_providers.items():
        _runtime_provider_payload(
            workspace=workspace,
            provider_name=provider_name,
            entry=entry,
        )
        stats["validated"] += 1

    db_manager = get_db_manager()
    try:
        with db_manager.session_scope() as session:
            impacted: list[Dict[str, str]] = []
            for provider_name in normalized_providers.keys():
                impacted.extend(
                    deactivate_invalid_provider_tools(
                        db_session=session,
                        provider_name=provider_name,
                    )
                )

            stats["impacted"] = impacted
            stats["deactivated_tools"] = len(impacted)

        return stats
    finally:
        db_manager.close()


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


def split_scope_by_provider(scope: str) -> Tuple[str, str]:
    """Return (provider_name, identifier) for canonical provider scope."""
    parsed = parse_provider_scope(scope)
    return parsed["provider_name"], parsed["identifier"]
