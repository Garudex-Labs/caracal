"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Principal Operations.

"Agents" in this SDK correspond to principal identities such as
orchestrators and workers.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from caracal_sdk._compat import get_logger
from caracal_sdk.adapters.base import SDKRequest
from caracal_sdk.runtime_surface import require_legacy_resource_api

if TYPE_CHECKING:
    from caracal_sdk.context import ScopeContext

logger = get_logger(__name__)


class PrincipalOperations:
    """Principal management surface within a scoped context.

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
        require_legacy_resource_api("PrincipalOperations", "/agents")
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

    async def list(self, limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
        """List agents in the current scope."""
        req = self._build_request(
            "GET", "/agents", params={"limit": limit, "offset": offset}
        )
        return await self._execute(req)

    async def get(self, principal_id: str) -> Dict[str, Any]:
        """Get an agent by ID."""
        req = self._build_request("GET", f"/agents/{principal_id}")
        return await self._execute(req)

    async def create(
        self,
        name: str,
        owner: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Register a new agent."""
        body: Dict[str, Any] = {"name": name, "owner": owner}
        if metadata:
            body["metadata"] = metadata
        req = self._build_request("POST", "/agents", body=body)
        return await self._execute(req)

    async def update(self, principal_id: str, **kwargs: Any) -> Dict[str, Any]:
        """Update an existing agent."""
        req = self._build_request("PATCH", f"/agents/{principal_id}", body=kwargs)
        return await self._execute(req)

    async def delete(self, principal_id: str) -> Dict[str, Any]:
        """Delete an agent."""
        req = self._build_request("DELETE", f"/agents/{principal_id}")
        return await self._execute(req)

    async def delegate_authority(
        self,
        source_principal_id: str,
        target_principal_id: str,
        delegation_type: str = "directed",
        context_tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Delegate authority from source agent to target agent via delegation graph."""
        body: Dict[str, Any] = {
            "target_principal_id": target_principal_id,
            "delegation_type": delegation_type,
        }
        if context_tags:
            body["context_tags"] = context_tags
        req = self._build_request(
            "POST", f"/agents/{source_principal_id}/delegate", body=body
        )
        return await self._execute(req)


# Backward compatibility alias for existing imports.
AgentOperations = PrincipalOperations
