"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Delegation Operations.

Provides delegation token management within a scoped context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import SDKRequest

if TYPE_CHECKING:
    from caracal.sdk.context import ScopeContext

logger = get_logger(__name__)


class DelegationOperations:
    """Delegation chain and token management within a scoped context.

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
        parent_mandate_id: str,
        child_subject_id: str,
        resource_scope: List[str],
        action_scope: List[str],
        validity_seconds: int,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a delegated mandate from a parent mandate."""
        body: Dict[str, Any] = {
            "parent_mandate_id": parent_mandate_id,
            "child_subject_id": child_subject_id,
            "resource_scope": resource_scope,
            "action_scope": action_scope,
            "validity_seconds": validity_seconds,
        }
        if metadata:
            body["metadata"] = metadata
        req = self._build_request("POST", "/delegations", body=body)
        return await self._execute(req)

    async def get_token(
        self,
        parent_agent_id: str,
        child_agent_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Generate a delegation token for a child agent."""
        body: Dict[str, Any] = {
            "parent_agent_id": parent_agent_id,
            "child_agent_id": child_agent_id,
            "expiration_seconds": expiration_seconds,
        }
        if allowed_operations:
            body["allowed_operations"] = allowed_operations
        req = self._build_request("POST", "/delegations/token", body=body)
        return await self._execute(req)

    async def get_chain(self, agent_id: str) -> List[Dict[str, Any]]:
        """Get the delegation chain for an agent."""
        req = self._build_request("GET", f"/delegations/chain/{agent_id}")
        return await self._execute(req)
