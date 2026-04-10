"""Caracal SDK wrapper for governed tool calls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class GovernedClientConfig:
    api_key: str
    base_url: str
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None


class GovernedToolClient:
    def __init__(self, config: GovernedClientConfig) -> None:
        from caracal_sdk.client import CaracalClient
        from caracal_sdk.authority_client import AuthorityClient

        self._config = config
        self._client = CaracalClient(api_key=config.api_key, base_url=config.base_url)
        self._authority_client = AuthorityClient(
            base_url=config.base_url,
            api_key=config.api_key,
            workspace_id=config.workspace_id,
        )

    async def call_tool(
        self,
        *,
        tool_id: str,
        mandate_id: str,
        tool_args: dict[str, Any],
        correlation_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """CARACAL_MARKER: MANDATE_REQUIRED.

        Every governed call must be bound to an explicit mandate_id.
        """
        scope = self._client.context.checkout(
            organization_id=self._config.organization_id,
            workspace_id=self._config.workspace_id,
            project_id=self._config.project_id,
        )
        result = await scope.tools.call(
            tool_id=tool_id,
            mandate_id=mandate_id,
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
        return self._authority_client.revoke_mandate(
            mandate_id=mandate_id,
            revoker_id=revoker_id,
            reason=reason,
            cascade=cascade,
        )

    def validate_mandate(
        self,
        *,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
    ) -> dict[str, Any]:
        return self._authority_client.validate_mandate(
            mandate_id=mandate_id,
            requested_action=requested_action,
            requested_resource=requested_resource,
        )

    def close(self) -> None:
        self._authority_client.close()
        self._client.close()
