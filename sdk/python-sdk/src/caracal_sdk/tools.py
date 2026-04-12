"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Tool Call Operations.

Provides explicit MCP tool-call APIs within a scoped context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from caracal_sdk._compat import SDKConfigurationError, get_logger
from caracal_sdk.adapters.base import SDKRequest

if TYPE_CHECKING:
    from caracal_sdk.context import ScopeContext

logger = get_logger(__name__)

# Canonical SDK->MCP tool-call contract version.
CANONICAL_TOOL_CALL_CONTRACT_VERSION = "v1"

# SDK metadata is correlation-only; binding/policy selectors are backend-owned.
_ALLOWED_CORRELATION_METADATA_KEYS = {
    "correlation_id",
    "trace_id",
    "request_id",
}
_PROHIBITED_CALLER_SPOOFING_FIELDS = {
    "principal_id",
    "mandate_id",
    "resolved_mandate_id",
    "policy_id",
    "token_subject",
    "task_token_claims",
    "task_caveat_chain",
    "task_caveat_hmac_key",
    "caveat_chain",
    "caveat_hmac_key",
    "caveat_task_id",
}


class ToolOperations:
    """Tool invocation operations within a scoped context."""

    def __init__(self, scope: ScopeContext) -> None:
        self._scope = scope

    def _build_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> SDKRequest:
        headers = dict(self._scope.scope_headers())
        return SDKRequest(method=method, path=path, headers=headers, body=body)

    async def _execute(self, request: SDKRequest) -> Any:
        scope_ref = self._scope.to_scope_ref()
        request = self._scope._hooks.fire_before_request(request, scope_ref)
        try:
            response = await self._scope._adapter.send(request)
            self._scope._hooks.fire_after_response(response, scope_ref)
            return response.body
        except Exception as exc:
            self._scope._hooks.fire_error(exc)
            raise

    async def call(
        self,
        *,
        tool_id: str,
        tool_args: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        correlation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Call a registered tool through the canonical MCP service endpoint.

        ``{tool_id, tool_args, metadata}``.

        Metadata is limited to correlation keys only.
        """
        tool_id = str(tool_id or "").strip()
        if not tool_id:
            raise SDKConfigurationError("tool_id is required")

        if metadata is not None and not isinstance(metadata, dict):
            raise SDKConfigurationError("metadata must be a dictionary")
        if tool_args is not None and not isinstance(tool_args, dict):
            raise SDKConfigurationError("tool_args must be a dictionary")

        payload_metadata: Dict[str, Any] = dict(metadata or {})
        prohibited_metadata_keys = sorted(
            key
            for key in payload_metadata.keys()
            if str(key) in _PROHIBITED_CALLER_SPOOFING_FIELDS
        )
        if prohibited_metadata_keys:
            raise SDKConfigurationError(
                f"Caller identity fields are not allowed in tool call metadata: {', '.join(prohibited_metadata_keys)}"
            )

        invalid_metadata_keys = sorted(
            key
            for key in payload_metadata.keys()
            if str(key) not in _ALLOWED_CORRELATION_METADATA_KEYS
        )
        if invalid_metadata_keys:
            raise SDKConfigurationError(
                "metadata supports correlation keys only: "
                f"{', '.join(sorted(_ALLOWED_CORRELATION_METADATA_KEYS))}"
            )

        if correlation_id:
            payload_metadata["correlation_id"] = str(correlation_id)

        payload_args = dict(tool_args or {})
        prohibited_tool_args = sorted(
            key
            for key in payload_args.keys()
            if str(key) in _PROHIBITED_CALLER_SPOOFING_FIELDS
        )
        if prohibited_tool_args:
            raise SDKConfigurationError(
                f"Caller identity fields are not allowed in tool_args: {', '.join(prohibited_tool_args)}"
            )

        req = self._build_request(
            "POST",
            "/mcp/tool/call",
            body={
                "tool_id": tool_id,
                "tool_args": payload_args,
                "metadata": payload_metadata,
            },
        )
        logger.info("Calling tool via SDK", extra={"tool_id": tool_id})
        result = await self._execute(req)
        return result if isinstance(result, dict) else {"result": result}
