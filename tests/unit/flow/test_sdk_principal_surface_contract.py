"""Unit tests for principal-first SDK surfaces and removed legacy resource APIs."""

from __future__ import annotations

import pytest

from caracal_sdk._compat import SDKConfigurationError
from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.client import CaracalClient
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry


class _NoopAdapter(BaseAdapter):
    async def send(self, request: SDKRequest) -> SDKResponse:
        return SDKResponse(status_code=200, body={"request": request.path})

    def close(self) -> None:
        return None

    @property
    def is_connected(self) -> bool:
        return True


@pytest.mark.unit
def test_scope_context_exposes_principals_and_deprecated_agents_alias() -> None:
    scope = ScopeContext(adapter=_NoopAdapter(), hooks=HookRegistry())

    principals = scope.principals
    with pytest.warns(DeprecationWarning, match="ScopeContext.agents"):
        agents = scope.agents

    assert agents is principals


@pytest.mark.unit
def test_client_exposes_principals_and_deprecated_agents_alias() -> None:
    client = CaracalClient(adapter=_NoopAdapter())

    principals = client.principals
    with pytest.warns(DeprecationWarning, match="CaracalClient.agents"):
        agents = client.agents

    assert agents is principals
    client.close()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_principal_surface_fails_closed_for_removed_agents_routes() -> None:
    scope = ScopeContext(adapter=_NoopAdapter(), hooks=HookRegistry())

    with pytest.raises(SDKConfigurationError, match="Legacy compatibility is not supported"):
        await scope.principals.list()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_legacy_resource_scopes_fail_closed_for_mandate_delegation_ledger() -> None:
    scope = ScopeContext(adapter=_NoopAdapter(), hooks=HookRegistry())

    with pytest.raises(SDKConfigurationError, match="Legacy compatibility is not supported"):
        await scope.mandates.list()

    with pytest.raises(SDKConfigurationError, match="Legacy compatibility is not supported"):
        await scope.delegation.get_graph(principal_id="p-1")

    with pytest.raises(SDKConfigurationError, match="Legacy compatibility is not supported"):
        await scope.ledger.query()
