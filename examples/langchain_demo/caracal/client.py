"""Caracal SDK wrapper for governed tool calls with thin SDK architecture."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class GovernedClientConfig:
    """Configuration for Caracal client with Bearer token authentication.
    
    # BEARER_TOKEN_AUTH: Principal identity from token, not parameters
    # The api_key field contains a Bearer token with principal identity in claims
    # Token format: "Bearer <jwt_token>"
    # Token claims include: principal_id (in 'sub' or 'principal_id' field)
    # 
    # SECURITY_REASONING:
    # - Prevents impersonation: Token cryptographically verified by Caracal
    # - Reduces attack surface: No identity parameters in SDK calls
    # - Centralized enforcement: Authority resolved by runtime/broker/gateway
    # - Audit trail: All actions logged with verified principal_id from token
    """
    api_key: str  # Bearer token containing principal identity
    base_url: str
    organization_id: Optional[str] = None
    workspace_id: Optional[str] = None
    project_id: Optional[str] = None


class GovernedToolClient:
    """Thin SDK client for governed tool execution.
    
    # THIN SDK ARCHITECTURE
    # This client demonstrates Caracal's thin SDK model where:
    # 1. SDK is execution-only (no control-plane operations)
    # 2. Principal identity from Bearer token (not parameters)
    # 3. Authority resolved internally by Caracal
    # 4. All setup via CLI/TUI (not SDK)
    # 
    # SETUP_VIA_CLI:
    # Before using this client, complete setup via Caracal CLI:
    # 
    # 1. Register principal:
    #    caracal principal register --name "Finance Agent" --email finance@company.com
    # 
    # 2. Issue mandate:
    #    caracal authority mandate issue \
    #      --issuer-id <issuer-principal-id> \
    #      --subject-id <finance-principal-id> \
    #      --tool-id <tool-id> \
    #      --validity-seconds 3600
    # 
    # 3. Generate Bearer token for principal (via session manager)
    # 
    # AUTHENTICATION:
    # - Bearer token passed in api_key parameter
    # - Token contains principal_id in claims (sub or principal_id field)
    # - Caracal MCP service validates token and extracts principal_id
    # - No way to spoof identity - token cryptographically verified
    """
    
    def __init__(self, config: GovernedClientConfig) -> None:
        """Initialize client with Bearer token authentication.
        
        Args:
            config: Client configuration with Bearer token in api_key field
        """
        from caracal_sdk.client import CaracalClient

        self._config = config
        # BEARER_TOKEN_AUTH: api_key contains Bearer token with principal identity
        self._client = CaracalClient(api_key=config.api_key, base_url=config.base_url)

    async def call_tool(
        self,
        *,
        tool_id: str,
        tool_args: dict[str, Any],
        correlation_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """THIN_SDK_TOOL_CALL: Execute tool with principal identity from Bearer token.

        The thin SDK model:
        - Principal identity comes from Bearer token (not parameters)
        - Authority resolved internally by Caracal runtime/broker/gateway
        - No manual mandate_id, policy_id, or principal_id parameters
        - Prevents impersonation and reduces attack surface
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

    def revoke_mandate(
        self,
        *,
        mandate_id: str,
        revoker_id: str,
        reason: str,
        cascade: bool = True,
    ) -> dict[str, Any]:
        raise NotImplementedError(
            "Mandate admin operations are not exposed by the SDK in hard-cut mode. "
            "Use Caracal control surfaces (CLI/runtime/gateway)."
        )

    def validate_mandate(
        self,
        *,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
    ) -> dict[str, Any]:
        raise NotImplementedError(
            "Mandate admin operations are not exposed by the SDK in hard-cut mode. "
            "Use Caracal control surfaces (CLI/runtime/gateway)."
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
            "Ledger admin operations are not exposed by the SDK in hard-cut mode. "
            "Use Caracal control surfaces (CLI/runtime/gateway)."
        )

    def close(self) -> None:
        self._client.close()
