"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

JSON-RPC 2.0 MCP handler exposing each MCP provider's operations as typed tools and read-only resources.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from _mock.providerlab import catalog
from _mock.providerlab.providers import base

PROTOCOL_VERSION = "2025-06-18"

_SERVER_INSTRUCTIONS = {
    "atlas-vendor": (
        "Atlas Vendor Network exposes vendor master data, onboarding, verification, "
        "compliance, and contracts. Discover vendors with search_vendors or list_vendors and "
        "browse the commodity taxonomy with list_categories. Open and progress onboarding with "
        "register_vendor, get_onboarding_status, and advance_onboarding; maintain master data "
        "with update_vendor_profile and add_vendor_contact. Verify banking with "
        "verify_vendor_banking, (re)screen sanctions/KYB with run_compliance_screening, and gate "
        "payments on get_compliance_status. Review uploaded documents with review_vendor_document "
        "and audit any record with list_vendor_events. Single vendors are also addressable as "
        "resources at atlas://vendors/{vendorId}. Vendor identifiers look like VEND-00042."
    ),
    "relay-automation": (
        "Relay Automation runs finance-operations workflows as asynchronous, long-running "
        "jobs. Discover automations with list_workflows and get_workflow, then dispatch one "
        "with start_execution (pass an idempotencyKey to de-duplicate retries). Executions "
        "are asynchronous: poll get_execution to advance a run, and read its disposition "
        "with get_execution_logs and get_execution_result. Control a run with "
        "signal_execution (approve/reject an approval gate), retry_execution, "
        "pause_execution/resume_execution, and cancel_execution. Inspect backpressure with "
        "list_queues and get_queue, and prove provenance with get_execution_audit, which "
        "returns the hash-chained trail bound to the mandate subject and delegation lineage "
        "that triggered the run. Execution identifiers look like exec_3f2a1b9c4d5e."
    ),
}


def _tools(provider: catalog.Provider) -> list[dict]:
    """Advertise each provider operation as an MCP tool with its registered schema."""
    specs = base.TOOLSPECS.get(provider.id, {})
    tools = []
    for op in provider.operations:
        spec = specs.get(op)
        if spec is None:
            tools.append(
                {
                    "name": op,
                    "description": f"{provider.brand} operation {op}",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            )
        else:
            tools.append(dict(spec))
    return tools


def _resources(provider: catalog.Provider) -> list[dict]:
    return [dict(r) for r in base.RESOURCES.get(provider.id, [])]


def _resource_templates(provider: catalog.Provider) -> list[dict]:
    return [dict(t) for t in base.RESOURCE_TEMPLATES.get(provider.id, [])]


def _match_template(
    uri: str, provider: catalog.Provider
) -> tuple[str, dict, dict] | None:
    """Resolve a concrete resource URI against the provider's templates.

    Returns the template key, the extracted path variables, and the template
    descriptor, or None when no template matches."""
    for tmpl in base.RESOURCE_TEMPLATES.get(provider.id, []):
        key = tmpl["uriTemplate"]
        names = re.findall(r"\{(\w+)\}", key)
        pattern = "^" + re.sub(r"\\\{\w+\\\}", "([^/]+)", re.escape(key)) + "$"
        m = re.match(pattern, uri)
        if m:
            return key, dict(zip(names, m.groups())), tmpl
    return None


def _content(data: Any) -> dict:
    """Return a tool result with both serialized text and structured content."""
    return {
        "content": [{"type": "text", "text": json.dumps(data, default=str)}],
        "structuredContent": data,
        "isError": False,
    }


def _tool_error(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def handle(
    provider: catalog.Provider,
    message: dict,
    principal: dict,
    tool_runner: Callable[[str, dict], dict],
) -> dict | None:
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
        if base.RESOURCES.get(provider.id) or base.RESOURCE_TEMPLATES.get(provider.id):
            capabilities["resources"] = {"listChanged": False, "subscribe": False}
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {
                "name": provider.id,
                "title": provider.brand,
                "version": "1.4.0",
            },
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

    if method == "resources/templates/list":
        return ok({"resourceTemplates": _resource_templates(provider)})

    if method == "resources/read":
        uri = params.get("uri")
        known = {r["uri"]: r for r in base.RESOURCES.get(provider.id, [])}
        if uri in known:
            try:
                data = tool_runner(uri, {})
            except base.DomainError as exc:
                return err(exc.status, f"{exc.code}: {exc.message}")
            return ok(
                {
                    "contents": [
                        {
                            "uri": uri,
                            "mimeType": known[uri]["mimeType"],
                            "text": json.dumps(data, default=str),
                        }
                    ]
                }
            )
        matched = _match_template(uri, provider)
        if matched is None:
            return err(-32602, f"unknown resource: {uri}")
        key, variables, tmpl = matched
        try:
            data = tool_runner(key, variables)
        except base.DomainError as exc:
            return err(exc.status, f"{exc.code}: {exc.message}")
        return ok(
            {
                "contents": [
                    {
                        "uri": uri,
                        "mimeType": tmpl["mimeType"],
                        "text": json.dumps(data, default=str),
                    }
                ]
            }
        )

    return err(-32601, f"unknown method: {method}")
