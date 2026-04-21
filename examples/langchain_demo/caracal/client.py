"""Caracal SDK wrapper for governed tool calls.

This client uses Caracal's thin SDK architecture:
- SDK is execution-only (no control-plane operations)
- Principal identity comes from Bearer token (not parameters)
- Authority resolved internally by Caracal runtime
- All setup (principals, mandates, tools) done via CLI/TUI

MOCK vs REAL: This client is identical in both modes. The only difference
is which providers and tools are registered in Caracal. Mock providers
return deterministic responses; real providers call actual APIs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class GovernedClientConfig:
    """Configuration for the Caracal SDK client.

    api_key: Bearer token issued by Caracal. Contains principal identity
             in its claims. Caracal extracts principal_id from the token
             and resolves authority internally.
    base_url: Caracal runtime endpoint (e.g. http://127.0.0.1:8080).
    """

    api_key: str
    base_url: str
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None


class GovernedToolClient:
    """Thin SDK client for governed tool execution.

    Usage::

        client = GovernedToolClient(GovernedClientConfig(
            api_key=os.environ["CARACAL_API_KEY"],
            base_url="http://127.0.0.1:8080",
            workspace_id="langchain-demo",
        ))

        result = await client.call_tool(
            tool_id="demo:employee:mock:finance:data",
            tool_args={"scenario": scenario},
        )

    The SDK only exposes tool execution. Control-plane operations
    (principal registration, mandate issuance, tool registration,
    revocation, ledger queries) are performed via Caracal CLI/TUI.
    """

    def __init__(self, config: GovernedClientConfig) -> None:
        from caracal_sdk.client import CaracalClient

        self._config = config
        self._client = CaracalClient(api_key=config.api_key, base_url=config.base_url)

    async def call_tool(
        self,
        *,
        tool_id: str,
        tool_args: dict[str, Any],
        correlation_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute a registered tool through Caracal.

        Caracal internally:
        1. Extracts principal_id from the Bearer token
        2. Resolves applicable mandates for the principal
        3. Validates authority against the tool's resource/action scopes
        4. Routes to the registered provider (mock or real)
        5. Returns the tool result with execution metadata

        If authority is denied, the response has success=False with an
        error message explaining why.
        """
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

    def close(self) -> None:
        self._client.close()
