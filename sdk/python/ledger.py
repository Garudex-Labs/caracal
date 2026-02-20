"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Ledger Query Interface.

Provides audit trail queries within a scoped context.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from caracal.logging_config import get_logger
from caracal.sdk.adapters.base import SDKRequest

if TYPE_CHECKING:
    from caracal.sdk.context import ScopeContext

logger = get_logger(__name__)


class LedgerOperations:
    """Ledger query operations within a scoped context.

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

    async def query(
        self,
        principal_id: Optional[str] = None,
        mandate_id: Optional[str] = None,
        event_type: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Query the authority ledger for events."""
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if principal_id:
            params["principal_id"] = principal_id
        if mandate_id:
            params["mandate_id"] = mandate_id
        if event_type:
            params["event_type"] = event_type
        if start_time:
            params["start_time"] = start_time.isoformat()
        if end_time:
            params["end_time"] = end_time.isoformat()
        req = self._build_request("GET", "/ledger/events", params=params)
        return await self._execute(req)

    async def get_entry(self, entry_id: str) -> Dict[str, Any]:
        """Get a single ledger entry."""
        req = self._build_request("GET", f"/ledger/entries/{entry_id}")
        return await self._execute(req)

    async def get_chain(self, mandate_id: str) -> List[Dict[str, Any]]:
        """Get the full event chain for a mandate."""
        req = self._build_request("GET", f"/ledger/chain/{mandate_id}")
        return await self._execute(req)

    async def verify_integrity(self, entry_id: str) -> Dict[str, Any]:
        """Verify cryptographic integrity of a ledger entry."""
        req = self._build_request("GET", f"/ledger/verify/{entry_id}")
        return await self._execute(req)
