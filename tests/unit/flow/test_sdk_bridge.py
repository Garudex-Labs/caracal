import pytest
from unittest.mock import AsyncMock

pytest.importorskip("aiohttp")

from caracal.flow import sdk_bridge


class _FakeClient:
    captured_kwargs: dict = {}

    def __init__(self, **kwargs):
        _FakeClient.captured_kwargs = dict(kwargs)
        self.context = object()
        self._default_scope = object()

    def close(self) -> None:
        return None


class _FakeTools:
    def __init__(self) -> None:
        self.call = AsyncMock(return_value={"ok": True})


class _FakeScope:
    def __init__(self) -> None:
        self.tools = _FakeTools()


class _FakeClientWithTools:
    captured_kwargs: dict = {}

    def __init__(self, **kwargs):
        _FakeClientWithTools.captured_kwargs = dict(kwargs)
        self.context = object()
        self._default_scope = _FakeScope()

    def close(self) -> None:
        return None


def test_sdk_bridge_uses_environment_defaults(monkeypatch) -> None:
    monkeypatch.setattr(sdk_bridge, "CaracalClient", _FakeClient)
    monkeypatch.setenv("CARACAL_API_KEY", "env-api-key")
    monkeypatch.setenv("CARACAL_API_PORT", "9010")
    monkeypatch.delenv("CARACAL_API_URL", raising=False)

    bridge = sdk_bridge.SDKBridge()

    assert _FakeClient.captured_kwargs == {
        "api_key": "env-api-key",
        "base_url": "http://localhost:9010",
    }
    assert bridge.current_scope is None


def test_sdk_bridge_explicit_params_override_environment(monkeypatch) -> None:
    monkeypatch.setattr(sdk_bridge, "CaracalClient", _FakeClient)
    monkeypatch.setenv("CARACAL_API_KEY", "env-api-key")
    monkeypatch.setenv("CARACAL_API_URL", "http://env.example")

    bridge = sdk_bridge.SDKBridge(
        api_key="explicit-key",
        base_url="https://api.example",
    )

    assert _FakeClient.captured_kwargs == {
        "api_key": "explicit-key",
        "base_url": "https://api.example",
    }
    assert bridge.current_scope is None


@pytest.mark.asyncio
async def test_sdk_bridge_call_tool_uses_default_scope_tools_surface(monkeypatch) -> None:
    monkeypatch.setattr(sdk_bridge, "CaracalClient", _FakeClientWithTools)

    bridge = sdk_bridge.SDKBridge(api_key="explicit-key", base_url="https://api.example")

    result = await bridge.call_tool(
        tool_id="provider:demo:resource:jobs:action:run",
        tool_args={"job": "example"},
    )

    assert result == {"ok": True}
    called = bridge._client._default_scope.tools.call.call_args
    assert called is not None
    assert "mandate_id" not in (called.kwargs or {})


@pytest.mark.parametrize(
    "removed_name",
    ["list_principals", "create_mandate", "validate_mandate", "query_ledger"],
)
def test_sdk_bridge_has_no_removed_legacy_wrappers(removed_name: str, monkeypatch) -> None:
    monkeypatch.setattr(sdk_bridge, "CaracalClient", _FakeClient)
    bridge = sdk_bridge.SDKBridge(api_key="explicit-key", base_url="https://api.example")

    with pytest.raises(AttributeError):
        getattr(bridge, removed_name)
