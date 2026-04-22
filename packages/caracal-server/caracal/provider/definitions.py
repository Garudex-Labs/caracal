"""
Provider-driven resource and action definitions.

The authority model uses canonical, provider-scoped identifiers:

  resource scope: provider:<provider_name>:resource:<resource_id>
  action scope:   provider:<provider_name>:action:<action_id>
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import re


_SCOPE_RE = re.compile(
    r"^provider:(?P<provider>[a-zA-Z0-9._-]+):(?P<kind>resource|action):(?P<identifier>[a-zA-Z0-9._-]+)$"
)
_IDENTIFIER_RE = re.compile(r"^[a-zA-Z0-9._-]+$")


class ScopeParseError(ValueError):
    """Raised when a scope string is invalid."""


@dataclass(frozen=True)
class ProviderActionDefinition:
    """Action supported by a provider resource."""

    action_id: str
    description: str
    method: str = "POST"
    path_prefix: str = "/"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not _IDENTIFIER_RE.match(self.action_id):
            raise ValueError(f"Invalid action_id: {self.action_id}")
        if not self.path_prefix.startswith("/"):
            raise ValueError(f"path_prefix must start with '/': {self.path_prefix}")


@dataclass(frozen=True)
class ProviderResourceDefinition:
    """Resource supported by a provider."""

    resource_id: str
    description: str
    actions: Dict[str, ProviderActionDefinition]
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not _IDENTIFIER_RE.match(self.resource_id):
            raise ValueError(f"Invalid resource_id: {self.resource_id}")
        if not self.actions:
            raise ValueError(f"Resource '{self.resource_id}' must define at least one action")

    def list_action_ids(self) -> List[str]:
        return sorted(self.actions.keys())


@dataclass(frozen=True)
class ProviderDefinition:
    """Immutable provider definition used for scope generation/validation."""

    definition_id: str
    service_type: str
    display_name: str
    auth_scheme: str
    default_base_url: Optional[str]
    resources: Dict[str, ProviderResourceDefinition]
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not _IDENTIFIER_RE.match(self.definition_id):
            raise ValueError(f"Invalid definition_id: {self.definition_id}")
        if not self.resources:
            raise ValueError(f"Provider definition '{self.definition_id}' must define resources")

    def list_resource_ids(self) -> List[str]:
        return sorted(self.resources.keys())

    def list_action_ids(self, resource_id: Optional[str] = None) -> List[str]:
        if resource_id:
            resource = self.resources.get(resource_id)
            return sorted(resource.actions.keys()) if resource else []
        action_ids = set()
        for resource in self.resources.values():
            action_ids.update(resource.actions.keys())
        return sorted(action_ids)

    def get_action(
        self,
        action_id: str,
        resource_id: Optional[str] = None,
    ) -> Optional[ProviderActionDefinition]:
        if resource_id:
            resource = self.resources.get(resource_id)
            if not resource:
                return None
            return resource.actions.get(action_id)
        for resource in self.resources.values():
            action = resource.actions.get(action_id)
            if action:
                return action
        return None


_PROVIDER_DEFINITIONS: Dict[str, ProviderDefinition] = {}


def list_provider_definitions() -> List[ProviderDefinition]:
    """Return all available provider definitions."""
    return [_PROVIDER_DEFINITIONS[k] for k in sorted(_PROVIDER_DEFINITIONS.keys())]


def list_provider_definition_ids() -> List[str]:
    """Return sorted definition IDs."""
    return sorted(_PROVIDER_DEFINITIONS.keys())


def get_provider_definition(definition_id: str) -> ProviderDefinition:
    """Return a provider definition by ID."""
    try:
        return _PROVIDER_DEFINITIONS[definition_id]
    except KeyError as e:
        raise KeyError(
            f"Unknown provider definition '{definition_id}'. "
            "Open-source mode does not ship built-in provider catalogs; "
            "register provider definitions per workspace/provider."
        ) from e


def provider_definition_from_mapping(
    data: Dict[str, Any],
    *,
    default_definition_id: str,
    default_service_type: str = "api",
    default_display_name: Optional[str] = None,
    default_auth_scheme: str = "api_key",
    default_base_url: Optional[str] = None,
) -> ProviderDefinition:
    """Build a ProviderDefinition from a persisted dictionary payload."""
    resources_data = data.get("resources")
    if not isinstance(resources_data, dict) or not resources_data:
        raise ValueError("Provider definition payload must include non-empty 'resources'")

    resources: Dict[str, ProviderResourceDefinition] = {}
    for resource_id, resource_payload in resources_data.items():
        if not isinstance(resource_payload, dict):
            raise ValueError(f"Invalid resource payload for '{resource_id}'")
        actions_data = resource_payload.get("actions")
        if not isinstance(actions_data, dict) or not actions_data:
            raise ValueError(f"Resource '{resource_id}' must define at least one action")

        actions: Dict[str, ProviderActionDefinition] = {}
        for action_id, action_payload in actions_data.items():
            if not isinstance(action_payload, dict):
                raise ValueError(f"Invalid action payload for '{resource_id}:{action_id}'")
            actions[action_id] = ProviderActionDefinition(
                action_id=action_id,
                description=str(action_payload.get("description") or action_id),
                method=str(action_payload.get("method") or "POST").upper(),
                path_prefix=str(action_payload.get("path_prefix") or "/"),
                metadata=dict(action_payload.get("metadata") or {}),
            )

        resources[str(resource_id)] = ProviderResourceDefinition(
            resource_id=str(resource_id),
            description=str(resource_payload.get("description") or resource_id),
            actions=actions,
            metadata=dict(resource_payload.get("metadata") or {}),
        )

    return ProviderDefinition(
        definition_id=str(data.get("definition_id") or default_definition_id),
        service_type=str(data.get("service_type") or default_service_type),
        display_name=str(data.get("display_name") or default_display_name or default_definition_id),
        auth_scheme=str(data.get("auth_scheme") or default_auth_scheme),
        default_base_url=data.get("default_base_url", default_base_url),
        resources=resources,
        metadata=dict(data.get("metadata") or {}),
    )


def resolve_provider_definition_id(
    service_type: Optional[str],
    requested_definition: Optional[str],
) -> str:
    """
    Resolve the effective provider definition ID.

    Priority:
      1. Explicit definition ID
      2. Service type fallback
      3. custom
    """
    if requested_definition:
        return requested_definition.strip()

    normalized_service = (service_type or "").strip().lower()
    if normalized_service:
        return normalized_service

    return "custom"


def build_resource_scope(provider_name: str, resource_id: str) -> str:
    """Build canonical provider resource scope."""
    _validate_identifier("provider_name", provider_name)
    _validate_identifier("resource_id", resource_id)
    return f"provider:{provider_name}:resource:{resource_id}"


def build_action_scope(provider_name: str, action_id: str) -> str:
    """Build canonical provider action scope."""
    _validate_identifier("provider_name", provider_name)
    _validate_identifier("action_id", action_id)
    return f"provider:{provider_name}:action:{action_id}"


def parse_provider_scope(scope: str) -> Dict[str, str]:
    """Parse canonical provider scope string into parts."""
    match = _SCOPE_RE.match(scope.strip())
    if not match:
        raise ScopeParseError(
            "Invalid provider scope format. Expected "
            "'provider:<provider_name>:resource:<resource_id>' or "
            "'provider:<provider_name>:action:<action_id>'."
        )
    return {
        "provider_name": match.group("provider"),
        "kind": match.group("kind"),
        "identifier": match.group("identifier"),
    }


def _validate_identifier(name: str, value: str) -> None:
    if not _IDENTIFIER_RE.match(value):
        raise ValueError(f"Invalid {name}: '{value}'. Allowed: letters, numbers, '.', '-', '_'")
