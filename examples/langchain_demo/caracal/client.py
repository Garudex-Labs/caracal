"""Caracal SDK wrapper for governed tool calls with the thin SDK contract."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


def _normalize_api_key(api_key: str) -> str:
    """Accept raw JWT tokens and tolerate accidental ``Bearer `` prefixes."""
    normalized = str(api_key or "").strip()
    if normalized.lower().startswith("bearer "):
        return normalized[7:].strip()
    return normalized


@dataclass(frozen=True)
class GovernedClientConfig:
    """Configuration for token-scoped Caracal SDK access.

    ``api_key`` should be the raw token value. The SDK transport adds the
    ``Authorization: Bearer`` prefix.
    """

    api_key: str
    base_url: str
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None


class GovernedToolClient:
    """Thin SDK client for governed tool execution.

    The SDK is execution-only. Identity comes from the validated bearer token;
    control-plane operations remain in CLI, Flow, or gateway surfaces.
    """

    def __init__(self, config: GovernedClientConfig) -> None:
        """Initialize the execution client."""
        from caracal_sdk.client import CaracalClient

        self._config = config
        self._client = CaracalClient(
            api_key=_normalize_api_key(config.api_key),
            base_url=config.base_url,
        )

    async def call_tool(
        self,
        *,
        tool_id: str,
        tool_args: dict[str, Any],
        correlation_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute a governed tool call using token-derived caller identity."""
        scope = self._client.context.checkout(
            organization_id=self._config.organization_id,
            workspace_id=self._config.workspace_id,
            project_id=self._config.project_id,
        )
        result = await scope.tools.call(
            tool_id=tool_id,
            tool_args=tool_args,
            correlation_id=correlation_id,
        )
        return result if isinstance(result, dict) else {"result": result}

    def revoke_mandate(
        self,
        *,
        mandate_id: str,
        revoker_id: str,
        reason: str,
        cascade: bool = True,
    ) -> dict[str, Any]:
        raise NotImplementedError(
            "The SDK is execution-only. Use Caracal control surfaces (CLI/Flow/gateway) "
            "for mandate revocation."
        )

    def validate_mandate(
        self,
        *,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
    ) -> dict[str, Any]:
        raise NotImplementedError(
            "The SDK is execution-only. Use Caracal control surfaces (CLI/Flow/gateway) "
            "for mandate validation."
        )

    def query_ledger(
        self,
        *,
        principal_id: Optional[str] = None,
        mandate_id: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        raise NotImplementedError(
            "The SDK is execution-only. Use Caracal control surfaces (CLI/Flow/gateway) "
            "for ledger queries."
        )

    def close(self) -> None:
        self._client.close()
