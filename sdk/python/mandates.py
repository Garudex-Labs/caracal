"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Mandate Operations.

Provides mandate lifecycle management within a scoped context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import SDKRequest

if TYPE_CHECKING:
    from caracal.sdk.context import ScopeContext

logger = get_logger(__name__)


class MandateOperations:
    """Mandate lifecycle management within a scoped context.

    All methods inject scope headers and fire lifecycle hooks.
    """

    def __init__(self, scope: ScopeContext) -> None:
        self._scope = scope

    def _build_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> SDKRequest:
        headers = dict(self._scope.scope_headers())
        return SDKRequest(
            method=method, path=path, headers=headers, body=body, params=params
        )

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

    # -- Public API --------------------------------------------------------

    async def create(
        self,
        agent_id: str,
        allowed_operations: List[str],
        expires_in: int,
        intent: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a new execution mandate."""
        body: Dict[str, Any] = {
            "agent_id": agent_id,
            "allowed_operations": allowed_operations,
            "expires_in": expires_in,
        }
        if intent:
            body["intent"] = intent
        if metadata:
            body["metadata"] = metadata
        req = self._build_request("POST", "/mandates", body=body)
        return await self._execute(req)

    async def validate(
        self,
        mandate_id: str,
        requested_action: str,
        requested_resource: str,
    ) -> Dict[str, Any]:
        """Validate a mandate for a specific action."""
        body = {
            "requested_action": requested_action,
            "requested_resource": requested_resource,
        }
        req = self._build_request(
            "POST", f"/mandates/{mandate_id}/validate", body=body
        )
        return await self._execute(req)

    async def revoke(
        self,
        mandate_id: str,
        revoker_id: str,
        reason: str,
        cascade: bool = True,
    ) -> Dict[str, Any]:
        """Revoke an execution mandate."""
        body = {
            "revoker_id": revoker_id,
            "reason": reason,
            "cascade": cascade,
        }
        req = self._build_request(
            "POST", f"/mandates/{mandate_id}/revoke", body=body
        )
        return await self._execute(req)

    async def get(self, mandate_id: str) -> Dict[str, Any]:
        """Get a mandate by ID."""
        req = self._build_request("GET", f"/mandates/{mandate_id}")
        return await self._execute(req)

    async def list(
        self,
        agent_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """List mandates, optionally filtered by agent."""
        params: Dict[str, Any] = {"limit": limit}
        if agent_id:
            params["agent_id"] = agent_id
        req = self._build_request("GET", "/mandates", params=params)
        return await self._execute(req)
