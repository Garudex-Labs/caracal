"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

JSON-RPC 2.0 MCP handler exposing each MCP provider's operations as typed tools and read-only resources.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from _mock.providerlab import catalog
from _mock.providerlab.providers import base

PROTOCOL_VERSION = "2025-06-18"

_SERVER_INSTRUCTIONS = {
    "atlas-vendor": (
        "Atlas Vendor Network exposes vendor master data, onboarding, verification, "
        "compliance, and contracts. Discover vendors with search_vendors or list_vendors, "
        "open and progress onboarding with register_vendor, get_onboarding_status, and "
        "advance_onboarding, verify banking with verify_vendor_banking, and gate payments "
        "on get_compliance_status. Vendor identifiers look like VEND-00042."
    ),
}


def _tools(provider: catalog.Provider) -> list[dict]:
    """Advertise each provider operation as an MCP tool with its registered schema."""
    specs = base.TOOLSPECS.get(provider.id, {})
    tools = []
    for op in provider.operations:
        spec = specs.get(op)
        if spec is None:
            tools.append({
                "name": op,
                "description": f"{provider.brand} operation {op}",
                "inputSchema": {"type": "object", "properties": {}},
            })
        else:
            tools.append(dict(spec))
    return tools


def _resources(provider: catalog.Provider) -> list[dict]:
    return [dict(r) for r in base.RESOURCES.get(provider.id, [])]


def _content(data: Any) -> dict:
    """Return a tool result with both serialized text and structured content."""
    return {
        "content": [{"type": "text", "text": json.dumps(data, default=str)}],
        "structuredContent": data,
        "isError": False,
    }


def _tool_error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def handle(provider: catalog.Provider, message: dict, principal: dict,
           tool_runner: Callable[[str, dict], dict]) -> dict | None:
    """Dispatch a single JSON-RPC message and return the response envelope.

    Returns None for notifications, which carry no response under JSON-RPC."""
    rpc_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    def ok(result: Any) -> dict:
        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}

    def err(code: int, msg: str) -> dict:
        return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": msg}}

    if method == "initialize":
        capabilities: dict = {"tools": {"listChanged": False}}
        if base.RESOURCES.get(provider.id):
            capabilities["resources"] = {"listChanged": False, "subscribe": False}
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {"name": provider.id, "title": provider.brand, "version": "1.4.0"},
            "capabilities": capabilities,
        }
        instructions = _SERVER_INSTRUCTIONS.get(provider.id)
        if instructions:
            result["instructions"] = instructions
        return ok(result)

    if method is not None and method.startswith("notifications/"):
        return None

    if method == "ping":
        return ok({})

    if method == "tools/list":
        return ok({"tools": _tools(provider)})

    if method == "tools/call":
        name = params.get("name")
        if name not in provider.operations:
            return err(-32602, f"unknown tool: {name}")
        arguments = params.get("arguments") or {}
        try:
            data = tool_runner(name, arguments)
        except base.DomainError as exc:
            return ok(_tool_error(f"{exc.code}: {exc.message}"))
        return ok(_content(data))

    if method == "resources/list":
        return ok({"resources": _resources(provider)})

    if method == "resources/read":
        uri = params.get("uri")
        known = {r["uri"]: r for r in base.RESOURCES.get(provider.id, [])}
        if uri not in known:
            return err(-32602, f"unknown resource: {uri}")
        try:
            data = tool_runner(uri, {})
        except base.DomainError as exc:
            return err(exc.status, f"{exc.code}: {exc.message}")
        return ok({"contents": [{
            "uri": uri, "mimeType": known[uri]["mimeType"],
            "text": json.dumps(data, default=str)}]})

    return err(-32601, f"unknown method: {method}")
