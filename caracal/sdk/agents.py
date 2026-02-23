"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Agent Operations.

Provides CRUD operations for agents scoped to an Org/Workspace/Project.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import SDKRequest

if TYPE_CHECKING:
    from caracal.sdk.context import ScopeContext

logger = get_logger(__name__)


class AgentOperations:
    """Agent management within a scoped context.

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

    async def list(self, limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
        """List agents in the current scope."""
        req = self._build_request(
            "GET", "/agents", params={"limit": limit, "offset": offset}
        )
        return await self._execute(req)

    async def get(self, agent_id: str) -> Dict[str, Any]:
        """Get an agent by ID."""
        req = self._build_request("GET", f"/agents/{agent_id}")
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

    async def update(self, agent_id: str, **kwargs: Any) -> Dict[str, Any]:
        """Update an existing agent."""
        req = self._build_request("PATCH", f"/agents/{agent_id}", body=kwargs)
        return await self._execute(req)

    async def delete(self, agent_id: str) -> Dict[str, Any]:
        """Delete an agent."""
        req = self._build_request("DELETE", f"/agents/{agent_id}")
        return await self._execute(req)

    async def create_child(
        self,
        parent_agent_id: str,
        child_name: str,
        child_owner: str,
        generate_token: bool = False,
    ) -> Dict[str, Any]:
        """Create a child agent under a parent."""
        body: Dict[str, Any] = {
            "child_name": child_name,
            "child_owner": child_owner,
            "generate_token": generate_token,
        }
        req = self._build_request(
            "POST", f"/agents/{parent_agent_id}/children", body=body
        )
        return await self._execute(req)
