"""Unit tests for disabled legacy AuthorityClient tool-call paths."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

pytest.importorskip("aiohttp")

from caracal_sdk._compat import SDKConfigurationError
from caracal_sdk.authority_client import AuthorityClient


_MANDATE_ID = "11111111-1111-1111-1111-111111111111"


@pytest.mark.unit
def test_legacy_authority_client_call_tool_is_disabled() -> None:
    client = AuthorityClient(base_url="http://localhost:8000")

    with pytest.raises(SDKConfigurationError, match="disabled in hard-cut mode"):
        client.call_tool(
            tool_name="tool.echo",
            mandate_id=_MANDATE_ID,
            tool_args={"payload": "ok"},
            metadata={"source": "legacy"},
        )
    client.close()


@pytest.mark.unit
def test_legacy_authority_client_call_tool_rejects_principal_id() -> None:
    client = AuthorityClient(base_url="http://localhost:8000")

    with pytest.raises(SDKConfigurationError, match="disabled in hard-cut mode"):
        client.call_tool(
            tool_id="tool.echo",
            mandate_id=_MANDATE_ID,
            metadata={"principal_id": "forbidden"},
        )

    with pytest.raises(SDKConfigurationError, match="disabled in hard-cut mode"):
        client.call_tool(
            tool_id="tool.echo",
            mandate_id=_MANDATE_ID,
            tool_args={"principal_id": "forbidden"},
        )

    client.close()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_legacy_async_authority_client_call_tool_is_disabled() -> None:
    pytest.importorskip("aiohttp")
    from caracal_sdk.async_authority_client import AsyncAuthorityClient

    client = AsyncAuthorityClient(base_url="http://localhost:8000")
    client._make_request = AsyncMock(return_value={"success": True})

    with pytest.raises(SDKConfigurationError, match="disabled in hard-cut mode"):
        await client.call_tool(
            tool_id="tool.echo",
            mandate_id=_MANDATE_ID,
            tool_args={"payload": "ok"},
            metadata={"source": "legacy"},
        )
    await client.close()
