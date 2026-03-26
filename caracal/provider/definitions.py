"""
Provider-driven resource and action definitions.

The authority model uses canonical, provider-scoped identifiers:

  resource scope: provider:<provider_name>:resource:<resource_id>
  action scope:   provider:<provider_name>:action:<action_id>
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional
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


def _action(
    action_id: str,
    description: str,
    method: str,
    path_prefix: str,
) -> ProviderActionDefinition:
    return ProviderActionDefinition(
        action_id=action_id,
        description=description,
        method=method.upper(),
        path_prefix=path_prefix,
    )


def _resource(
    resource_id: str,
    description: str,
    actions: Iterable[ProviderActionDefinition],
) -> ProviderResourceDefinition:
    by_id = {action.action_id: action for action in actions}
    return ProviderResourceDefinition(
        resource_id=resource_id,
        description=description,
        actions=by_id,
    )


_PROVIDER_DEFINITIONS: Dict[str, ProviderDefinition] = {
    "openai": ProviderDefinition(
        definition_id="openai",
        service_type="llm",
        display_name="OpenAI",
        auth_scheme="api_key",
        default_base_url="https://api.openai.com/v1",
        resources={
            "chat.completions": _resource(
                "chat.completions",
                "Chat Completions API",
                [
                    _action("invoke", "Create chat completion", "POST", "/chat/completions"),
                ],
            ),
            "responses": _resource(
                "responses",
                "Responses API",
                [
                    _action("invoke", "Create response", "POST", "/responses"),
                ],
            ),
            "embeddings": _resource(
                "embeddings",
                "Embeddings API",
                [
                    _action("invoke", "Create embeddings", "POST", "/embeddings"),
                ],
            ),
        },
    ),
    "anthropic": ProviderDefinition(
        definition_id="anthropic",
        service_type="llm",
        display_name="Anthropic",
        auth_scheme="api_key",
        default_base_url="https://api.anthropic.com/v1",
        resources={
            "messages": _resource(
                "messages",
                "Messages API",
                [
                    _action("invoke", "Create message", "POST", "/messages"),
                ],
            ),
        },
    ),
    "cohere": ProviderDefinition(
        definition_id="cohere",
        service_type="llm",
        display_name="Cohere",
        auth_scheme="api_key",
        default_base_url="https://api.cohere.ai/v1",
        resources={
            "chat": _resource(
                "chat",
                "Chat API",
                [
                    _action("invoke", "Create chat response", "POST", "/chat"),
                ],
            ),
            "embed": _resource(
                "embed",
                "Embed API",
                [
                    _action("invoke", "Create embeddings", "POST", "/embed"),
                ],
            ),
        },
    ),
    "generic_http": ProviderDefinition(
        definition_id="generic_http",
        service_type="api",
        display_name="Generic HTTP API",
        auth_scheme="api_key",
        default_base_url=None,
        resources={
            "default": _resource(
                "default",
                "Default provider endpoint",
                [
                    _action("get", "HTTP GET", "GET", "/"),
                    _action("post", "HTTP POST", "POST", "/"),
                    _action("put", "HTTP PUT", "PUT", "/"),
                    _action("delete", "HTTP DELETE", "DELETE", "/"),
                ],
            ),
        },
    ),
}


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
        valid = ", ".join(list_provider_definition_ids())
        raise KeyError(f"Unknown provider definition '{definition_id}'. Valid: {valid}") from e


def resolve_provider_definition_id(
    service_type: Optional[str],
    requested_definition: Optional[str],
) -> str:
    """
    Resolve the effective provider definition ID.

    Priority:
      1. Explicit definition ID
      2. Service type mapped to known definition
      3. generic_http
    """
    if requested_definition:
        get_provider_definition(requested_definition)  # Validate
        return requested_definition

    normalized_service = (service_type or "").strip().lower()
    if normalized_service in _PROVIDER_DEFINITIONS:
        return normalized_service

    if normalized_service in {"llm", "openai"}:
        return "openai"
    if normalized_service in {"anthropic"}:
        return "anthropic"
    if normalized_service in {"cohere"}:
        return "cohere"

    return "generic_http"


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
